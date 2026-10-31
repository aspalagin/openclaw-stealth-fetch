/** Keyless Firecrawl API adapter; external URL disclosure requires explicit opt-in.
 * Adapted request contract: OpenClaw v2026.10.5 Firecrawl plugin (see notices).
 */
import { markdownToText } from "openclaw/plugin-sdk/provider-web-fetch";
import { abortError, throwIfAbortedSafe } from "./diagnostics.js";
import { readBoundedText, ResponseLimitError } from "./streams.js";
import type { ExtractMode, FetchLike } from "./types.js";

export const FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v2/scrape";
export const FIRECRAWL_DEFAULT_TIMEOUT_SECONDS = 60;
export const FIRECRAWL_DEFAULT_MAX_AGE_MS = 172_800_000;
export const FIRECRAWL_MAX_RESPONSE_BYTES = 8_000_000;

export class FirecrawlKeylessError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "FirecrawlKeylessError";
    this.status = status;
  }
}
export interface FirecrawlKeylessParams {
  url: string;
  extractMode: ExtractMode;
  noCache?: boolean;
  timeoutSeconds?: number;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
  /** Dependency injection for local tests, not exposed as tool input. */
  endpoint?: string;
}
export interface FirecrawlKeylessResult {
  url: string; finalUrl: string; status: number; title?: string;
  text: string; rawLength: number; tookMs: number; warning?: string;
}
export function buildFirecrawlScrapeBody(url: string, timeoutSeconds: number, noCache = false): Record<string, unknown> {
  return { url, formats: ["markdown"], onlyMainContent: true, timeout: timeoutSeconds * 1000,
    maxAge: noCache ? 0 : FIRECRAWL_DEFAULT_MAX_AGE_MS, proxy: "auto", storeInCache: !noCache };
}
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function normalizeResultUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) ? url.href : undefined; }
  catch { return undefined; }
}
export async function firecrawlKeylessScrape(params: FirecrawlKeylessParams): Promise<FirecrawlKeylessResult> {
  throwIfAbortedSafe(params.signal);
  const fetchImpl = params.fetchImpl ?? fetch;
  const timeoutSeconds = params.timeoutSeconds && params.timeoutSeconds > 0 ? Math.floor(params.timeoutSeconds) : FIRECRAWL_DEFAULT_TIMEOUT_SECONDS;
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), (timeoutSeconds + 10) * 1000);
  const onAbort = () => controller.abort();
  params.signal?.addEventListener("abort", onAbort, { once: true });
  let response: Response;
  let rawText: string;
  try {
    response = await fetchImpl(params.endpoint ?? FIRECRAWL_SCRAPE_URL, {
      method: "POST", redirect: "error", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildFirecrawlScrapeBody(params.url, timeoutSeconds, params.noCache)), signal: controller.signal,
    });
    rawText = await readBoundedText(response, FIRECRAWL_MAX_RESPONSE_BYTES, () => controller.abort());
  } catch (err) {
    if (params.signal?.aborted) throw abortError();
    throw new FirecrawlKeylessError(err instanceof ResponseLimitError ? "Firecrawl response_body_too_large" : "Firecrawl request failed");
  } finally {
    clearTimeout(timer);
    params.signal?.removeEventListener("abort", onAbort);
  }
  throwIfAbortedSafe(params.signal);
  // Never include provider response/statusText/exception snippets in diagnostics.
  if (!response.ok) throw new FirecrawlKeylessError("Firecrawl API error (" + response.status + ")", response.status);
  let payload: Record<string, unknown> | undefined;
  try { payload = asRecord(JSON.parse(rawText)); } catch { /* fixed error below */ }
  if (!payload) throw new FirecrawlKeylessError("Firecrawl returned invalid JSON");
  if (payload.success === false) throw new FirecrawlKeylessError("Firecrawl fetch failed", response.status);
  const data = asRecord(payload.data) ?? {};
  const metadata = asRecord(data.metadata);
  const rawStatus = metadata?.statusCode ?? data.statusCode;
  const status = typeof rawStatus === "number" && Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599 ? rawStatus : 200;
  if (status < 200 || status >= 300) throw new FirecrawlKeylessError("Firecrawl target HTTP error (" + status + ")", status);
  const markdown = (typeof data.markdown === "string" && data.markdown) || (typeof data.content === "string" && data.content) || "";
  if (!markdown) throw new FirecrawlKeylessError("Firecrawl scrape returned no content.");
  const text = params.extractMode === "text" ? markdownToText(markdown) : markdown;
  return {
    url: params.url, finalUrl: normalizeResultUrl(metadata?.sourceURL) ?? normalizeResultUrl(data.url) ?? params.url,
    status, ...(typeof metadata?.title === "string" && metadata.title ? { title: metadata.title } : {}),
    text, rawLength: text.length, tookMs: Date.now() - startedAt,
    ...(payload.warning ? { warning: "external_provider_warning" } : {}),
  };
}
