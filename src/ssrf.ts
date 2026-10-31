/**
 * Проверка целевого URL до обращения к сайдкару: только http(s), без заблокированных хостов и
 * приватных/служебных IP (SDK ssrf-runtime, та же проверка, что у официального Firecrawl-плагина).
 * DNS-резолв здесь не делается: его выполняет сайдкар (403 на SSRF) и ядро web_fetch.
 */

import { SsrFBlockedError, isBlockedHostnameOrIp } from "openclaw/plugin-sdk/ssrf-runtime";

export { SsrFBlockedError };

export function assertStealthTargetAllowed(rawUrl: unknown): URL {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    throw new Error("url is required");
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error("Invalid URL");
  }
  if (parsed.username || parsed.password) {
    throw new SsrFBlockedError("Blocked credentials in target URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SsrFBlockedError(`Blocked non-HTTP(S) protocol in stealth fetch URL`);
  }
  if (isBlockedHostnameOrIp(parsed.hostname)) {
    throw new SsrFBlockedError(`Blocked hostname or private/internal IP in stealth fetch URL`);
  }
  return parsed;
}
