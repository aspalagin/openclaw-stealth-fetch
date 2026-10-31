/** Declarations for the public SDK subpath, which lacks declarations in OpenClaw 2026.10.5. */

declare module "openclaw/plugin-sdk/provider-web-fetch" {
  export const DEFAULT_CACHE_TTL_MINUTES: number;
  export function markdownToText(markdown: string): string;
  /** Обрезка по UTF-16-безопасной границе без маркера. */
  export function truncateText(value: string, maxChars: number): { text: string; truncated: boolean };
  export function resolvePositiveTimeoutSeconds(value: unknown, fallback: number): number;
  export function resolveCacheTtlMs(value: unknown, fallbackMinutes: number): number;
  export function normalizeCacheKey(value: string): string;
  export function readCache<T>(cache: Map<string, { value: T; expiresAt: number }>, key: string, ttlMs?: number): { value: T } | null;
  export function writeCache<T>(cache: Map<string, { value: T; expiresAt: number }>, key: string, value: T, ttlMs: number): void;
  export function readResponseText(response: Response, options?: { maxBytes?: number }): Promise<{ text: string; truncated: boolean; bytesRead: number }>;
  export function wrapExternalContent(content: string, options: { source: string; includeWarning?: boolean }): string;
  export function wrapWebContent(content: string, source?: "web_search" | "web_fetch"): string;
  export function jsonResult<T>(payload: T): { content: Array<{ type: "text"; text: string }>; details: T };
}
