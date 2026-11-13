import { StateGraph, END, START, Annotation, MemorySaver } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { FirecrawlClient } from './firecrawl';
import { ContextProcessor } from './context-processor';
import { SEARCH_CONFIG, MODEL_CONFIG } from './config';

// Event types remain the same for frontend compatibility
export type SearchPhase = 
  | 'understanding'
  | 'planning' 
  | 'searching'
  | 'analyzing'
  | 'synthesizing'
  | 'complete'
  | 'error';

export type SearchEvent = 
  | { type: 'phase-update'; phase: SearchPhase; message: string }
  | { type: 'thinking'; message: string }
  | { type: 'searching'; query: string; index: number; total: number }
  | { type: 'found'; sources: Source[]; query: string }
  | { type: 'scraping'; url: string; index: number; total: number; query: string }
  | { type: 'content-chunk'; chunk: string }
  | { type: 'final-result'; content: string; sources: Source[]; followUpQuestions?: string[] }
  | { type: 'error'; error: string; errorType?: ErrorType }
  | { type: 'source-processing'; url: string; title: string; stage: 'browsing' | 'extracting' | 'analyzing' }
  | { type: 'source-complete'; url: string; summary: string };

export type ErrorType = 'search' | 'scrape' | 'llm' | 'unknown';

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
  status: 'pending' | 'active' | 'completed';
  startTime?: number;
}

