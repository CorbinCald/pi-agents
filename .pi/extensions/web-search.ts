import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type BraveSearchResult = {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
  profile?: {
    name?: string;
    url?: string;
  };
};

type BraveSearchResponse = {
  web?: {
    results?: BraveSearchResult[];
  };
};

const SEARCH_MAX_COUNT = 5;
const FETCH_DEFAULT_MAX_CHARS = 6000;
const FETCH_MAX_CHARS = 20000;
const REQUEST_BUFFER_MS = 500;

let nextRequestAt = 0;

function clamp(value: number | undefined, defaultValue: number, min: number, max: number) {
  return Math.min(Math.max(value ?? defaultValue, min), max);
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForRequestBuffer() {
  const now = Date.now();
  const waitMs = Math.max(0, nextRequestAt - now);
  nextRequestAt = Math.max(now, nextRequestAt) + REQUEST_BUFFER_MS;

  if (waitMs > 0) await wait(waitMs);
}

async function bufferedFetch(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) {
  await waitForRequestBuffer();
  return fetch(input, init);
}

function getMarkdownTextVariant(input: string) {
  const url = new URL(input);
  if (/\.(md|md\.txt|txt)$/i.test(url.pathname)) return undefined;
  if (url.pathname.endsWith("/")) return undefined;
  url.pathname = `${url.pathname}.md.txt`;
  return url.toString();
}

function isCleanTextContent(contentType: string) {
  const lower = contentType.toLowerCase();
  return (
    lower.includes("text/plain") ||
    lower.includes("text/markdown") ||
    lower.includes("application/markdown") ||
    lower.includes("application/x-markdown")
  );
}

function decodeHtmlEntities(text: string) {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };

  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#x")) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    if (lower.startsWith("#")) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
    return named[lower] ?? match;
  });
}

function sanitizeText(text: string) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+$/gm, "")
    .replace(/^[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function htmlToText(html: string) {
  return sanitizeText(
    decodeHtmlEntities(
      html
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
        .replace(/<head[\s\S]*?<\/head>/gi, "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|section|article|header|footer|main|nav|aside|h[1-6]|li|tr)>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/[ \t]+/g, " ")
        .replace(/\n[ \t]+/g, "\n")
        .trim(),
    ),
  );
}

function truncate(text: string, maxChars: number) {
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: `${text.slice(0, maxChars)}\n\n[Output truncated to ${maxChars} characters.]`,
    truncated: true,
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web using the Brave Search API for URL discovery.",
    promptSnippet: "Search the web to discover relevant URLs for current or external information.",
    promptGuidelines: [
      "Use web_search for URL discovery. For URL content retrieval, use web_fetch instead.",
      "Use web_search when the user asks for current information, recent events, third-party docs, or anything likely to require internet lookup.",
      "Keep web_search count at 5 or less; use the default unless more is necessary.",
      "After using web_search, cite relevant URLs from the results.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      count: Type.Optional(
        Type.Number({
          description: "Number of results to return, between 1 and 5",
          minimum: 1,
          maximum: SEARCH_MAX_COUNT,
          default: SEARCH_MAX_COUNT,
        }),
      ),
    }),

    async execute(_toolCallId, params, signal) {
      const apiKey = process.env.BRAVE_API_KEY;
      if (!apiKey) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: "BRAVE_API_KEY is not set. Get an API key from https://api.search.brave.com/ and export BRAVE_API_KEY.",
            },
          ],
        };
      }

      const count = clamp(params.count, SEARCH_MAX_COUNT, 1, SEARCH_MAX_COUNT);
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", params.query);
      url.searchParams.set("count", String(count));

      const response = await bufferedFetch(url, {
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": apiKey,
        },
        signal,
      });

      if (!response.ok) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Brave Search failed: ${response.status} ${response.statusText}\n${await response.text()}`,
            },
          ],
        };
      }

      const json = (await response.json()) as BraveSearchResponse;
      const results = json.web?.results ?? [];

      if (results.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No search results found." }],
          details: json,
        };
      }

      const text = results
        .map((result, index) =>
          [
            `${index + 1}. ${result.title ?? "Untitled"}`,
            result.url ? `URL: ${result.url}` : undefined,
            result.description ? `Snippet: ${result.description}` : undefined,
          ]
            .filter(Boolean)
            .join("\n"),
        )
        .join("\n\n");

      return {
        content: [{ type: "text" as const, text }],
        details: { query: params.query, results },
      };
    },
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: "Fetch and extract content from a known URL.",
    promptSnippet: "Fetch a URL, preferring clean markdown/text over raw HTML.",
    promptGuidelines: [
      "Use web_fetch to verify or quote content from URLs found by web_search.",
      "Use web_fetch with extractText=true (default) to avoid HTML dumps; prefer .md.txt or clean text when available.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "URL to fetch" }),
      extractText: Type.Optional(
        Type.Boolean({
          description: "When true, prefer .md.txt/text variants and extract readable text from HTML. Defaults to true.",
          default: true,
        }),
      ),
      maxChars: Type.Optional(
        Type.Number({
          description: "Maximum characters to return, between 1000 and 20000. Defaults to 6000.",
          minimum: 1000,
          maximum: FETCH_MAX_CHARS,
          default: FETCH_DEFAULT_MAX_CHARS,
        }),
      ),
    }),

    async execute(_toolCallId, params, signal) {
      const extractText = params.extractText ?? true;
      const maxChars = clamp(params.maxChars, FETCH_DEFAULT_MAX_CHARS, 1000, FETCH_MAX_CHARS);
      const candidates = extractText ? [getMarkdownTextVariant(params.url), params.url].filter(Boolean) : [params.url];

      let lastError = "";
      for (const candidate of candidates) {
        const response = await bufferedFetch(candidate!, {
          headers: { Accept: extractText ? "text/markdown,text/plain,text/html,*/*" : "*/*" },
          signal,
        });

        if (!response.ok) {
          lastError = `${response.status} ${response.statusText}`;
          continue;
        }

        const contentType = response.headers.get("content-type") ?? "";
        const raw = await response.text();
        const usedTextVariant = candidate !== params.url;

        if (usedTextVariant && !isCleanTextContent(contentType)) continue;

        const body = extractText
          ? contentType.toLowerCase().includes("text/html")
            ? htmlToText(raw)
            : sanitizeText(raw)
          : raw.trim();
        const truncated = truncate(body, maxChars);
        const header = [
          `Fetched: ${response.url}`,
          usedTextVariant ? `Text variant of: ${params.url}` : undefined,
          contentType ? `Content-Type: ${contentType}` : undefined,
        ]
          .filter(Boolean)
          .join("\n");

        return {
          content: [{ type: "text" as const, text: `${header}\n\n${truncated.text}` }],
          details: {
            url: params.url,
            fetchedUrl: response.url,
            contentType,
            extractText,
            truncated: truncated.truncated,
          },
        };
      }

      return {
        isError: true,
        content: [{ type: "text" as const, text: `Failed to fetch ${params.url}${lastError ? `: ${lastError}` : ""}` }],
      };
    },
  });
}
