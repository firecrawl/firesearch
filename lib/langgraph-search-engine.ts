import {
  StateGraph,
  END,
  START,
  Annotation,
  MemorySaver,
} from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { FirecrawlClient } from "./firecrawl";
import { ContextProcessor } from "./context-processor";
import { SEARCH_CONFIG, MODEL_CONFIG } from "./config";

// Event types remain the same for frontend compatibility
export type SearchPhase =
  | "understanding"
  | "planning"
  | "searching"
  | "analyzing"
  | "synthesizing"
  | "complete"
  | "error";

export type SearchEvent =
  | { type: "phase-update"; phase: SearchPhase; message: string }
  | { type: "thinking"; message: string }
  | { type: "searching"; query: string; index: number; total: number }
  | { type: "found"; sources: Source[]; query: string }
  | {
      type: "scraping";
      url: string;
      index: number;
      total: number;
      query: string;
    }
  | { type: "content-chunk"; chunk: string }
  | {
      type: "final-result";
      content: string;
      sources: Source[];
      followUpQuestions?: string[];
    }
  | { type: "error"; error: string; errorType?: ErrorType }
  | {
      type: "source-processing";
      url: string;
      title: string;
      stage: "browsing" | "extracting" | "analyzing";
    }
  | { type: "source-complete"; url: string; summary: string };

export type ErrorType = "search" | "scrape" | "llm" | "unknown";

export interface Source {
  url: string;
  title: string;
  content?: string;
  quality?: number;
  summary?: string;
}

export interface SearchResult {
  url: string;
  title: string;
  content?: string;
  markdown?: string;
}

export interface SearchStep {
  id: SearchPhase | string;
  label: string;
  status: "pending" | "active" | "completed";
  startTime?: number;
}

// Proper LangGraph state using Annotation with reducers
const SearchStateAnnotation = Annotation.Root({
  // Input fields
  query: Annotation<string>({
    reducer: (_, y) => y ?? "",
    default: () => "",
  }),
  context: Annotation<{ query: string; response: string }[] | undefined>({
    reducer: (_, y) => y,
    default: () => undefined,
  }),

  // Process fields
  understanding: Annotation<string | undefined>({
    reducer: (x, y) => y ?? x,
    default: () => undefined,
  }),
  searchQueries: Annotation<string[] | undefined>({
    reducer: (x, y) => y ?? x,
    default: () => undefined,
  }),
  currentSearchIndex: Annotation<number>({
    reducer: (x, y) => y ?? x,
    default: () => 0,
  }),

  // Results fields - with proper array reducers
  sources: Annotation<Source[]>({
    reducer: (existing: Source[], update: Source[] | undefined) => {
      if (!update) return existing;
      // Deduplicate sources by URL
      const sourceMap = new Map<string, Source>();
      [...existing, ...update].forEach((source) => {
        sourceMap.set(source.url, source);
      });
      return Array.from(sourceMap.values());
    },
    default: () => [],
  }),
  scrapedSources: Annotation<Source[]>({
    reducer: (existing: Source[], update: Source[] | undefined) => {
      if (!update) return existing;
      return [...existing, ...update];
    },
    default: () => [],
  }),
  processedSources: Annotation<Source[] | undefined>({
    reducer: (x, y) => y ?? x,
    default: () => undefined,
  }),
  finalAnswer: Annotation<string | undefined>({
    reducer: (x, y) => y ?? x,
    default: () => undefined,
  }),
  followUpQuestions: Annotation<string[] | undefined>({
    reducer: (x, y) => y ?? x,
    default: () => undefined,
  }),

  // Answer tracking
  subQueries: Annotation<
    | Array<{
        question: string;
        searchQuery: string;
        answered: boolean;
        answer?: string;
        confidence: number;
        sources: string[];
      }>
    | undefined
  >({
    reducer: (x, y) => y ?? x,
    default: () => undefined,
  }),
  searchAttempt: Annotation<number>({
    reducer: (x, y) => y ?? x,
    default: () => 0,
  }),

  // Control fields
  phase: Annotation<SearchPhase>({
    reducer: (x, y) => y ?? x,
    default: () => "understanding" as SearchPhase,
  }),
  error: Annotation<string | undefined>({
    reducer: (x, y) => y ?? x,
    default: () => undefined,
  }),
  errorType: Annotation<ErrorType | undefined>({
    reducer: (x, y) => y ?? x,
    default: () => undefined,
  }),
  maxRetries: Annotation<number>({
    reducer: (x, y) => y ?? x,
    default: () => SEARCH_CONFIG.MAX_RETRIES,
  }),
  retryCount: Annotation<number>({
    reducer: (x, y) => y ?? x,
    default: () => 0,
  }),
});

type SearchState = typeof SearchStateAnnotation.State;

// Define config type for proper event handling
interface GraphConfig {
  configurable?: {
    eventCallback?: (event: SearchEvent) => void;
    checkpointId?: string;
  };
}

export class LangGraphSearchEngine {
  private firecrawl: FirecrawlClient;
  private contextProcessor: ContextProcessor;
  private graph: ReturnType<typeof this.buildGraph>;
  private llm: ChatOpenAI;
  private streamingLlm: ChatOpenAI;
  private checkpointer?: MemorySaver;

  constructor(
    firecrawl: FirecrawlClient,
    options?: { enableCheckpointing?: boolean }
  ) {
    this.firecrawl = firecrawl;
    this.contextProcessor = new ContextProcessor();

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY environment variable is not set");
    }

    // Initialize LangChain models
    this.llm = new ChatOpenAI({
      modelName: MODEL_CONFIG.FAST_MODEL,
      temperature: MODEL_CONFIG.TEMPERATURE,
      openAIApiKey: apiKey,
    });

    this.streamingLlm = new ChatOpenAI({
      modelName: MODEL_CONFIG.QUALITY_MODEL,
      temperature: MODEL_CONFIG.TEMPERATURE,
      streaming: true,
      openAIApiKey: apiKey,
    });

