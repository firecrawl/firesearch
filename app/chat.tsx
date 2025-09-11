"use client";

import { useState, useEffect, useRef } from "react";
import { search } from "./search";
import { readStreamableValue } from "ai/rsc";
import { SearchDisplay } from "./search-display";
import { SearchEvent, Source } from "@/lib/langgraph-search-engine";
import { MarkdownRenderer } from "./markdown-renderer";
import { CitationTooltip } from "./citation-tooltip";
import Image from "next/image";
import {
  getFaviconUrl,
  getDefaultFavicon,
  markFaviconFailed,
} from "@/lib/favicon-utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

const SUGGESTED_QUERIES = [
  "What’s new in AI-driven portfolio management this year?",
  "How are advisors actually using ESG data in portfolios today?",
  "Do robo-advisors deliver better results than human advisors?",
  "Where are the biggest equity opportunities in Hong Kong right now?",
  "Are Hong Kong REITs still a smart play for wealth portfolios?",
  "How are family offices leveraging alternative investments in 2025?",
];

// Helper component for sources list
function SourcesList({ sources }: { sources: Source[] }) {
  const [showSourcesPanel, setShowSourcesPanel] = useState(false);
  const [expandedSourceIndex, setExpandedSourceIndex] = useState<number | null>(
    null
  );

  return (
    <>
      {/* Sources button with favicon preview */}
      <div className="mt-6 flex items-center gap-3">
        <div className="flex -space-x-2">
          {(() => {
            // Get unique domains
            const uniqueDomains = new Map<string, Source>();
            sources.forEach((source) => {
              try {
                const domain = new URL(source.url).hostname;
                if (!uniqueDomains.has(domain)) {
                  uniqueDomains.set(domain, source);
                }
              } catch {}
            });
            const uniqueSources = Array.from(uniqueDomains.values());

            return (
              <>
                {uniqueSources.slice(0, 5).map((source, i) => (
                  <Image
                    key={i}
                    src={getFaviconUrl(source.url)}
                    alt=""
                    width={24}
                    height={24}
                    className="w-6 h-6 rounded-full border-2 border-white dark:border-gray-900 bg-white"
                    style={{ zIndex: 5 - i }}
                    onError={(e) => {
                      const img = e.target as HTMLImageElement;
                      img.src = getDefaultFavicon(24);
                      markFaviconFailed(source.url);
                    }}
                  />
                ))}
                {uniqueSources.length > 5 && (
                  <div className="w-6 h-6 rounded-full border-2 border-white dark:border-gray-900 bg-gray-200 dark:bg-gray-700 flex items-center justify-center">
                    <span className="text-[10px] font-medium text-gray-600 dark:text-gray-300">
                      +{uniqueSources.length - 5}
                    </span>
                  </div>
                )}
              </>
            );
          })()}
        </div>
        <button
          onClick={() => setShowSourcesPanel(true)}
          className="text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 flex items-center gap-2"
        >
          <span>View {sources.length} sources & page contents</span>
          <svg
            className="w-4 h-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 5l7 7-7 7"
            />
          </svg>
        </button>
      </div>

      {/* Click-away overlay */}
      {showSourcesPanel && (
        <div
          className="fixed inset-0 z-30"
          onClick={() => setShowSourcesPanel(false)}
        />
      )}

      {/* Sources Panel */}
      <div
        className={`fixed inset-y-0 right-0 w-96 bg-white dark:bg-gray-900 border-l border-gray-200 dark:border-gray-700 transform transition-transform duration-300 ease-in-out ${
          showSourcesPanel ? "translate-x-0" : "translate-x-full"
        } z-40 overflow-y-auto scrollbar-hide`}
      >
        <div className="p-6">
          <div className="flex items-center justify-between mb-6">
            <h3 className="text-lg font-semibold">
              Sources ({sources.length})
            </h3>
            <button
              onClick={() => setShowSourcesPanel(false)}
              className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
            >
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>

          <div className="space-y-2">
            {sources.map((source, i) => (
              <div
                key={i}
                className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden transition-colors"
              >
                <div
                  className={`p-3 hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer ${
                    expandedSourceIndex === i ? "" : "rounded-lg"
                  }`}
                  onClick={() =>
                    setExpandedSourceIndex(expandedSourceIndex === i ? null : i)
                  }
                >
                  <div className="flex items-start gap-3">
                    <span className="text-sm font-medium text-orange-600 mt-0.5">
                      [{i + 1}]
                    </span>
                    <Image
                      src={getFaviconUrl(source.url)}
                      alt=""
                      width={20}
                      height={20}
                      className="w-5 h-5 mt-0.5 flex-shrink-0"
                      onError={(e) => {
                        const img = e.target as HTMLImageElement;
                        img.src = getDefaultFavicon(20);
                        markFaviconFailed(source.url);
                      }}
                    />
                    <div className="flex-1 min-w-0">
                      <a
                        href={source.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-medium text-sm text-gray-900 dark:text-gray-100 hover:text-orange-600 dark:hover:text-orange-400 line-clamp-2"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {source.title}
                      </a>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 truncate">
                        {new URL(source.url).hostname}
                      </p>
                    </div>
                    <svg
                      className={`w-4 h-4 text-gray-400 transition-transform ${
                        expandedSourceIndex === i ? "rotate-180" : ""
                      }`}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M19 9l-7 7-7-7"
                      />
                    </svg>
                  </div>
                </div>

                {expandedSourceIndex === i && source.content && (
                  <div className="border-t border-gray-200 dark:border-gray-700">
                    <div className="px-4 py-2 border-b border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50">
                      <span className="text-xs text-gray-500 dark:text-gray-400">
                        {source.content.length.toLocaleString()} characters
                      </span>
                    </div>
                    <div className="p-4 max-h-96 overflow-y-auto scrollbar-hide">
                      <div className="prose prose-sm dark:prose-invert max-w-none">
                        <MarkdownRenderer content={source.content} />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

export function Chat() {
  const [messages, setMessages] = useState<
    Array<{
      id: string;
      role: "user" | "assistant";
      content: string | React.ReactNode;
      isSearch?: boolean;
      searchResults?: string; // Store search results for context
    }>
  >([]);
  const [input, setInput] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [hasShownSuggestions, setHasShownSuggestions] = useState(false);
  const [firecrawlApiKey, setFirecrawlApiKey] = useState<string>("");
  const [hasApiKey, setHasApiKey] = useState<boolean>(false);
  const [showApiKeyModal, setShowApiKeyModal] = useState<boolean>(false);
  const [, setIsCheckingEnv] = useState<boolean>(true);
  const [pendingQuery, setPendingQuery] = useState<string>("");
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  const handleSelectSuggestion = (suggestion: string) => {
    setInput(suggestion);
    setShowSuggestions(false);
  };

  // Check for environment variables on mount
  useEffect(() => {
    const checkEnvironment = async () => {
      setIsCheckingEnv(true);
      try {
        const response = await fetch("/api/check-env");
        const data = await response.json();

        if (data.environmentStatus) {
          // Only check for Firecrawl API key since we can pass it from frontend
          // OpenAI and Anthropic keys must be in environment
          setHasApiKey(data.environmentStatus.FIRECRAWL_API_KEY);
        }
      } catch (error) {
        console.error("Failed to check environment:", error);
        setHasApiKey(false);
      } finally {
        setIsCheckingEnv(false);
      }
    };

    checkEnvironment();
  }, []);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    if (messagesContainerRef.current) {
      messagesContainerRef.current.scrollTop =
        messagesContainerRef.current.scrollHeight;
    }
  }, [messages]);

  const saveApiKey = () => {
    if (firecrawlApiKey.trim()) {
      setHasApiKey(true);
      setShowApiKeyModal(false);
      toast.success("API key saved! Starting your search...");

      // Continue with the pending query
      if (pendingQuery) {
        performSearch(pendingQuery);
        setPendingQuery("");
      }
    }
  };

  // Listen for follow-up question events
  useEffect(() => {
    const handleFollowUpQuestion = async (event: Event) => {
      const customEvent = event as CustomEvent;
      const question = customEvent.detail.question;
      setInput(question);

      // Trigger the search immediately
      setTimeout(() => {
        const form = document.querySelector("form");
        if (form) {
          form.dispatchEvent(
            new Event("submit", { cancelable: true, bubbles: true })
          );
        }
      }, 100);
    };

    document.addEventListener("followUpQuestion", handleFollowUpQuestion);
    return () => {
      document.removeEventListener("followUpQuestion", handleFollowUpQuestion);
    };
  }, []);

  const performSearch = async (query: string) => {
    setIsSearching(true);

    // Create assistant message with search display
    const assistantMsgId = (Date.now() + 1).toString();
    const events: SearchEvent[] = [];

    setMessages((prev) => [
      ...prev,
      {
        id: assistantMsgId,
        role: "assistant",
        content: <SearchDisplay events={events} />,
        isSearch: true,
      },
    ]);

    try {
      // Build context from previous messages by pairing user queries with assistant responses
      const conversationContext: Array<{ query: string; response: string }> =
        [];

      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        // Find user messages followed by assistant messages with search results
        if (msg.role === "user" && i + 1 < messages.length) {
          const nextMsg = messages[i + 1];
          if (nextMsg.role === "assistant" && nextMsg.searchResults) {
            conversationContext.push({
              query: msg.content as string,
              response: nextMsg.searchResults,
            });
          }
        }
      }

      // Get search stream with context
      // Pass the API key only if user provided one, otherwise let server use env var
      const { stream } = await search(
        query,
        conversationContext,
        firecrawlApiKey || undefined
      );
      let finalContent = "";

      // Read stream and update events
      let streamingStarted = false;
      const resultMsgId = (Date.now() + 2).toString();

      for await (const event of readStreamableValue(stream)) {
        if (event) {
          events.push(event);

          // Handle content streaming
          if (event.type === "content-chunk") {
            const content = events
              .filter((e) => e.type === "content-chunk")
              .map((e) => (e.type === "content-chunk" ? e.chunk : ""))
              .join("");

            if (!streamingStarted) {
              streamingStarted = true;
              // Add new message for streaming content
              setMessages((prev) => [
                ...prev,
                {
                  id: resultMsgId,
                  role: "assistant",
                  content: (
                    <MarkdownRenderer content={content} streaming={true} />
                  ),
                  isSearch: false,
                },
              ]);
            } else {
              // Update streaming message
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === resultMsgId
                    ? {
                        ...msg,
                        content: (
                          <MarkdownRenderer
                            content={content}
                            streaming={true}
                          />
                        ),
                      }
                    : msg
                )
              );
            }
          }

          // Capture final result
          if (event.type === "final-result") {
            finalContent = event.content;

            // Update the streaming message with final content and sources
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === resultMsgId
                  ? {
                      ...msg,
                      content: (
                        <div className="space-y-4">
                          <div className="prose prose-sm dark:prose-invert max-w-none">
                            <MarkdownRenderer content={finalContent} />
                          </div>
                          <CitationTooltip sources={event.sources || []} />

                          {/* Follow-up Questions */}
                          {event.followUpQuestions &&
                            event.followUpQuestions.length > 0 && (
                              <div className="mt-8 pt-6 border-t border-gray-200 dark:border-gray-700">
                                <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
                                  Follow-up questions
                                </h3>
                                <div className="space-y-2">
                                  {event.followUpQuestions.map(
                                    (question, index) => (
                                      <button
                                        key={index}
                                        onClick={() => {
                                          const evt = new CustomEvent(
                                            "followUpQuestion",
                                            {
                                              detail: { question },
                                              bubbles: true,
                                            }
                                          );
                                          document.dispatchEvent(evt);
                                        }}
                                        className="block w-full text-left px-4 py-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:border-orange-300 dark:hover:border-orange-700 hover:bg-orange-50 dark:hover:bg-orange-900/10 transition-colors group"
                                      >
                                        <div className="flex items-center justify-between">
                                          <span className="text-sm text-gray-700 dark:text-gray-300 group-hover:text-gray-900 dark:group-hover:text-gray-100">
                                            {question}
                                          </span>
                                          <svg
                                            className="w-4 h-4 text-gray-400 group-hover:text-orange-500 flex-shrink-0 ml-2"
                                            fill="none"
                                            stroke="currentColor"
                                            viewBox="0 0 24 24"
                                          >
                                            <path
                                              strokeLinecap="round"
                                              strokeLinejoin="round"
                                              strokeWidth={2}
                                              d="M9 5l7 7-7 7"
                                            />
                                          </svg>
                                        </div>
                                      </button>
                                    )
                                  )}
                                </div>
                              </div>
                            )}

                          {/* Sources */}
                          <SourcesList sources={event.sources || []} />
                        </div>
                      ),
                      searchResults: finalContent,
                    }
                  : msg
              )
            );
          }

          // Update research box with new events
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === assistantMsgId
                ? {
                    ...msg,
                    content: <SearchDisplay events={[...events]} />,
                    searchResults: finalContent,
                  }
                : msg
            )
          );
        }
      }
    } catch (error) {
      console.error("Search error:", error);
      // Remove the search display message
      setMessages((prev) => prev.filter((msg) => msg.id !== assistantMsgId));

      // Show error message to user
      const errorMessage =
        error instanceof Error
          ? error.message
          : "An error occurred during search";
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now().toString(),
          role: "assistant",
          content: (
            <div className="p-4 border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 rounded-lg">
              <p className="text-red-700 dark:text-red-300 font-medium">
                Search Error
              </p>
              <p className="text-red-600 dark:text-red-400 text-sm mt-1">
                {errorMessage}
              </p>
              {(errorMessage.includes("API key") ||
                errorMessage.includes("OPENAI_API_KEY")) && (
                <p className="text-red-600 dark:text-red-400 text-sm mt-2">
                  Please ensure all required API keys are set in your
                  environment variables:
                  <br />• OPENAI_API_KEY (for GPT-4o)
                  <br />• ANTHROPIC_API_KEY (optional, for Claude)
                  <br />• FIRECRAWL_API_KEY (can be provided via UI)
                </p>
              )}
            </div>
          ),
          isSearch: false,
        },
      ]);
    } finally {
      setIsSearching(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isSearching) return;
    setShowSuggestions(false);

    const userMessage = input;
    setInput("");

    // Check if we have API key
    if (!hasApiKey) {
      // Store the query and show modal
      setPendingQuery(userMessage);
      setShowApiKeyModal(true);

      // Still add user message to show what they asked
      const userMsgId = Date.now().toString();
      setMessages((prev) => [
        ...prev,
        {
          id: userMsgId,
          role: "user",
          content: userMessage,
          isSearch: true,
        },
      ]);
      return;
    }

    // Add user message
    const userMsgId = Date.now().toString();
    setMessages((prev) => [
      ...prev,
      {
        id: userMsgId,
        role: "user",
        content: userMessage,
        isSearch: true,
      },
    ]);

    // Perform the search
    await performSearch(userMessage);
  };

  return (
    <div className="flex flex-col flex-1">
      {messages.length === 0 ? (
        // Center input when no messages
        <div className="flex-1 flex items-center justify-center px-4 sm:px-6 lg:px-8">
          <div className="w-full max-w-4xl">
            <form onSubmit={handleSubmit}>
              <div className="relative">
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onFocus={() => {
                    if (!hasShownSuggestions && messages.length === 0) {
                      setShowSuggestions(true);
                      setHasShownSuggestions(true);
                    }
                  }}
                  onBlur={() =>
                    setTimeout(() => setShowSuggestions(false), 200)
                  }
                  placeholder="Enter query..."
                  className="w-full h-14 rounded-full border border-zinc-200 bg-white pl-6 pr-16 text-base ring-offset-white file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-zinc-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-950 dark:ring-offset-zinc-950 dark:placeholder:text-zinc-400 dark:focus-visible:ring-orange-400 shadow-sm"
                  disabled={isSearching}
                />
                <button
                  type="submit"
                  disabled={isSearching || !input.trim()}
                  className="absolute right-2 top-2 h-10 w-10 bg-orange-500 hover:bg-orange-600 text-white rounded-full disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-200 flex items-center justify-center"
                >
                  {isSearching ? (
                    <svg
                      className="w-5 h-5 animate-spin"
                      fill="none"
                      viewBox="0 0 24 24"
                    >
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      ></circle>
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                      ></path>
                    </svg>
                  ) : (
                    <svg
                      className="w-5 h-5"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                      />
                    </svg>
                  )}
                </button>

                {/* Suggestions dropdown - only show on initial load */}
                {showSuggestions && !input && messages.length === 0 && (
                  <div className="absolute top-full mt-2 w-full bg-white dark:bg-zinc-900 rounded-2xl shadow-lg border border-zinc-200 dark:border-zinc-800 overflow-hidden">
                    <div className="p-2">
                      <p className="text-xs text-gray-500 dark:text-gray-400 px-3 py-2 font-medium">
                        Try searching for:
                      </p>
                      {SUGGESTED_QUERIES.map((suggestion, index) => (
                        <button
                          key={index}
                          type="button"
                          onClick={() => handleSelectSuggestion(suggestion)}
                          className="w-full text-left px-3 py-2.5 hover:bg-gray-50 dark:hover:bg-zinc-800 rounded-lg transition-colors text-sm text-gray-700 dark:text-gray-300"
                        >
                          <div className="flex items-center gap-2">
                            <svg
                              className="w-4 h-4 text-gray-400"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                              />
                            </svg>
                            <span className="line-clamp-1">{suggestion}</span>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </form>
          </div>
        </div>
      ) : (
        <>
          {/* Messages */}
          <div className="flex-1 overflow-auto scrollbar-hide px-4 sm:px-6 lg:px-8 py-6">
            <div className="max-w-4xl mx-auto space-y-6">
              {messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`${
                    msg.role === "user" ? "flex justify-end" : "w-full"
                  }`}
                >
                  {msg.role === "user" ? (
                    <div className="max-w-2xl">
                      <span className="inline-block px-5 py-3 rounded-2xl bg-[#FBFAF9] dark:bg-zinc-800 text-[#36322F] dark:text-zinc-100">
                        {msg.content}
                      </span>
                    </div>
                  ) : (
                    <div className="w-full">{msg.content}</div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Input */}
          <div className="bg-white dark:bg-zinc-950 px-4 sm:px-6 lg:px-8 py-6">
            <form onSubmit={handleSubmit} className="max-w-4xl mx-auto">
              <div className="relative">
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onFocus={() => {
                    if (!hasShownSuggestions) {
                      setShowSuggestions(true);
                      setHasShownSuggestions(true);
                    }
                  }}
                  onBlur={() =>
                    setTimeout(() => setShowSuggestions(false), 200)
                  }
                  placeholder="Enter query..."
                  className="w-full h-14 rounded-full border border-zinc-200 bg-white pl-6 pr-16 text-base ring-offset-white file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-zinc-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-950 dark:ring-offset-zinc-950 dark:placeholder:text-zinc-400 dark:focus-visible:ring-orange-400 shadow-sm"
                  disabled={isSearching}
                />

                <button
                  type="submit"
                  disabled={!input.trim() || isSearching}
                  className="absolute right-2 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-orange-500 hover:bg-orange-600 disabled:bg-gray-300 disabled:cursor-not-allowed text-white flex items-center justify-center transition-colors shadow-sm"
                >
                  {isSearching ? (
                    <svg
                      className="animate-spin h-5 w-5"
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 24 24"
                    >
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      ></circle>
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                      ></path>
                    </svg>
                  ) : (
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <circle cx="11" cy="11" r="8" />
                      <path d="m21 21-4.35-4.35" />
                    </svg>
                  )}
                </button>

                {/* Suggestions dropdown - positioned to show above input */}
                {showSuggestions && !input && (
                  <div className="absolute bottom-full mb-2 w-full bg-white dark:bg-zinc-900 rounded-2xl shadow-lg border border-zinc-200 dark:border-zinc-800 overflow-hidden">
                    <div className="p-2">
                      <p className="text-xs text-gray-500 dark:text-gray-400 px-3 py-2 font-medium">
                        Try searching for:
                      </p>
                      {SUGGESTED_QUERIES.map((suggestion, index) => (
                        <button
                          key={index}
                          type="button"
                          onClick={() => handleSelectSuggestion(suggestion)}
                          className="w-full text-left px-3 py-2.5 hover:bg-gray-50 dark:hover:bg-zinc-800 rounded-lg transition-colors text-sm text-gray-700 dark:text-gray-300"
                        >
                          <div className="flex items-center gap-2">
                            <svg
                              className="w-4 h-4 text-gray-400"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                              />
                            </svg>
                            <span className="line-clamp-1">{suggestion}</span>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </form>
          </div>
        </>
      )}

      {/* API Key Modal */}
      <Dialog open={showApiKeyModal} onOpenChange={setShowApiKeyModal}>
        <DialogContent className="sm:max-w-[425px] bg-white dark:bg-gray-950 text-gray-900 dark:text-gray-100">
          <DialogHeader>
            <DialogTitle>Firecrawl API Key Required</DialogTitle>
            <DialogDescription>
              To use Firesearch, you need a Firecrawl API key. You can get one
              for free.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="space-y-2">
              <Button
                onClick={() =>
                  window.open(
                    "https://www.firecrawl.dev/app/api-keys",
                    "_blank"
                  )
                }
                className="w-full"
                variant="code"
              >
                Get your free API key from Firecrawl →
              </Button>
            </div>
            <div className="space-y-2">
              <label htmlFor="apiKey" className="text-sm font-medium">
                Enter your API key
              </label>
              <Input
                id="apiKey"
                type="password"
                value={firecrawlApiKey}
                onChange={(e) => setFirecrawlApiKey(e.target.value)}
                placeholder="fc-..."
                className="w-full"
              />
            </div>
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="code" onClick={() => setShowApiKeyModal(false)}>
              Cancel
            </Button>
            <Button
              variant="orange"
              onClick={saveApiKey}
              disabled={!firecrawlApiKey.trim()}
            >
              Save and Continue
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
