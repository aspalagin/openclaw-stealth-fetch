/** Diagnostic-only labels. Never apply these helpers to intentional page content. */
const LABELS = new Set([
  "auto", "http", "chrome", "camoufox", "jina", "firecrawl", "routing", "direct", "ru",
  "stopped", "idle", "busy", "running", "unknown", "ok", "success", "served", "hit", "cached", "error", "empty", "thin", "blocked",
  "cloudflare", "cloudflare-turnstile", "cloudflare-challenge", "cloudflare-block",
  "ddos-guard", "qrator", "servicepipe", "smartcaptcha", "yandex-smartcaptcha",
  "google", "google-sorry", "perimeterx", "datadome", "variti", "reddit", "ddg",
  "js-shell", "login-redirect", "akamai", "captcha", "challenge", "challenge-redirect",
  "access-denied", "network-security-block", "blocked-target", "egress-down",
  "invalid_target", "blocked_target", "proxy_route_unsupported", "response_body_too_large",
]);
export function diagnosticLabel(value: unknown, fallback = "unknown"): string {
  if (typeof value !== "string") return fallback;
  if (LABELS.has(value)) return value;
  const [prefix, detail, extra] = value.split(":");
  if (!extra && ["blocked", "empty", "prefer"].includes(prefix) && LABELS.has(detail)) return value;
  return value === "skipped:recent-block" ? value : fallback;
}
export function diagnosticReason(value: unknown): string {
  return value === "title" || value === "body" || value === "finalUrl" ? value : "detected";
}
export function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}
export function throwIfAbortedSafe(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}
/** Network exceptions and provider messages can contain signed URLs/credentials. */
export function transportFailure(): string { return "transport_failed"; }