    // Enable checkpointing if requested
    if (options?.enableCheckpointing) {
      this.checkpointer = new MemorySaver();
    }

    this.graph = this.buildGraph();
  }

  getInitialSteps(): SearchStep[] {
    return [
      {
        id: "understanding",
        label: "Understanding request",
        status: "pending",
      },
      { id: "planning", label: "Planning search", status: "pending" },
      { id: "searching", label: "Searching sources", status: "pending" },
      { id: "analyzing", label: "Analyzing content", status: "pending" },
      { id: "synthesizing", label: "Synthesizing answer", status: "pending" },
      { id: "complete", label: "Complete", status: "pending" },
    ];
  }

  private buildGraph() {
    // Create closures for helper methods
    const analyzeQuery = this.analyzeQuery.bind(this);
    const scoreContent = this.scoreContent.bind(this);
    const summarizeContent = this.summarizeContent.bind(this);
    const generateStreamingAnswer = this.generateStreamingAnswer.bind(this);
    const generateFollowUpQuestions = this.generateFollowUpQuestions.bind(this);
    const firecrawl = this.firecrawl;
    const contextProcessor = this.contextProcessor;

    const workflow = new StateGraph(SearchStateAnnotation)
      // Understanding node
      .addNode(
        "understand",
        async (
          state: SearchState,
          config?: GraphConfig
        ): Promise<Partial<SearchState>> => {
          const eventCallback = config?.configurable?.eventCallback;

          if (eventCallback) {
            eventCallback({
              type: "phase-update",
              phase: "understanding",
              message: "Analyzing your request...",
            });
          }

          try {
            const understanding = await analyzeQuery(
              state.query,
              state.context
            );

            if (eventCallback) {
              eventCallback({
                type: "thinking",
                message: understanding,
              });
            }

            return {
              understanding,
              phase: "planning" as SearchPhase,
            };
          } catch (error) {
            return {
              error:
                error instanceof Error
                  ? error.message
                  : "Failed to understand query",
              errorType: "llm" as ErrorType,
              phase: "error" as SearchPhase,
            };
          }
        }
      )

      // Planning node
      .addNode(
        "plan",
        async (
          state: SearchState,
          config?: GraphConfig
        ): Promise<Partial<SearchState>> => {
          const eventCallback = config?.configurable?.eventCallback;

          if (eventCallback) {
            eventCallback({
              type: "phase-update",
              phase: "planning",
              message: "Planning search strategy...",
            });
          }

          try {
            // Extract sub-queries if not already done
            let subQueries = state.subQueries;
            if (!subQueries) {
              const extractSubQueries = this.extractSubQueries.bind(this);
              const extracted = await extractSubQueries(state.query);
              subQueries = extracted.map((sq) => ({
                question: sq.question,
                searchQuery: sq.searchQuery,
                answered: false,
                confidence: 0,
                sources: [],
              }));
            }

            // Generate search queries for unanswered questions
            const unansweredQueries = subQueries.filter(
              (sq) =>
                !sq.answered ||
                sq.confidence < SEARCH_CONFIG.MIN_ANSWER_CONFIDENCE
            );

            if (unansweredQueries.length === 0) {
              // All questions answered, skip to analysis
              return {
                subQueries,
                phase: "analyzing" as SearchPhase,
              };
            }

            // Use alternative search queries if this is a retry
            let searchQueries: string[];
            if (state.searchAttempt > 0) {
              const generateAlternativeSearchQueries =
                this.generateAlternativeSearchQueries.bind(this);
              searchQueries = await generateAlternativeSearchQueries(
                subQueries,
                state.searchAttempt
              );

              // Update sub-queries with new search queries
              let alternativeIndex = 0;
              subQueries.forEach((sq) => {
                if (
                  !sq.answered ||
                  sq.confidence < SEARCH_CONFIG.MIN_ANSWER_CONFIDENCE
                ) {
                  if (alternativeIndex < searchQueries.length) {
                    sq.searchQuery = searchQueries[alternativeIndex];
                    alternativeIndex++;
                  }
                }
              });
            } else {
              // First attempt - use the search queries from sub-queries
              searchQueries = unansweredQueries.map((sq) => sq.searchQuery);
            }

            if (eventCallback) {
              if (state.searchAttempt === 0) {
                eventCallback({
                  type: "thinking",
                  message:
                    searchQueries.length > 3
                      ? `I detected ${subQueries.length} different questions. I'll search for each one separately.`
                      : `I'll search for information to answer your question.`,
                });
              } else {
                eventCallback({
                  type: "thinking",
                  message: `Trying alternative search strategies for: ${unansweredQueries
                    .map((sq) => sq.question)
                    .join(", ")}`,
                });
              }
            }

            return {
              searchQueries,
              subQueries,
              currentSearchIndex: 0,
              phase: "searching" as SearchPhase,
            };
          } catch (error) {
            return {
              error:
                error instanceof Error
                  ? error.message
                  : "Failed to plan search",
              errorType: "llm" as ErrorType,
              phase: "error" as SearchPhase,
            };
          }
        }
      )

      // Search node (handles one search at a time)
      .addNode(
        "search",
        async (
          state: SearchState,
          config?: GraphConfig
        ): Promise<Partial<SearchState>> => {
          const eventCallback = config?.configurable?.eventCallback;
          const searchQueries = state.searchQueries || [];
          const currentIndex = state.currentSearchIndex || 0;

          if (currentIndex === 0 && eventCallback) {
            eventCallback({
              type: "phase-update",
              phase: "searching",
              message: "Searching the web...",
            });
          }

          if (currentIndex >= searchQueries.length) {
            return {
              phase: "scrape" as SearchPhase,
            };
          }

          const searchQuery = searchQueries[currentIndex];

          if (eventCallback) {
            eventCallback({
              type: "searching",
              query: searchQuery,
              index: currentIndex + 1,
              total: searchQueries.length,
            });
          }

          try {
            const results = await firecrawl.search(searchQuery, {
              limit: SEARCH_CONFIG.MAX_SOURCES_PER_SEARCH,
              scrapeOptions: {
                formats: ["markdown"],
              },
            });

            const newSources: Source[] = results.data.map(
              (r: SearchResult) => ({
                url: r.url,
                title: r.title,
                content: r.markdown || r.content || "",
                quality: 0,
              })
            );

            if (eventCallback) {
              eventCallback({
                type: "found",
                sources: newSources,
                query: searchQuery,
              });
            }

            // Process sources in parallel for better performance
            if (SEARCH_CONFIG.PARALLEL_SUMMARY_GENERATION) {
              await Promise.all(
                newSources.map(async (source) => {
                  if (eventCallback) {
                    eventCallback({
                      type: "source-processing",
                      url: source.url,
                      title: source.title,
                      stage: "browsing",
                    });
                  }

                  // Score the content
                  source.quality = scoreContent(
                    source.content || "",
                    state.query
                  );

                  // Generate summary if content is available
                  if (
                    source.content &&
                    source.content.length > SEARCH_CONFIG.MIN_CONTENT_LENGTH
                  ) {
                    const summary = await summarizeContent(
                      source.content,
                      searchQuery
                    );

                    // Store the summary in the source object
                    if (
                      summary &&
                      !summary.toLowerCase().includes("no specific")
                    ) {
                      source.summary = summary;

                      if (eventCallback) {
                        eventCallback({
                          type: "source-complete",
                          url: source.url,
                          summary: summary,
                        });
                      }
                    }
                  }
                })
              );
            } else {
              // Original sequential processing
              for (const source of newSources) {
                if (eventCallback) {
                  eventCallback({
                    type: "source-processing",
                    url: source.url,
                    title: source.title,
                    stage: "browsing",
                  });
                }

                // Small delay for animation
                await new Promise((resolve) =>
                  setTimeout(resolve, SEARCH_CONFIG.SOURCE_ANIMATION_DELAY)
                );

                // Score the content
                source.quality = scoreContent(
                  source.content || "",
                  state.query
                );

                // Generate summary if content is available
                if (
                  source.content &&
                  source.content.length > SEARCH_CONFIG.MIN_CONTENT_LENGTH
                ) {
                  const summary = await summarizeContent(
                    source.content,
                    searchQuery
                  );

                  // Store the summary in the source object
                  if (
                    summary &&
                    !summary.toLowerCase().includes("no specific")
                  ) {
                    source.summary = summary;

                    if (eventCallback) {
                      eventCallback({
                        type: "source-complete",
                        url: source.url,
                        summary: summary,
                      });
                    }
                  }
                }
              }
            }

            return {
              sources: newSources,
              currentSearchIndex: currentIndex + 1,
            };
          } catch {
            return {
              currentSearchIndex: currentIndex + 1,
              errorType: "search" as ErrorType,
            };
          }
        }
      )

      // Scraping node
      .addNode(
        "scrape",
        async (
          state: SearchState,
          config?: GraphConfig
        ): Promise<Partial<SearchState>> => {
          const eventCallback = config?.configurable?.eventCallback;
          const sourcesToScrape =
            state.sources?.filter(
              (s) =>
                !s.content ||
                s.content.length < SEARCH_CONFIG.MIN_CONTENT_LENGTH
            ) || [];
          const newScrapedSources: Source[] = [];

          // Sources with content were already processed in search node, just pass them through
          const sourcesWithContent =
            state.sources?.filter(
              (s) =>
                s.content &&
                s.content.length >= SEARCH_CONFIG.MIN_CONTENT_LENGTH
            ) || [];
          newScrapedSources.push(...sourcesWithContent);

          // Then scrape sources without content
          for (
            let i = 0;
            i <
            Math.min(
              sourcesToScrape.length,
              SEARCH_CONFIG.MAX_SOURCES_TO_SCRAPE
            );
            i++
          ) {
            const source = sourcesToScrape[i];

            if (eventCallback) {
              eventCallback({
                type: "scraping",
                url: source.url,
                index: newScrapedSources.length + 1,
                total:
                  sourcesWithContent.length +
                  Math.min(
                    sourcesToScrape.length,
                    SEARCH_CONFIG.MAX_SOURCES_TO_SCRAPE
                  ),
                query: state.query,
              });
            }

            try {
              const scraped = await firecrawl.scrapeUrl(
                source.url,
                SEARCH_CONFIG.SCRAPE_TIMEOUT
              );
              if (scraped.success && scraped.markdown) {
                const enrichedSource = {
                  ...source,
                  content: scraped.markdown,
                  quality: scoreContent(scraped.markdown, state.query),
                };
                newScrapedSources.push(enrichedSource);

                // Show processing animation
                if (eventCallback) {
                  eventCallback({
                    type: "source-processing",
                    url: source.url,
                    title: source.title,
                    stage: "browsing",
                  });
                }

                await new Promise((resolve) => setTimeout(resolve, 150));

                const summary = await summarizeContent(
                  scraped.markdown,
                  state.query
                );
                if (summary) {
                  enrichedSource.summary = summary;

                  if (eventCallback) {
                    eventCallback({
                      type: "source-complete",
                      url: source.url,
                      summary: summary,
                    });
                  }
                }
              } else if (scraped.error === "timeout") {
                if (eventCallback) {
                  eventCallback({
                    type: "thinking",
                    message: `${
                      new URL(source.url).hostname
                    } is taking too long to respond, moving on...`,
                  });
                }
              }
            } catch {
              if (eventCallback) {
                eventCallback({
                  type: "thinking",
                  message: `Couldn't access ${
                    new URL(source.url).hostname
                  }, trying other sources...`,
                });
              }
            }
          }

          return {
            scrapedSources: newScrapedSources,
            phase: "analyzing" as SearchPhase,
          };
        }
      )

      // Analyzing node
      .addNode(
        "analyze",
        async (
          state: SearchState,
          config?: GraphConfig
        ): Promise<Partial<SearchState>> => {
          const eventCallback = config?.configurable?.eventCallback;

          if (eventCallback) {
            eventCallback({
              type: "phase-update",
              phase: "analyzing",
              message: "Analyzing gathered information...",
            });
          }

          // Combine sources and remove duplicates by URL
          const sourceMap = new Map<string, Source>();

          // Add all sources (not just those with long content, since summaries contain key info)
          (state.sources || []).forEach((s) => sourceMap.set(s.url, s));

          // Add scraped sources (may override with better content)
          (state.scrapedSources || []).forEach((s) => sourceMap.set(s.url, s));

          const allSources = Array.from(sourceMap.values());

          // Check which questions have been answered
          if (state.subQueries) {
            const checkAnswersInSources = this.checkAnswersInSources.bind(this);
            const updatedSubQueries = await checkAnswersInSources(
              state.subQueries,
              allSources
            );

            const answeredCount = updatedSubQueries.filter(
              (sq) => sq.answered
            ).length;
            const totalQuestions = updatedSubQueries.length;
            const searchAttempt = (state.searchAttempt || 0) + 1;

            // Check if we have partial answers with decent confidence
            const partialAnswers = updatedSubQueries.filter(
              (sq) => sq.confidence >= 0.3
            );
            const hasPartialInfo = partialAnswers.length > answeredCount;

            if (eventCallback) {
              if (answeredCount === totalQuestions) {
                eventCallback({
                  type: "thinking",
                  message: `Found answers to all ${totalQuestions} questions across ${allSources.length} sources`,
                });
              } else if (answeredCount > 0) {
                eventCallback({
                  type: "thinking",
                  message: `Found answers to ${answeredCount} of ${totalQuestions} questions. Still missing: ${updatedSubQueries
                    .filter((sq) => !sq.answered)
                    .map((sq) => sq.question)
                    .join(", ")}`,
                });
              } else if (searchAttempt >= SEARCH_CONFIG.MAX_SEARCH_ATTEMPTS) {
                // Only show "could not find" message when we've exhausted all attempts
                eventCallback({
                  type: "thinking",
                  message: `Could not find specific answers in ${allSources.length} sources. The information may not be publicly available.`,
                });
              } else if (hasPartialInfo && searchAttempt >= 3) {
                // If we have partial info and tried 3+ times, stop searching
                eventCallback({
                  type: "thinking",
                  message: `Found partial information. Moving forward with what's available.`,
                });
              } else {
                // For intermediate attempts, show a different message
                eventCallback({
                  type: "thinking",
                  message: `Searching for more specific information...`,
                });
              }
            }

            // If we haven't found all answers and haven't exceeded attempts, try again
            // BUT stop if we have partial info and already tried 2+ times
            if (
              answeredCount < totalQuestions &&
              searchAttempt < SEARCH_CONFIG.MAX_SEARCH_ATTEMPTS &&
              !(hasPartialInfo && searchAttempt >= 2)
            ) {
              return {
                sources: allSources,
                subQueries: updatedSubQueries,
                searchAttempt,
                phase: "planning" as SearchPhase, // Go back to planning for retry
              };
            }

            // Otherwise proceed with what we have
            try {
              const processedSources = await contextProcessor.processSources(
                state.query,
                allSources,
                state.searchQueries || []
              );

              return {
                sources: allSources,
                processedSources,
                subQueries: updatedSubQueries,
                searchAttempt,
                phase: "synthesizing" as SearchPhase,
              };
            } catch {
              return {
                sources: allSources,
                processedSources: allSources,
                subQueries: updatedSubQueries,
                searchAttempt,
                phase: "synthesizing" as SearchPhase,
              };
            }
          } else {
            // Fallback for queries without sub-queries
            if (eventCallback && allSources.length > 0) {
              eventCallback({
                type: "thinking",
                message: `Found ${allSources.length} sources with quality information`,
              });
            }

            try {
              const processedSources = await contextProcessor.processSources(
                state.query,
                allSources,
                state.searchQueries || []
              );

              return {
                sources: allSources,
                processedSources,
                phase: "synthesizing" as SearchPhase,
              };
            } catch {
              return {
                sources: allSources,
                processedSources: allSources,
                phase: "synthesizing" as SearchPhase,
              };
            }
          }
        }
      )

      // Synthesizing node with streaming
      .addNode(
        "synthesize",
        async (
          state: SearchState,
          config?: GraphConfig
        ): Promise<Partial<SearchState>> => {
          const eventCallback = config?.configurable?.eventCallback;

          if (eventCallback) {
            eventCallback({
              type: "phase-update",
              phase: "synthesizing",
              message: "Creating comprehensive answer...",
            });
          }

          try {
            const sourcesToUse = state.processedSources || state.sources || [];

            const answer = await generateStreamingAnswer(
              state.query,
              sourcesToUse,
              (chunk) => {
                if (eventCallback) {
                  eventCallback({ type: "content-chunk", chunk });
                }
              },
              state.context
            );

            // Generate follow-up questions
            const followUpQuestions = await generateFollowUpQuestions(
              state.query,
              answer,
              sourcesToUse,
              state.context
            );

            return {
              finalAnswer: answer,
              followUpQuestions,
              phase: "complete" as SearchPhase,
            };
          } catch (error) {
            return {
              error:
                error instanceof Error
                  ? error.message
                  : "Failed to generate answer",
              errorType: "llm" as ErrorType,
              phase: "error" as SearchPhase,
            };
          }
        }
      )

      // Error handling node
      .addNode(
        "handleError",
        async (
          state: SearchState,
          config?: GraphConfig
        ): Promise<Partial<SearchState>> => {
          const eventCallback = config?.configurable?.eventCallback;

          if (eventCallback) {
            eventCallback({
              type: "error",
              error: state.error || "An unknown error occurred",
              errorType: state.errorType,
            });
          }

          // Retry logic based on error type
          if (
            (state.retryCount || 0) <
            (state.maxRetries || SEARCH_CONFIG.MAX_RETRIES)
          ) {
            // Different retry strategies based on error type
            const retryPhase =
              state.errorType === "search" ? "searching" : "understanding";

            return {
              retryCount: (state.retryCount || 0) + 1,
              phase: retryPhase as SearchPhase,
              error: undefined,
              errorType: undefined,
            };
          }

          return {
            phase: "error" as SearchPhase,
          };
        }
      )

      // Complete node
      .addNode(
        "complete",
        async (
          state: SearchState,
          config?: GraphConfig
        ): Promise<Partial<SearchState>> => {
          const eventCallback = config?.configurable?.eventCallback;

          if (eventCallback) {
            eventCallback({
              type: "phase-update",
              phase: "complete",
              message: "Search complete!",
            });

            eventCallback({
              type: "final-result",
              content: state.finalAnswer || "",
              sources: state.sources || [],
              followUpQuestions: state.followUpQuestions,
            });
          }

          return {
            phase: "complete" as SearchPhase,
          };
        }
      );

    // Add edges with proper conditional routing
    workflow
      .addEdge(START, "understand")
      .addConditionalEdges(
        "understand",
        (state: SearchState) =>
          state.phase === "error" ? "handleError" : "plan",
        {
          handleError: "handleError",
          plan: "plan",
        }
      )
      .addConditionalEdges(
        "plan",
        (state: SearchState) =>
          state.phase === "error" ? "handleError" : "search",
        {
          handleError: "handleError",
          search: "search",
        }
      )
      .addConditionalEdges(
        "search",
        (state: SearchState) => {
          if (state.phase === "error") return "handleError";
          if (
            (state.currentSearchIndex || 0) < (state.searchQueries?.length || 0)
          ) {
            return "search"; // Continue searching
          }
          return "scrape"; // Move to scraping
        },
        {
          handleError: "handleError",
          search: "search",
          scrape: "scrape",
        }
      )
      .addConditionalEdges(
        "scrape",
        (state: SearchState) =>
          state.phase === "error" ? "handleError" : "analyze",
        {
          handleError: "handleError",
          analyze: "analyze",
        }
      )
      .addConditionalEdges(
        "analyze",
        (state: SearchState) => {
          if (state.phase === "error") return "handleError";
          if (state.phase === "planning") return "plan"; // Retry with new searches
          return "synthesize";
        },
        {
          handleError: "handleError",
          plan: "plan",
          synthesize: "synthesize",
        }
      )
      .addConditionalEdges(
        "synthesize",
        (state: SearchState) =>
          state.phase === "error" ? "handleError" : "complete",
        {
          handleError: "handleError",
          complete: "complete",
        }
      )
      .addConditionalEdges(
        "handleError",
        (state: SearchState) => (state.phase === "error" ? END : "understand"),
        {
          [END]: END,
          understand: "understand",
        }
      )
      .addEdge("complete", END);

    // Compile with optional checkpointing
    return workflow.compile(
      this.checkpointer ? { checkpointer: this.checkpointer } : undefined
    );
  }

  async search(
    query: string,
    onEvent: (event: SearchEvent) => void,
    context?: { query: string; response: string }[],
    checkpointId?: string
  ): Promise<void> {
    try {
      const initialState: SearchState = {
        query,
        context,
        sources: [],
        scrapedSources: [],
        processedSources: undefined,
        phase: "understanding",
        currentSearchIndex: 0,
        maxRetries: SEARCH_CONFIG.MAX_RETRIES,
        retryCount: 0,
        understanding: undefined,
        searchQueries: undefined,
        finalAnswer: undefined,
        followUpQuestions: undefined,
        error: undefined,
        errorType: undefined,
        subQueries: undefined,
        searchAttempt: 0,
      };

      // Configure with event callback
      const config: GraphConfig = {
        configurable: {
          eventCallback: onEvent,
          ...(checkpointId && this.checkpointer
            ? { thread_id: checkpointId }
            : {}),
        },
      };

      // Invoke the graph with increased recursion limit
      await this.graph.invoke(initialState, {
        ...config,
        recursionLimit: 35, // Increased from default 25 to handle MAX_SEARCH_ATTEMPTS=5
      });
    } catch (error) {
      onEvent({
        type: "error",
        error: error instanceof Error ? error.message : "Search failed",
        errorType: "unknown",
      });
    }
  }

  // Get current date for context
  private getCurrentDateContext(): string {
    const now = new Date();
    const dateStr = now.toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    const year = now.getFullYear();
    const month = now.getMonth() + 1;

    return `Today's date is ${dateStr}. The current year is ${year} and it's currently ${month}/${year}.`;
  }

  // Pure helper methods (no side effects)
  private async analyzeQuery(
    query: string,
    context?: { query: string; response: string }[]
  ): Promise<string> {
    let contextPrompt = "";
    if (context && context.length > 0) {
      contextPrompt = "\n\nPrevious conversation:\n";
      context.forEach((c) => {
        contextPrompt += `User: ${c.query}\nAssistant: ${c.response.substring(
          0,
          SEARCH_CONFIG.CONTEXT_PREVIEW_LENGTH
        )}...\n\n`;
      });
    }

    const messages = [
      new SystemMessage(`${this.getCurrentDateContext()}

You are a senior financial research analyst with 15+ years of experience in wealth management, investment analysis, and portfolio management. Analyze this financial query and explain what you understand the client is seeking.

Instructions:
- Start with a clear, professional title (e.g., "Analyzing ESG Investment Performance" or "Evaluating Fixed Income Risk Factors")
- Identify the specific financial context: market analysis, portfolio optimization, risk assessment, regulatory compliance, or client advisory
- Determine if this relates to: asset allocation, security selection, market timing, risk management, compliance, or client education
- If this builds on previous financial discussions, acknowledge the investment thesis or strategy context
- Mention that you'll conduct comprehensive financial research using authoritative sources (SEC filings, Bloomberg, Reuters, Morningstar, etc.)
- Only reference "latest" information if the query explicitly involves current market conditions, recent earnings, or regulatory updates

Maintain the analytical rigor and professional tone expected by institutional investors and high-net-worth advisors.`),
      new HumanMessage(`Query: "${query}"${contextPrompt}`),
    ];

    const response = await this.llm.invoke(messages);
    return response.content.toString();
  }

  private async checkAnswersInSources(
    subQueries: Array<{
      question: string;
      searchQuery: string;
      answered: boolean;
      answer?: string;
      confidence: number;
      sources: string[];
    }>,
    sources: Source[]
  ): Promise<typeof subQueries> {
    if (sources.length === 0) return subQueries;

    const messages = [
      new SystemMessage(`You are a senior financial analyst validating research findings against authoritative financial sources.

For each financial question, determine:
1. If the sources contain a direct, accurate answer
2. The confidence level (0.0-1.0) that the financial data is reliable and current
3. A precise answer summary with key financial metrics

Financial Validation Guidelines:
- For financial performance data: Require specific numbers, percentages, and time periods (0.9+ confidence)
- For market data: Require current prices, volumes, and market cap figures (0.8+ confidence)
- For regulatory information: Require official SEC filings, regulatory announcements (0.9+ confidence)
- For company fundamentals: Require audited financial statements or official investor relations data (0.8+ confidence)
- For investment strategies: Require peer-reviewed research or institutional analysis (0.7+ confidence)
- For risk metrics: Require quantitative data with methodology (0.8+ confidence)
- For compliance requirements: Require official regulatory guidance (0.9+ confidence)

Financial Data Quality Standards:
- Market data must be from recognized exchanges or financial data providers
- Company information must be from official filings (10-K, 10-Q, 8-K) or investor relations
- Performance data must include specific time periods and benchmarks
- Risk metrics must include calculation methodology
- Regulatory information must be from official government sources

Version/Date Matching for Financial Products:
- "Q3 2024" matches "Q3 2024", "3Q24", "September 2024", or "Q3'24"
- Fund versions like "Vanguard S&P 500 ETF VOO" match exact ticker symbols
- Share classes like "Class A", "Institutional", "Advisor" must be specified

Special Financial Cases:
- For fund performance: Require specific time periods and benchmark comparisons
- For risk metrics: Require confidence intervals and calculation methods
- For regulatory changes: Require effective dates and compliance requirements
- For market analysis: Require current market conditions and historical context

Return ONLY a JSON array with financial-grade accuracy:
[
  {
    "question": "original financial question",
    "answered": true/false,
    "confidence": 0.0-1.0,
    "answer": "precise financial answer with key metrics",
    "sources": ["authoritative financial sources"]
  }
]`),
      new HumanMessage(`Questions to check:
${subQueries.map((sq) => sq.question).join("\n")}

Sources:
${sources
  .slice(0, SEARCH_CONFIG.MAX_SOURCES_TO_CHECK)
  .map((s) => {
    let sourceInfo = `URL: ${s.url}\nTitle: ${s.title}\n`;

    // Include summary if available (this is the key insight from the search)
    if (s.summary) {
      sourceInfo += `Summary: ${s.summary}\n`;
    }

    // Include content preview
    if (s.content) {
      sourceInfo += `Content: ${s.content.slice(
        0,
        SEARCH_CONFIG.ANSWER_CHECK_PREVIEW
      )}\n`;
    }

    return sourceInfo;
  })
  .join("\n---\n")}`),
    ];

    try {
      const response = await this.llm.invoke(messages);
      let content = response.content.toString();

      // Strip markdown code blocks if present
      content = content
        .replace(/```json\s*/g, "")
        .replace(/```\s*$/g, "")
        .trim();

      const results = JSON.parse(content);

      // Update sub-queries with results
      return subQueries.map((sq) => {
        const result = results.find(
          (r: { question: string }) => r.question === sq.question
        );
        if (result && result.confidence > sq.confidence) {
          return {
            ...sq,
            answered: result.confidence >= SEARCH_CONFIG.MIN_ANSWER_CONFIDENCE,
            answer: result.answer,
            confidence: result.confidence,
            sources: [...new Set([...sq.sources, ...(result.sources || [])])],
          };
        }
        return sq;
      });
    } catch (error) {
      console.error("Error checking answers:", error);
      return subQueries;
    }
  }

  private async extractSubQueries(
    query: string
  ): Promise<Array<{ question: string; searchQuery: string }>> {
    const messages = [
      new SystemMessage(`You are a senior financial analyst breaking down complex investment research requests into specific, actionable analytical questions.

Extract individual financial analysis questions that can be definitively answered with quantitative data and authoritative sources.

IMPORTANT: 
- When analyzing financial products with specific identifiers (like "VOO Q3 2024"), include the FULL specification
- For search queries, use precise financial terminology and ticker symbols
- Example: "VOO Q3 2024 performance" → question: "What was Vanguard S&P 500 ETF (VOO) Q3 2024 performance?", searchQuery: "VOO Vanguard S&P 500 ETF Q3 2024 performance returns"

Financial Analysis Examples:
"Analyze Apple's Q3 2024 earnings and compare to Microsoft" → 
[
  {"question": "What were Apple's Q3 2024 earnings per share and revenue?", "searchQuery": "Apple AAPL Q3 2024 earnings revenue EPS"},
  {"question": "What were Microsoft's Q3 2024 earnings per share and revenue?", "searchQuery": "Microsoft MSFT Q3 2024 earnings revenue EPS"},
  {"question": "How do Apple and Microsoft Q3 2024 earnings compare?", "searchQuery": "Apple vs Microsoft Q3 2024 earnings comparison"}
]

"Evaluate ESG investment strategies and their risk-adjusted returns" →
[
  {"question": "What are the top-performing ESG investment strategies in 2024?", "searchQuery": "ESG investment strategies 2024 performance returns"},
  {"question": "What are the risk-adjusted returns of ESG funds vs traditional funds?", "searchQuery": "ESG funds risk-adjusted returns Sharpe ratio vs traditional funds"},
  {"question": "What are the key ESG risk factors and how are they measured?", "searchQuery": "ESG risk factors measurement methodology"}
]

"Research fixed income opportunities in current rate environment" →
[
  {"question": "What are the current interest rate trends and Fed policy outlook?", "searchQuery": "Federal Reserve interest rates 2024 policy outlook"},
  {"question": "What are the best fixed income investment opportunities in current rate environment?", "searchQuery": "fixed income investment opportunities 2024 high interest rates"},
  {"question": "What are the duration and credit risk considerations for fixed income?", "searchQuery": "fixed income duration credit risk analysis 2024"}
]

"Compare robo-advisor platforms for portfolio management" →
[
  {"question": "What are the top robo-advisor platforms and their fee structures?", "searchQuery": "robo-advisor platforms comparison fees 2024"},
  {"question": "How do robo-advisor investment strategies and performance compare?", "searchQuery": "robo-advisor investment strategies performance comparison"},
  {"question": "What are the regulatory and compliance requirements for robo-advisors?", "searchQuery": "robo-advisor regulatory compliance requirements"}
]

Financial Analysis Focus:
- Break down complex investment questions into specific analytical components
- Include quantitative metrics, time periods, and benchmarks
- Consider both fundamental and technical analysis aspects
- Address risk, return, and regulatory dimensions
- Keep sub-queries focused on actionable financial insights (3-5 max)

Return ONLY a JSON array of {question, searchQuery} objects with financial precision.`),
      new HumanMessage(`Query: "${query}"`),
    ];

    try {
      const response = await this.llm.invoke(messages);
      return JSON.parse(response.content.toString());
    } catch {
      // Fallback: treat as single query
      return [{ question: query, searchQuery: query }];
    }
  }

  // This method was removed as it's not used in the current implementation
  // Search queries are now generated from sub-queries in the plan node

  private async generateAlternativeSearchQueries(
    subQueries: Array<{
      question: string;
      searchQuery: string;
      answered: boolean;
      answer?: string;
      confidence: number;
      sources: string[];
    }>,
    previousAttempts: number
  ): Promise<string[]> {
    const unansweredQueries = subQueries.filter(
      (sq) =>
        !sq.answered || sq.confidence < SEARCH_CONFIG.MIN_ANSWER_CONFIDENCE
    );

    // If we're on attempt 3 and still searching for the same thing, just give up on that specific query
    if (previousAttempts >= 2) {
      const problematicQueries = unansweredQueries.filter((sq) => {
        // Check if the question contains a version number or specific identifier that might not exist
        const hasVersionPattern =
          /\b\d{3,4}\b|\bv\d+\.\d+|\bversion\s+\d+/i.test(sq.question);
        const hasFailedMultipleTimes = previousAttempts >= 2;
        return hasVersionPattern && hasFailedMultipleTimes;
      });

      if (problematicQueries.length > 0) {
        // Return generic searches that might find partial info
        return problematicQueries.map((sq) => {
          const baseTerm = sq.question
            .replace(/0528|specific version/gi, "")
            .trim();
          return baseTerm.substring(0, 50); // Keep it short
        });
      }
    }

    const messages = [
      new SystemMessage(`${this.getCurrentDateContext()}

You are a senior financial research analyst generating alternative search strategies for unanswered financial questions.

Previous research attempts: ${previousAttempts}
Previous queries that didn't find sufficient financial data:
${unansweredQueries
  .map(
    (sq) =>
      `- Question: "${sq.question}"\n  Previous search: "${sq.searchQuery}"`
  )
  .join("\n")}

IMPORTANT: For financial products with specific versions/dates that aren't found, try broader market or sector searches.

Generate ALTERNATIVE financial research queries using these strategies:
1. Broader market/sector analysis instead of specific securities
2. Alternative financial data sources (Bloomberg, Reuters, Morningstar, SEC EDGAR)
3. Different time periods or market cycles
4. Related financial instruments or derivatives
5. Regulatory or compliance perspectives
6. Academic research or institutional analysis
7. International market comparisons

Financial Research Examples:
- Original: "Tesla Q3 2024 earnings" → Alternative: "Tesla TSLA quarterly earnings 2024 financial results"
- Original: "Bitcoin ETF performance" → Alternative: "cryptocurrency ETF performance 2024 digital asset funds"
- Original: "ESG fund returns" → Alternative: "sustainable investing performance environmental social governance funds"
- Original: "Fed rate cuts impact" → Alternative: "Federal Reserve monetary policy impact bond markets equity markets"

Financial Data Source Strategies:
- SEC filings: "10-K 10-Q earnings" for company data
- Market data: "Bloomberg Reuters" for real-time prices
- Research: "Morningstar S&P Global" for analysis
- Regulatory: "SEC FINRA" for compliance
- Academic: "NBER SSRN" for research papers

Return one alternative financial research query per unanswered question, one per line.`),
      new HumanMessage(
        `Generate alternative searches for these ${unansweredQueries.length} unanswered questions.`
      ),
    ];

    try {
      const response = await this.llm.invoke(messages);
      const result = response.content.toString();

      const queries = result
        .split("\n")
        .map((q) => q.trim())
        .map((q) => q.replace(/^["']|["']$/g, ""))
        .map((q) => q.replace(/^\d+\.\s*/, ""))
        .map((q) => q.replace(/^[-*#]\s*/, ""))
        .filter((q) => q.length > 0)
        .filter((q) => !q.match(/^```/))
        .filter((q) => q.length > 3);

      return queries.slice(0, SEARCH_CONFIG.MAX_SEARCH_QUERIES);
    } catch {
      // Fallback: return original queries with slight modifications
      return unansweredQueries
        .map((sq) => sq.searchQuery + " news reports")
        .slice(0, SEARCH_CONFIG.MAX_SEARCH_QUERIES);
    }
  }

  private scoreContent(content: string, query: string): number {
    const queryWords = query.toLowerCase().split(" ");
    const contentLower = content.toLowerCase();

    let score = 0;
    for (const word of queryWords) {
      if (contentLower.includes(word)) score += 0.2;
    }

    return Math.min(score, 1);
  }

  private async summarizeContent(
    content: string,
    query: string
  ): Promise<string> {
    try {
      const messages = [
        new SystemMessage(`${this.getCurrentDateContext()}

You are a senior financial analyst extracting the most relevant financial information from research sources.

Extract ONE key financial finding that's SPECIFICALLY relevant to the investment research query.

CRITICAL: Only summarize information that directly relates to the financial question and search queries.
- If researching "Apple earnings", only mention Apple's financial performance data
- If analyzing "ESG funds", only mention ESG investment performance and metrics
- If studying "market volatility", only mention volatility measures and risk factors

Financial Analysis Instructions:
- Return ONE sentence with specific financial data, metrics, or insights
- Include precise numbers, percentages, time periods, and benchmarks
- Focus on quantitative measures: returns, ratios, volatility, correlation
- Highlight regulatory, compliance, or risk management implications
- Keep under ${SEARCH_CONFIG.SUMMARY_CHAR_LIMIT} characters
- Use professional financial terminology
- Don't say "No relevant information found" - extract the most relevant financial insight

Financial Metrics to Prioritize:
- Performance: Returns, Sharpe ratios, alpha, beta
- Risk: Volatility, VaR, maximum drawdown, correlation
- Valuation: P/E, P/B, EV/EBITDA, DCF
- Fundamentals: Revenue, earnings, margins, growth rates
- Market: Price, volume, market cap, trading patterns`),
        new HumanMessage(
          `Query: "${query}"\n\nContent: ${content.slice(0, 2000)}`
        ),
      ];

      const response = await this.llm.invoke(messages);
      return response.content.toString().trim();
    } catch {
      return "";
    }
  }

  private async generateStreamingAnswer(
    query: string,
    sources: Source[],
    onChunk: (chunk: string) => void,
    context?: { query: string; response: string }[]
  ): Promise<string> {
    const sourcesText = sources
      .map((s, i) => {
        if (!s.content) return `[${i + 1}] ${s.title}\n[No content available]`;
        return `[${i + 1}] ${s.title}\n${s.content}`;
      })
      .join("\n\n");

    let contextPrompt = "";
    if (context && context.length > 0) {
      contextPrompt = "\n\nPrevious conversation for context:\n";
      context.forEach((c) => {
        contextPrompt += `User: ${c.query}\nAssistant: ${c.response.substring(
          0,
          300
        )}...\n\n`;
      });
    }

    const messages = [
      new SystemMessage(`${this.getCurrentDateContext()}

You are a senior financial analyst preparing a comprehensive investment research report for institutional clients and wealth management professionals.

Answer the financial question based on the provided research sources. Provide a clear, comprehensive analysis with proper citations [1], [2], etc. Use professional financial formatting and terminology.

Financial Report Structure:
- Executive Summary with key findings and recommendations
- Quantitative analysis with specific metrics and benchmarks
- Risk assessment and mitigation strategies
- Regulatory and compliance considerations
- Implementation guidance for portfolio managers
- References to authoritative financial sources

Professional Standards:
- Use precise financial terminology and industry standards
- Include specific data points, time periods, and benchmarks
- Address both opportunities and risks
- Consider regulatory and compliance implications
- Provide actionable insights for investment decisions
- Maintain institutional-grade analytical rigor

If this relates to previous financial discussions, make connections to the broader investment thesis or portfolio strategy.`),
      new HumanMessage(
        `Question: "${query}"${contextPrompt}\n\nBased on these sources:\n${sourcesText}`
      ),
    ];

    let fullText = "";

    try {
      const stream = await this.streamingLlm.stream(messages);

      for await (const chunk of stream) {
        const content = chunk.content;
        if (typeof content === "string") {
          fullText += content;
          onChunk(content);
        }
      }
    } catch {
      // Fallback to non-streaming if streaming fails
      const response = await this.llm.invoke(messages);
      fullText = response.content.toString();
      onChunk(fullText);
    }

    return fullText;
  }

  private async generateFollowUpQuestions(
    originalQuery: string,
    answer: string,
    _sources: Source[],
    context?: { query: string; response: string }[]
  ): Promise<string[]> {
    try {
      let contextPrompt = "";
      if (context && context.length > 0) {
        contextPrompt = "\n\nPrevious conversation topics:\n";
        context.forEach((c) => {
          contextPrompt += `- ${c.query}\n`;
        });
        contextPrompt +=
          "\nConsider the full conversation flow when generating follow-ups.\n";
      }

      const messages = [
        new SystemMessage(`${this.getCurrentDateContext()}

You are a senior wealth management advisor generating strategic follow-up questions for high-net-worth clients and institutional investors.

Based on this financial research and analysis, generate 3 relevant follow-up questions that sophisticated investors would want to explore next.

Instructions:
- Generate exactly 3 follow-up questions
- Each question should explore a different aspect of the investment thesis
- Questions should be sophisticated and appropriate for institutional investors
- They should build upon the financial analysis provided
- Make them specific and actionable for portfolio management
- Keep each question under 80 characters
- Return only the questions, one per line, no numbering or bullets
- Consider the full investment context and client sophistication level
- Focus on strategic, tactical, and risk management dimensions

Examples of sophisticated financial follow-up questions:
- "What are the key risk factors and mitigation strategies?"
- "How does this compare to alternative investment approaches?"
- "What are the tax implications and optimization strategies?"
- "What are the regulatory considerations and compliance requirements?"
- "How should this be implemented in a diversified portfolio?"
- "What are the liquidity and exit strategy considerations?"
- "How does this align with ESG and sustainability objectives?"
- "What are the performance benchmarks and monitoring metrics?"`),
        new HumanMessage(
          `Original query: "${originalQuery}"\n\nAnswer summary: ${
            answer.length > 1000 ? answer.slice(0, 1000) + "..." : answer
          }${contextPrompt}`
        ),
      ];

      const response = await this.llm.invoke(messages);
      const questions = response.content
        .toString()
        .split("\n")
        .map((q) => q.trim())
        .filter((q) => q.length > 0 && q.length < 80)
        .slice(0, 3);

      return questions.length > 0 ? questions : [];
    } catch {
      return [];
    }
  }
}