// Proper LangGraph state using Annotation with reducers
const SearchStateAnnotation = Annotation.Root({
  // Input fields
  query: Annotation<string>({
    reducer: (_, y) => y ?? "",
    default: () => ""
  }),
  context: Annotation<{ query: string; response: string }[] | undefined>({
    reducer: (_, y) => y,
    default: () => undefined
  }),
  
  // Process fields
  understanding: Annotation<string | undefined>({
    reducer: (x, y) => y ?? x,
    default: () => undefined
  }),
  searchQueries: Annotation<string[] | undefined>({
    reducer: (x, y) => y ?? x,
    default: () => undefined
  }),
  currentSearchIndex: Annotation<number>({
    reducer: (x, y) => y ?? x,
    default: () => 0
  }),
  
  // Results fields - with proper array reducers
  sources: Annotation<Source[]>({
    reducer: (existing: Source[], update: Source[] | undefined) => {
      if (!update) return existing;
      // Deduplicate sources by URL
      const sourceMap = new Map<string, Source>();
      [...existing, ...update].forEach(source => {
        sourceMap.set(source.url, source);
      });
      return Array.from(sourceMap.values());
    },
    default: () => []
  }),
  scrapedSources: Annotation<Source[]>({
    reducer: (existing: Source[], update: Source[] | undefined) => {
      if (!update) return existing;
      return [...existing, ...update];
    },
    default: () => []
  }),
  processedSources: Annotation<Source[] | undefined>({
    reducer: (x, y) => y ?? x,
    default: () => undefined
  }),
  finalAnswer: Annotation<string | undefined>({
    reducer: (x, y) => y ?? x,
    default: () => undefined
  }),
  followUpQuestions: Annotation<string[] | undefined>({
    reducer: (x, y) => y ?? x,
    default: () => undefined
  }),
  
  // Answer tracking
  subQueries: Annotation<Array<{
    question: string;
    searchQuery: string;
    answered: boolean;
    answer?: string;
    confidence: number;
    sources: string[];
  }> | undefined>({
    reducer: (x, y) => y ?? x,
    default: () => undefined
  }),
  searchAttempt: Annotation<number>({
    reducer: (x, y) => y ?? x,
    default: () => 0
  }),
  
  // Control fields
  phase: Annotation<SearchPhase>({
    reducer: (x, y) => y ?? x,
    default: () => 'understanding' as SearchPhase
  }),
  error: Annotation<string | undefined>({
    reducer: (x, y) => y ?? x,
    default: () => undefined
  }),
  errorType: Annotation<ErrorType | undefined>({
    reducer: (x, y) => y ?? x,
    default: () => undefined
  }),
  maxRetries: Annotation<number>({
    reducer: (x, y) => y ?? x,
    default: () => SEARCH_CONFIG.MAX_RETRIES
  }),
  retryCount: Annotation<number>({
    reducer: (x, y) => y ?? x,
    default: () => 0
  })
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

  constructor(firecrawl: FirecrawlClient, options?: { enableCheckpointing?: boolean }) {
    this.firecrawl = firecrawl;
    this.contextProcessor = new ContextProcessor();
    
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY environment variable is not set');
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
      { id: 'understanding', label: 'Understanding request', status: 'pending' },
      { id: 'planning', label: 'Planning search', status: 'pending' },
      { id: 'searching', label: 'Searching sources', status: 'pending' },
      { id: 'analyzing', label: 'Analyzing content', status: 'pending' },
      { id: 'synthesizing', label: 'Synthesizing answer', status: 'pending' },
      { id: 'complete', label: 'Complete', status: 'pending' }
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
      .addNode("understand", async (state: SearchState, config?: GraphConfig): Promise<Partial<SearchState>> => {
        const eventCallback = config?.configurable?.eventCallback;
        
        if (eventCallback) {
          eventCallback({
            type: 'phase-update',
            phase: 'understanding',
            message: 'Analyzing your request...'
          });
        }
        
        try {
          const understanding = await analyzeQuery(state.query, state.context);
          
          if (eventCallback) {
            eventCallback({
              type: 'thinking',
              message: understanding
            });
          }
          
          return {
            understanding,
            phase: 'planning' as SearchPhase
          };
        } catch (error) {
          return {
            error: error instanceof Error ? error.message : 'Failed to understand query',
            errorType: 'llm' as ErrorType,
            phase: 'error' as SearchPhase
          };
        }
      })
      
      // Planning node
      .addNode("plan", async (state: SearchState, config?: GraphConfig): Promise<Partial<SearchState>> => {
        const eventCallback = config?.configurable?.eventCallback;
        
        if (eventCallback) {
          eventCallback({
            type: 'phase-update',
            phase: 'planning',
            message: 'Planning search strategy...'
          });
        }
        
        try {
          // Extract sub-queries if not already done
          let subQueries = state.subQueries;
          if (!subQueries) {
            const extractSubQueries = this.extractSubQueries.bind(this);
            const extracted = await extractSubQueries(state.query);
            subQueries = extracted.map(sq => ({
              question: sq.question,
              searchQuery: sq.searchQuery,
              answered: false,
              confidence: 0,
              sources: []
            }));
          }
          
          // Generate search queries for unanswered questions
          const unansweredQueries = subQueries.filter(sq => !sq.answered || sq.confidence < SEARCH_CONFIG.MIN_ANSWER_CONFIDENCE);
          
          if (unansweredQueries.length === 0) {
            // All questions answered, skip to analysis
            return {
              subQueries,
              phase: 'analyzing' as SearchPhase
            };
          }
          
          // Use alternative search queries if this is a retry
          let searchQueries: string[];
          if (state.searchAttempt > 0) {
            const generateAlternativeSearchQueries = this.generateAlternativeSearchQueries.bind(this);
            searchQueries = await generateAlternativeSearchQueries(subQueries, state.searchAttempt);
            
            // Update sub-queries with new search queries
            let alternativeIndex = 0;
            subQueries.forEach(sq => {
              if (!sq.answered || sq.confidence < SEARCH_CONFIG.MIN_ANSWER_CONFIDENCE) {
                if (alternativeIndex < searchQueries.length) {
                  sq.searchQuery = searchQueries[alternativeIndex];
                  alternativeIndex++;
                }
              }
            });
          } else {
            // First attempt - use the search queries from sub-queries
            searchQueries = unansweredQueries.map(sq => sq.searchQuery);
          }
          
          if (eventCallback) {
            if (state.searchAttempt === 0) {
              eventCallback({
                type: 'thinking',
                message: searchQueries.length > 3 
                  ? `I detected ${subQueries.length} different questions. I'll search for each one separately.`
                  : `I'll search for information to answer your question.`
              });
            } else {
              eventCallback({
                type: 'thinking',
                message: `Trying alternative search strategies for: ${unansweredQueries.map(sq => sq.question).join(', ')}`
              });
            }
          }
          
          return {
            searchQueries,
            subQueries,
            currentSearchIndex: 0,
            phase: 'searching' as SearchPhase
          };
        } catch (error) {
          return {
            error: error instanceof Error ? error.message : 'Failed to plan search',
            errorType: 'llm' as ErrorType,
            phase: 'error' as SearchPhase
          };
        }
      })
      
      // Search node (handles one search at a time)
      .addNode("search", async (state: SearchState, config?: GraphConfig): Promise<Partial<SearchState>> => {
        const eventCallback = config?.configurable?.eventCallback;
        const searchQueries = state.searchQueries || [];
        const currentIndex = state.currentSearchIndex || 0;
        
        if (currentIndex === 0 && eventCallback) {
          eventCallback({
            type: 'phase-update',
            phase: 'searching',
            message: 'Searching the web...'
          });
        }
        
        if (currentIndex >= searchQueries.length) {
          return {
            phase: 'scrape' as SearchPhase
          };
        }
        
        const searchQuery = searchQueries[currentIndex];
        
        if (eventCallback) {
          eventCallback({
            type: 'searching',
            query: searchQuery,
            index: currentIndex + 1,
            total: searchQueries.length
          });
        }
        
        try {
          const results = await firecrawl.search(searchQuery, {
            limit: SEARCH_CONFIG.MAX_SOURCES_PER_SEARCH,
            scrapeOptions: {
              formats: ['markdown']
            }
          });
          
          const newSources: Source[] = results.data.map((r: SearchResult) => ({
            url: r.url,
            title: r.title,
            content: r.markdown || r.content || '',
            quality: 0
          }));
          
          if (eventCallback) {
            eventCallback({
              type: 'found',
              sources: newSources,
              query: searchQuery
            });
          }
          
          // Process sources in parallel for better performance
          if (SEARCH_CONFIG.PARALLEL_SUMMARY_GENERATION) {
            await Promise.all(newSources.map(async (source) => {
              if (eventCallback) {
                eventCallback({
                  type: 'source-processing',
                  url: source.url,
                  title: source.title,
                  stage: 'browsing'
                });
              }
              
              // Score the content
              source.quality = scoreContent(source.content || '', state.query);
              
              // Generate summary if content is available
              if (source.content && source.content.length > SEARCH_CONFIG.MIN_CONTENT_LENGTH) {
                const summary = await summarizeContent(source.content, searchQuery);
                
                // Store the summary in the source object
                if (summary && !summary.toLowerCase().includes('no specific')) {
                  source.summary = summary;
                  
                  if (eventCallback) {
                    eventCallback({
                      type: 'source-complete',
                      url: source.url,
                      summary: summary
                    });
                  }
                }
              }
            }));
          } else {
            // Original sequential processing
            for (const source of newSources) {
              if (eventCallback) {
                eventCallback({
                  type: 'source-processing',
                  url: source.url,
                  title: source.title,
                  stage: 'browsing'
                });
              }
              
              // Small delay for animation
              await new Promise(resolve => setTimeout(resolve, SEARCH_CONFIG.SOURCE_ANIMATION_DELAY));
              
              // Score the content
              source.quality = scoreContent(source.content || '', state.query);
              
              // Generate summary if content is available
              if (source.content && source.content.length > SEARCH_CONFIG.MIN_CONTENT_LENGTH) {
                const summary = await summarizeContent(source.content, searchQuery);
                
                // Store the summary in the source object
                if (summary && !summary.toLowerCase().includes('no specific')) {
                  source.summary = summary;
                  
                  if (eventCallback) {
                    eventCallback({
                      type: 'source-complete',
                      url: source.url,
                      summary: summary
                    });
                  }
                }
              }
            }
          }
          
          return {
            sources: newSources,
            currentSearchIndex: currentIndex + 1
          };
        } catch {
          return {
            currentSearchIndex: currentIndex + 1,
            errorType: 'search' as ErrorType
          };
        }
      })
      
      // Scraping node
      .addNode("scrape", async (state: SearchState, config?: GraphConfig): Promise<Partial<SearchState>> => {
        const eventCallback = config?.configurable?.eventCallback;
        const sourcesToScrape = state.sources?.filter(s => 
          !s.content || s.content.length < SEARCH_CONFIG.MIN_CONTENT_LENGTH
        ) || [];
        const newScrapedSources: Source[] = [];
        
        // Sources with content were already processed in search node, just pass them through
        const sourcesWithContent = state.sources?.filter(s => 
          s.content && s.content.length >= SEARCH_CONFIG.MIN_CONTENT_LENGTH
        ) || [];
        newScrapedSources.push(...sourcesWithContent);
        
        // Then scrape sources without content
        for (let i = 0; i < Math.min(sourcesToScrape.length, SEARCH_CONFIG.MAX_SOURCES_TO_SCRAPE); i++) {
          const source = sourcesToScrape[i];
          
          if (eventCallback) {
            eventCallback({
              type: 'scraping',
              url: source.url,
              index: newScrapedSources.length + 1,
              total: sourcesWithContent.length + Math.min(sourcesToScrape.length, SEARCH_CONFIG.MAX_SOURCES_TO_SCRAPE),
              query: state.query
            });
          }
          
          try {
            const scraped = await firecrawl.scrapeUrl(source.url, SEARCH_CONFIG.SCRAPE_TIMEOUT);
            if (scraped.success && scraped.markdown) {
              const enrichedSource = {
                ...source,
                content: scraped.markdown,
                quality: scoreContent(scraped.markdown, state.query)
              };
              newScrapedSources.push(enrichedSource);
              
              // Show processing animation
              if (eventCallback) {
                eventCallback({
                  type: 'source-processing',
                  url: source.url,
                  title: source.title,
                  stage: 'browsing'
                });
              }
              
              await new Promise(resolve => setTimeout(resolve, 150));
              
              const summary = await summarizeContent(scraped.markdown, state.query);
              if (summary) {
                enrichedSource.summary = summary;
                
                if (eventCallback) {
                  eventCallback({
                    type: 'source-complete',
                    url: source.url,
                    summary: summary
                  });
                }
              }
            } else if (scraped.error === 'timeout') {
              if (eventCallback) {
                eventCallback({
                  type: 'thinking',
                  message: `${new URL(source.url).hostname} is taking too long to respond, moving on...`
                });
              }
            }
          } catch {
            if (eventCallback) {
              eventCallback({
                type: 'thinking',
                message: `Couldn't access ${new URL(source.url).hostname}, trying other sources...`
              });
            }
          }
        }
        
        return {
          scrapedSources: newScrapedSources,
          phase: 'analyzing' as SearchPhase
        };
      })
      
      // Analyzing node
      .addNode("analyze", async (state: SearchState, config?: GraphConfig): Promise<Partial<SearchState>> => {
        const eventCallback = config?.configurable?.eventCallback;
        
        if (eventCallback) {
          eventCallback({
            type: 'phase-update',
            phase: 'analyzing',
            message: 'Analyzing gathered information...'
          });
        }
        
        // Combine sources and remove duplicates by URL
        const sourceMap = new Map<string, Source>();
        
        // Add all sources (not just those with long content, since summaries contain key info)
        (state.sources || []).forEach(s => sourceMap.set(s.url, s));
        
        // Add scraped sources (may override with better content)
        (state.scrapedSources || []).forEach(s => sourceMap.set(s.url, s));
        
        const allSources = Array.from(sourceMap.values());
        
        // Check which questions have been answered
        if (state.subQueries) {
          const checkAnswersInSources = this.checkAnswersInSources.bind(this);
          const updatedSubQueries = await checkAnswersInSources(state.subQueries, allSources);
          
          const answeredCount = updatedSubQueries.filter(sq => sq.answered).length;
          const totalQuestions = updatedSubQueries.length;
          const searchAttempt = (state.searchAttempt || 0) + 1;
          
          // Check if we have partial answers with decent confidence
          const partialAnswers = updatedSubQueries.filter(sq => sq.confidence >= 0.3);
          const hasPartialInfo = partialAnswers.length > answeredCount;
          
          if (eventCallback) {
            if (answeredCount === totalQuestions) {
              eventCallback({
                type: 'thinking',
                message: `Found answers to all ${totalQuestions} questions across ${allSources.length} sources`
              });
            } else if (answeredCount > 0) {
              eventCallback({
                type: 'thinking',
                message: `Found answers to ${answeredCount} of ${totalQuestions} questions. Still missing: ${updatedSubQueries.filter(sq => !sq.answered).map(sq => sq.question).join(', ')}`
              });
            } else if (searchAttempt >= SEARCH_CONFIG.MAX_SEARCH_ATTEMPTS) {
              // Only show "could not find" message when we've exhausted all attempts
              eventCallback({
                type: 'thinking',
                message: `Could not find specific answers in ${allSources.length} sources. The information may not be publicly available.`
              });
            } else if (hasPartialInfo && searchAttempt >= 3) {
              // If we have partial info and tried 3+ times, stop searching
              eventCallback({
                type: 'thinking',
                message: `Found partial information. Moving forward with what's available.`
              });
            } else {
              // For intermediate attempts, show a different message
              eventCallback({
                type: 'thinking',
                message: `Searching for more specific information...`
              });
            }
          }
          
          // If we haven't found all answers and haven't exceeded attempts, try again
          // BUT stop if we have partial info and already tried 2+ times
          if (answeredCount < totalQuestions && 
              searchAttempt < SEARCH_CONFIG.MAX_SEARCH_ATTEMPTS &&
              !(hasPartialInfo && searchAttempt >= 2)) {
            return {
              sources: allSources,
              subQueries: updatedSubQueries,
              searchAttempt,
              phase: 'planning' as SearchPhase  // Go back to planning for retry
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
              phase: 'synthesizing' as SearchPhase
            };
          } catch {
            return {
              sources: allSources,
              processedSources: allSources,
              subQueries: updatedSubQueries,
              searchAttempt,
              phase: 'synthesizing' as SearchPhase
            };
          }
        } else {
          // Fallback for queries without sub-queries
          if (eventCallback && allSources.length > 0) {
            eventCallback({
              type: 'thinking',
              message: `Found ${allSources.length} sources with quality information`
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
              phase: 'synthesizing' as SearchPhase
            };
          } catch {
            return {
              sources: allSources,
              processedSources: allSources,
              phase: 'synthesizing' as SearchPhase
            };
          }
        }
      })
      
      // Synthesizing node with streaming
      .addNode("synthesize", async (state: SearchState, config?: GraphConfig): Promise<Partial<SearchState>> => {
        const eventCallback = config?.configurable?.eventCallback;
        
        if (eventCallback) {
          eventCallback({
            type: 'phase-update',
            phase: 'synthesizing',
            message: 'Creating comprehensive answer...'
          });
        }
        
        try {
          const sourcesToUse = state.processedSources || state.sources || [];
          
          const answer = await generateStreamingAnswer(
            state.query,
            sourcesToUse,
            (chunk) => {
              if (eventCallback) {
                eventCallback({ type: 'content-chunk', chunk });
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
            phase: 'complete' as SearchPhase
          };
        } catch (error) {
          return {
            error: error instanceof Error ? error.message : 'Failed to generate answer',
            errorType: 'llm' as ErrorType,
            phase: 'error' as SearchPhase
          };
        }
      })
      
      // Error handling node
      .addNode("handleError", async (state: SearchState, config?: GraphConfig): Promise<Partial<SearchState>> => {
        const eventCallback = config?.configurable?.eventCallback;
        
        if (eventCallback) {
          eventCallback({
            type: 'error',
            error: state.error || 'An unknown error occurred',
            errorType: state.errorType
          });
        }
        
        // Retry logic based on error type
        if ((state.retryCount || 0) < (state.maxRetries || SEARCH_CONFIG.MAX_RETRIES)) {
              
          // Different retry strategies based on error type
          const retryPhase = state.errorType === 'search' ? 'searching' : 'understanding';
          
          return {
            retryCount: (state.retryCount || 0) + 1,
            phase: retryPhase as SearchPhase,
            error: undefined,
            errorType: undefined
          };
        }
        
        return {
          phase: 'error' as SearchPhase
        };
      })
      
      // Complete node
      .addNode("complete", async (state: SearchState, config?: GraphConfig): Promise<Partial<SearchState>> => {
        const eventCallback = config?.configurable?.eventCallback;
        
        if (eventCallback) {
          eventCallback({
            type: 'phase-update',
            phase: 'complete',
            message: 'Search complete!'
          });
          
          eventCallback({
            type: 'final-result',
            content: state.finalAnswer || '',
            sources: state.processedSources || state.sources || [],
            followUpQuestions: state.followUpQuestions
          });
        }
        
        return {
          phase: 'complete' as SearchPhase
        };
      });

    // Add edges with proper conditional routing
    workflow
      .addEdge(START, "understand")
      .addConditionalEdges(
        "understand",
        (state: SearchState) => state.phase === 'error' ? "handleError" : "plan",
        {
          handleError: "handleError",
          plan: "plan"
        }
      )
      .addConditionalEdges(
        "plan",
        (state: SearchState) => state.phase === 'error' ? "handleError" : "search",
        {
          handleError: "handleError",
          search: "search"
        }
      )
      .addConditionalEdges(
        "search",
        (state: SearchState) => {
          if (state.phase === 'error') return "handleError";
          if ((state.currentSearchIndex || 0) < (state.searchQueries?.length || 0)) {
            return "search"; // Continue searching
          }
          return "scrape"; // Move to scraping
        },
        {
          handleError: "handleError",
          search: "search",
          scrape: "scrape"
        }
      )
      .addConditionalEdges(
        "scrape",
        (state: SearchState) => state.phase === 'error' ? "handleError" : "analyze",
        {
          handleError: "handleError",
          analyze: "analyze"
        }
      )
      .addConditionalEdges(
        "analyze",
        (state: SearchState) => {
          if (state.phase === 'error') return "handleError";
          if (state.phase === 'planning') return "plan";  // Retry with new searches
          return "synthesize";
        },
        {
          handleError: "handleError",
          plan: "plan",
          synthesize: "synthesize"
        }
      )
      .addConditionalEdges(
        "synthesize",
        (state: SearchState) => state.phase === 'error' ? "handleError" : "complete",
        {
          handleError: "handleError",
          complete: "complete"
        }
      )
      .addConditionalEdges(
        "handleError",
        (state: SearchState) => state.phase === 'error' ? END : "understand",
        {
          [END]: END,
          understand: "understand"
        }
      )
      .addEdge("complete", END);

    // Compile with optional checkpointing
    return workflow.compile(this.checkpointer ? { checkpointer: this.checkpointer } : undefined);
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
        phase: 'understanding',
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
        searchAttempt: 0
      };

      // Configure with event callback
      const config: GraphConfig = {
        configurable: {
          eventCallback: onEvent,
          ...(checkpointId && this.checkpointer ? { thread_id: checkpointId } : {})
        }
      };

      // Invoke the graph with increased recursion limit
      await this.graph.invoke(initialState, {
        ...config,
        recursionLimit: 35  // Increased from default 25 to handle MAX_SEARCH_ATTEMPTS=5
      });
    } catch (error) {
      onEvent({
        type: 'error',
        error: error instanceof Error ? error.message : 'Search failed',
        errorType: 'unknown'
      });
    }
  }


  // Get current date for context
  private getCurrentDateContext(): string {
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', { 
      weekday: 'long', 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric' 
    });
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    
    return `Today's date is ${dateStr}. The current year is ${year} and it's currently ${month}/${year}.`;
  }

  // Pure helper methods (no side effects)
  private async analyzeQuery(query: string, context?: { query: string; response: string }[]): Promise<string> {
    let contextPrompt = '';
    if (context && context.length > 0) {
      contextPrompt = '\n\nPrevious conversation:\n';
      context.forEach(c => {
        contextPrompt += `User: ${c.query}\nAssistant: ${c.response.substring(0, SEARCH_CONFIG.CONTEXT_PREVIEW_LENGTH)}...\n\n`;
      });
    }
    
    const messages = [
      new SystemMessage(`${this.getCurrentDateContext()}

Analyze this search query and explain what you understand the user is looking for.

Instructions:
- Start with a clear, concise title (e.g., "Researching egg shortage" or "Understanding climate change impacts")
- Then explain in 1-2 sentences what aspects of the topic the user wants to know about
- If this relates to previous questions, acknowledge that connection
- Finally, mention that you'll search for information to help answer their question
- Only mention searching for "latest" information if the query is explicitly about recent events or current trends

Keep it natural and conversational, showing you truly understand their request.`),
      new HumanMessage(`Query: "${query}"${contextPrompt}`)
    ];
    
    const response = await this.llm.invoke(messages);
    return response.content.toString();
  }

  private async checkAnswersInSources(
    subQueries: Array<{ question: string; searchQuery: string; answered: boolean; answer?: string; confidence: number; sources: string[] }>,
    sources: Source[]
  ): Promise<typeof subQueries> {
    if (sources.length === 0) return subQueries;
    
    const messages = [
      new SystemMessage(`Check which questions have been answered by the provided sources.

For each question, determine:
1. If the sources contain a direct answer
2. The confidence level (0.0-1.0) that the question was fully answered
3. A brief answer summary if found

Guidelines:
- For "who" questions about people/founders: Mark as answered (0.8+ confidence) if you find names of specific people
- For "what" questions: Mark as answered (0.8+ confidence) if you find the specific information requested
- For "when" questions: Mark as answered (0.8+ confidence) if you find dates or time periods
- For "how many" questions: Require specific numbers (0.8+ confidence)
- For comparison questions: Require information about all items being compared
- If sources clearly answer the question but lack some minor details, use medium confidence (0.6-0.7)
- If sources mention the topic but don't answer the specific question, use low confidence (< 0.3)

Version number matching:
- "0528" in the question matches "0528", "-0528", "May 28", or "May 28, 2025" in sources
- Example: Question about "DeepSeek R1 0528" is ANSWERED if sources mention:
  - "DeepSeek R1-0528" (exact match)
  - "DeepSeek R1 was updated on May 28" (date match)
  - "DeepSeek's R1 model was updated on May 28, 2025" (date match)
- Hyphens and spaces in version numbers should be ignored when matching
- If the summary mentions the product and a matching date/version, that's a full answer

Special cases:
- If asking about a product/model with a version number (e.g., "ModelX v2.5.1" or "Product 0528"), check BOTH:
  1. If sources mention the EXACT version → mark as answered with high confidence (0.8+)
  2. If sources only mention the base product → mark as answered with medium confidence (0.6+)
- Example: Question "What is ProductX 1234?" 
  - If sources mention "ProductX 1234" specifically → confidence: 0.9
  - If sources only mention "ProductX" → confidence: 0.6
- IMPORTANT: For questions like "What is DeepSeek R1 0528?", if sources contain "DeepSeek R1-0528" or "DeepSeek R1 0528", that's a DIRECT match (confidence 0.9+)
- If multiple sources contradict whether something exists, use low confidence (0.3) but still provide what information was found

Important: Be generous in recognizing answers. If the source clearly provides the information asked for (e.g., "The founders are X, Y, and Z"), mark it as answered with high confidence.

Return ONLY a JSON array, no markdown formatting or code blocks:
[
  {
    "question": "the original question",
    "answered": true/false,
    "confidence": 0.0-1.0,
    "answer": "brief answer if found",
    "sources": ["urls that contain the answer"]
  }
]`),
      new HumanMessage(`Questions to check:
${subQueries.map(sq => sq.question).join('\n')}

Sources:
${sources.slice(0, SEARCH_CONFIG.MAX_SOURCES_TO_CHECK).map(s => {
  let sourceInfo = `URL: ${s.url}\nTitle: ${s.title}\n`;
  
  // Include summary if available (this is the key insight from the search)
  if (s.summary) {
    sourceInfo += `Summary: ${s.summary}\n`;
  }
  
  // Include content preview
  if (s.content) {
    sourceInfo += `Content: ${s.content.slice(0, SEARCH_CONFIG.ANSWER_CHECK_PREVIEW)}\n`;
  }
  
  return sourceInfo;
}).join('\n---\n')}`)
    ];

    try {
      const response = await this.llm.invoke(messages);
      let content = response.content.toString();
      
      // Strip markdown code blocks if present
      content = content.replace(/```json\s*/g, '').replace(/```\s*$/g, '').trim();
      
      const results = JSON.parse(content);
      
      // Update sub-queries with results
      return subQueries.map(sq => {
        const result = results.find((r: { question: string }) => r.question === sq.question);
        if (result && result.confidence > sq.confidence) {
          return {
            ...sq,
            answered: result.confidence >= SEARCH_CONFIG.MIN_ANSWER_CONFIDENCE,
            answer: result.answer,
            confidence: result.confidence,
            sources: [...new Set([...sq.sources, ...(result.sources || [])])]
          };
        }
        return sq;
      });
    } catch (error) {
      console.error('Error checking answers:', error);
      return subQueries;
    }
  }

  private async extractSubQueries(query: string): Promise<Array<{ question: string; searchQuery: string }>> {
    const messages = [
      new SystemMessage(`Extract the individual factual questions from this query. Each question should be something that can be definitively answered.

IMPORTANT: 
- When the user mentions something with a version/number (like "deepseek r1 0528"), include the FULL version in the question
- For the search query, you can simplify slightly but keep key identifiers
- Example: "deepseek r1 0528" → question: "What is DeepSeek R1 0528?", searchQuery: "DeepSeek R1 0528"

Examples:
"Who founded Anthropic and when" → 
[
  {"question": "Who founded Anthropic?", "searchQuery": "Anthropic founders"},
  {"question": "When was Anthropic founded?", "searchQuery": "Anthropic founded date year"}
]

"What is OpenAI's Q3 2024 revenue and who is their VP of Infrastructure" →
[
  {"question": "What was OpenAI's Q3 2024 revenue?", "searchQuery": "OpenAI Q3 2024 revenue earnings"},
  {"question": "Who is OpenAI's VP of Infrastructure?", "searchQuery": "OpenAI VP Infrastructure executive team"}
]

"Tell me about Product A + Model B version 123" →
[
  {"question": "What is Product A?", "searchQuery": "Product A features"},
  {"question": "What is Model B version 123?", "searchQuery": "Model B"}
]

"Who founded Company X, compare Product A and Product B, and tell me about Technology Y + Model Z 1234" →
[
  {"question": "Who founded Company X?", "searchQuery": "Company X founders"},
  {"question": "How do Product A and Product B compare?", "searchQuery": "Product A vs Product B comparison"},
  {"question": "What is Technology Y?", "searchQuery": "Technology Y features"},
  {"question": "What is Model Z 1234?", "searchQuery": "Model Z"}
]

Important: 
- For comparison requests, create a single question/search that covers both items
- If a term looks like it might be a model name with a version/date (like "R1 0528"), treat it as a single entity first, but create a search query that focuses on the main product name
- Keep the number of sub-queries reasonable (aim for 3-5 max)

Return ONLY a JSON array of {question, searchQuery} objects.`),
      new HumanMessage(`Query: "${query}"`)
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
    subQueries: Array<{ question: string; searchQuery: string; answered: boolean; answer?: string; confidence: number; sources: string[] }>,
    previousAttempts: number
  ): Promise<string[]> {
    const unansweredQueries = subQueries.filter(sq => !sq.answered || sq.confidence < SEARCH_CONFIG.MIN_ANSWER_CONFIDENCE);
    
    // If we're on attempt 3 and still searching for the same thing, just give up on that specific query
    if (previousAttempts >= 2) {
      const problematicQueries = unansweredQueries.filter(sq => {
        // Check if the question contains a version number or specific identifier that might not exist
        const hasVersionPattern = /\b\d{3,4}\b|\bv\d+\.\d+|\bversion\s+\d+/i.test(sq.question);
        const hasFailedMultipleTimes = previousAttempts >= 2;
        return hasVersionPattern && hasFailedMultipleTimes;
      });
      
      if (problematicQueries.length > 0) {
        // Return generic searches that might find partial info
        return problematicQueries.map(sq => {
          const baseTerm = sq.question.replace(/0528|specific version/gi, '').trim();
          return baseTerm.substring(0, 50); // Keep it short
        });
      }
    }
    
    const messages = [
      new SystemMessage(`${this.getCurrentDateContext()}

Generate ALTERNATIVE search queries for questions that weren't answered in previous attempts.

Previous search attempts: ${previousAttempts}
Previous queries that didn't find answers:
${unansweredQueries.map(sq => `- Question: "${sq.question}"\n  Previous search: "${sq.searchQuery}"`).join('\n')}

IMPORTANT: If searching for something with a specific version/date that keeps failing (like "R1 0528"), try searching for just the base product without the version.

Generate NEW search queries using these strategies:
1. Try broader or more general terms
2. Try different phrasings or synonyms
3. Remove specific qualifiers (like years or versions) if they're too restrictive
4. Try searching for related concepts that might contain the answer
5. For products that might not exist, search for the company or base product name

Examples of alternative searches:
- Original: "ModelX 2024.05" → Alternative: "ModelX latest version"
- Original: "OpenAI Q3 2024 revenue" → Alternative: "OpenAI financial results 2024"
- Original: "iPhone 15 Pro features" → Alternative: "latest iPhone specifications"

Return one alternative search query per unanswered question, one per line.`),
      new HumanMessage(`Generate alternative searches for these ${unansweredQueries.length} unanswered questions.`)
    ];

    try {
      const response = await this.llm.invoke(messages);
      const result = response.content.toString();
      
      const queries = result
        .split('\n')
        .map(q => q.trim())
        .map(q => q.replace(/^["']|["']$/g, ''))
        .map(q => q.replace(/^\d+\.\s*/, ''))
        .map(q => q.replace(/^[-*#]\s*/, ''))
        .filter(q => q.length > 0)
        .filter(q => !q.match(/^```/))
        .filter(q => q.length > 3);
      
      return queries.slice(0, SEARCH_CONFIG.MAX_SEARCH_QUERIES);
    } catch {
      // Fallback: return original queries with slight modifications
      return unansweredQueries.map(sq => sq.searchQuery + " news reports").slice(0, SEARCH_CONFIG.MAX_SEARCH_QUERIES);
    }
  }

  private scoreContent(content: string, query: string): number {
    const queryWords = query.toLowerCase().split(' ');
    const contentLower = content.toLowerCase();
    
    let score = 0;
    for (const word of queryWords) {
      if (contentLower.includes(word)) score += 0.2;
    }
    
    return Math.min(score, 1);
  }

  private async summarizeContent(content: string, query: string): Promise<string> {
    try {
      const messages = [
        new SystemMessage(`${this.getCurrentDateContext()}

Extract ONE key finding from this content that's SPECIFICALLY relevant to the search query.

CRITICAL: Only summarize information that directly relates to the search query.
- If searching for "Samsung phones", only mention Samsung phone information
- If searching for "Firecrawl founders", only mention founder information
- If no relevant information is found, just return the most relevant fact from the page

Instructions:
- Return just ONE sentence with a specific finding
- Include numbers, dates, or specific details when available
- Keep it under ${SEARCH_CONFIG.SUMMARY_CHAR_LIMIT} characters
- Don't say "No relevant information was found" - find something relevant to the current search`),
        new HumanMessage(`Query: "${query}"\n\nContent: ${content.slice(0, 2000)}`)
      ];
      
      const response = await this.llm.invoke(messages);
      return response.content.toString().trim();
    } catch {
      return '';
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
      .join('\n\n');
    
    let contextPrompt = '';
    if (context && context.length > 0) {
      contextPrompt = '\n\nPrevious conversation for context:\n';
      context.forEach(c => {
        contextPrompt += `User: ${c.query}\nAssistant: ${c.response.substring(0, 300)}...\n\n`;
      });
    }
    
    const messages = [
      new SystemMessage(`${this.getCurrentDateContext()}

Answer the user's question based on the provided sources. Provide a clear, comprehensive answer with citations [1], [2], etc. Use markdown formatting for better readability. If this question relates to previous topics discussed, make connections where relevant.`),
      new HumanMessage(`Question: "${query}"${contextPrompt}\n\nBased on these sources:\n${sourcesText}`)
    ];
    
    let fullText = '';
    
    try {
      const stream = await this.streamingLlm.stream(messages);
      
      for await (const chunk of stream) {
        const content = chunk.content;
        if (typeof content === 'string') {
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
      let contextPrompt = '';
      if (context && context.length > 0) {
        contextPrompt = '\n\nPrevious conversation topics:\n';
        context.forEach(c => {
          contextPrompt += `- ${c.query}\n`;
        });
        contextPrompt += '\nConsider the full conversation flow when generating follow-ups.\n';
      }
      
      const messages = [
        new SystemMessage(`${this.getCurrentDateContext()}

Based on this search query and answer, generate 3 relevant follow-up questions that the user might want to explore next.

Instructions:
- Generate exactly 3 follow-up questions
- Each question should explore a different aspect or dig deeper into the topic
- Questions should be natural and conversational
- They should build upon the information provided in the answer
- Make them specific and actionable
- Keep each question under 80 characters
- Return only the questions, one per line, no numbering or bullets
- Consider the entire conversation context when generating questions
- Only include time-relevant questions if the original query was about current events or trends

Examples of good follow-up questions:
- "How does this compare to [alternative]?"
- "Can you explain [technical term] in more detail?"
- "What are the practical applications of this?"
- "What are the main benefits and drawbacks?"
- "How is this typically implemented?"`),
        new HumanMessage(`Original query: "${originalQuery}"\n\nAnswer summary: ${answer.length > 1000 ? answer.slice(0, 1000) + '...' : answer}${contextPrompt}`)
      ];
      
      const response = await this.llm.invoke(messages);
      const questions = response.content.toString()
        .split('\n')
        .map(q => q.trim())
        .filter(q => q.length > 0 && q.length < 80)
        .slice(0, 3);
      
      return questions.length > 0 ? questions : [];
    } catch {
      return [];
    }
  }
}