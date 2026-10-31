import { throwIfAbortedSafe } from "./diagnostics.js";
/**
 * Ядро плагина: один стелс-запрос = SSRF-проверка → сайдкар → (опционально) keyless Firecrawl.
 * Общая для провайдера web_fetch и инструмента fetch_stealth.
 */

import { FirecrawlChallengeError, detectChallengePage } from "./challenge.js";
import { MAX_REQUEST_TIMEOUT_SECONDS, PLUGIN_VERSION, type StealthPluginConfig } from "./config.js";
import { FirecrawlKeylessError, firecrawlKeylessScrape } from "./firecrawl.js";
import {
  SidecarBlockedError,
  SidecarUnavailableError,
  abortReason,
  errorMessage,
  sidecarFetch,
  type SidecarClientOptions,
} from "./sidecar.js";
import { assertStealthTargetAllowed } from "./ssrf.js";
import type { Egress, ExtractMode, FetchLike, PluginLogger, SidecarFetchOk, SidecarLayer, StealthFetchResult, StealthMethod } from "./types.js";

export interface StealthDeps {
  logger?: PluginLogger;
  /** fetch для сайдкара (в тестах — реальный fetch на фейковый сервер). */
  fetchImpl?: FetchLike;
  /** fetch для Firecrawl (в тестах — мок). */
  firecrawlFetchImpl?: FetchLike;
  firecrawlEndpoint?: string;
  busyRetries?: number;
  busyRetryDelayMs?: number;
  clientTimeoutGraceMs?: number;
}

export interface StealthFetchParams {
  url: string;
  extractMode: ExtractMode;
  maxChars?: number;
  egress?: Egress;
  method?: StealthMethod;
  noCache?: boolean;
}

const WARNING_MAX_CHARS = 400;
const OK_RESULTS = new Set(["ok", "success", "served", "hit", "cached"]);

export const silentLogger: PluginLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

/** Короткое предупреждение о пройденных слоях каскада и смене egress; undefined, если всё прошло с первого слоя. */
export function buildCascadeWarning(ok: SidecarFetchOk, requestedEgress: Egress): string | undefined {
  const notes: string[] = [];
  const failed = ok.layers.filter((layer, index) => index < ok.layers.length - 1 || !OK_RESULTS.has(layer.result.toLowerCase()))
    .filter((layer) => !(layer.method === ok.method && layer.egress === ok.egress && OK_RESULTS.has(layer.result.toLowerCase())));
  if (failed.length > 0) {
    notes.push(
      `cascade: ${failed
        .slice(0, 4)
        .map((layer: SidecarLayer) => `${layer.method}:${layer.egress}=${layer.result}`)
        .join(", ")}${failed.length > 4 ? ", …" : ""}; served by ${ok.method}:${ok.egress}`,
    );
  }
  if (requestedEgress !== "auto" && ok.egress && ok.egress !== requestedEgress) {
    notes.push(`egress fallback: requested ${requestedEgress}, used ${ok.egress}`);
  }
  if (notes.length === 0) {
    return undefined;
  }
  const text = `stealth ${notes.join("; ")}`;
  return text.length > WARNING_MAX_CHARS ? `${text.slice(0, WARNING_MAX_CHARS - 1)}…` : text;
}

function toResult(ok: SidecarFetchOk, requestedEgress: Egress): StealthFetchResult {
  const warning = buildCascadeWarning(ok, requestedEgress);
  return {
    url: ok.url,
    finalUrl: ok.finalUrl,
    status: ok.status,
    ...(ok.title ? { title: ok.title } : {}),
    ...(ok.contentType ? { contentType: ok.contentType } : {}),
    extractor: `stealth:${ok.method}:${ok.egress}`,
    method: ok.method,
    egress: ok.egress,
    text: ok.text,
    rawLength: ok.rawLength,
    truncated: ok.truncated,
    tookMs: ok.tookMs,
    ...(ok.cached !== undefined ? { cached: ok.cached } : {}),
    ...(warning ? { warning } : {}),
    layers: ok.layers,
  };
}

async function firecrawlFallback(
  params: StealthFetchParams,
  cfg: StealthPluginConfig,
  deps: StealthDeps,
  signal: AbortSignal | undefined,
  reason: string,
): Promise<StealthFetchResult> {
  const logger = deps.logger ?? silentLogger;
  const startedAt = Date.now();
  logger.warn(`[stealth-fetch] v${PLUGIN_VERSION} ${reason}; trying keyless Firecrawl `);
  const result = await firecrawlKeylessScrape({
    url: params.url,
    extractMode: params.extractMode,
    noCache: params.noCache,
    timeoutSeconds: Math.min(cfg.sidecarTimeoutSeconds, 60),
    signal,
    fetchImpl: deps.firecrawlFetchImpl,
    endpoint: deps.firecrawlEndpoint,
  });
  // Firecrawl без ключа отдаёт 200 и на странице капчи — такой «успех» откатом не считается.
  const challenge = detectChallengePage({ finalUrl: result.finalUrl, title: result.title, text: result.text });
  if (challenge) {
    logger.warn(`[stealth-fetch] v${PLUGIN_VERSION} Firecrawl fallback  is a challenge page: ${challenge.protection} (${challenge.reason})`);
    throw new FirecrawlChallengeError(challenge);
  }
  const warning = `${reason}; served by keyless Firecrawl${result.warning ? ` (${result.warning})` : ""}`;
  return {
    url: result.url,
    finalUrl: result.finalUrl,
    status: result.status,
    ...(result.title ? { title: result.title } : {}),
    extractor: "stealth:firecrawl",
    method: "firecrawl",
    egress: "firecrawl",
    text: result.text,
    rawLength: result.rawLength,
    truncated: false,
    tookMs: Date.now() - startedAt,
    warning: warning.length > WARNING_MAX_CHARS ? `${warning.slice(0, WARNING_MAX_CHARS - 1)}…` : warning,
    fallback: "firecrawl",
  };
}

/** Текст для хвоста ошибки: заглушка от Firecrawl либо техническая ошибка отката. */
function describeFallbackFailure(err: unknown): string {
  if (err instanceof FirecrawlChallengeError) {
    return err.message;
  }
  const detail = err instanceof FirecrawlKeylessError ? err.message : errorMessage(err);
  return `Firecrawl fallback failed: ${detail}`;
}

/**
 * Выполняет стелс-загрузку. Бросает:
 *  - SsrFBlockedError / Error("Invalid URL") — до обращения к сайдкару;
 *  - SidecarBlockedError ("Stealth fetch blocked by <protection>: <error>[; Firecrawl fallback returned a challenge page (<protection2>; …)]")
 *    — каскад не пробил, откат выключен / упал / вернул страницу капчи;
 *  - SidecarUnavailableError ("stealth-fetch sidecar unavailable (systemctl status stealth-fetch): …");
 *  - abort reason, если сработал signal.
 */
export async function runStealthFetch(
  params: StealthFetchParams,
  cfg: StealthPluginConfig,
  deps: StealthDeps = {},
  signal?: AbortSignal,
): Promise<StealthFetchResult> {
  throwIfAbortedSafe(signal);
  const egress = params.egress ?? cfg.defaultEgress;
  // The public release has no supported proxy route. Reject outside the
  // fallback catch so neither the sidecar nor hosted readers receive the URL.
  if (egress === "ru") {
    throw new Error("proxy_route_unsupported");
  }
  const target = assertStealthTargetAllowed(params.url);
  const logger = deps.logger ?? silentLogger;
  const client: SidecarClientOptions = {
    baseUrl: cfg.sidecarBaseUrl,
    fetchImpl: deps.fetchImpl,
    logger,
    signal,
    busyRetries: deps.busyRetries,
    busyRetryDelayMs: deps.busyRetryDelayMs,
    clientTimeoutGraceMs: deps.clientTimeoutGraceMs,
  };
  const request = {
    url: target.toString(),
    extractMode: params.extractMode,
    ...(params.maxChars !== undefined ? { maxChars: params.maxChars } : {}),
    egress,
    method: params.method ?? "auto",
    timeoutSeconds: Math.min(cfg.sidecarTimeoutSeconds, MAX_REQUEST_TIMEOUT_SECONDS),
    ...(params.noCache ? { noCache: true } : {}),
  };

  try {
    const ok = await sidecarFetch(request, client);
    const result = toResult(ok, egress);
    logger.info(
      `[stealth-fetch] v${PLUGIN_VERSION} ${result.extractor} status=${result.status} chars=${result.rawLength} tookMs=${result.tookMs}${result.cached ? " cached" : ""}`,
    );
    return result;
  } catch (err) {
    if (signal?.aborted) {
      throw abortReason(signal);
    }
    if (err instanceof SidecarBlockedError) {
      const reason = `stealth cascade blocked by ${err.protection}${err.layers.length ? ` (${err.layers.map((l) => `${l.method}:${l.egress}=${l.result}`).slice(0, 4).join(", ")})` : ""}`;
      if (!cfg.firecrawlFallback) {
        logger.warn(`[stealth-fetch] v${PLUGIN_VERSION} ${err.message}`);
        throw err;
      }
      try {
        return await firecrawlFallback(params, cfg, deps, signal, reason);
      } catch (fallbackErr) {
        if (signal?.aborted) {
          throw abortReason(signal);
        }
        const detail = describeFallbackFailure(fallbackErr);
        logger.warn(`[stealth-fetch] v${PLUGIN_VERSION} ${err.message}; ${detail}`);
        throw new SidecarBlockedError({
          ok: false,
          url: params.url,
          protection: err.protection,
          error: `${err.detail}; ${detail}`,
          layers: err.layers,
          status: err.status,
          finalUrl: err.finalUrl,
          tookMs: err.tookMs,
        }, fallbackErr instanceof FirecrawlChallengeError ? fallbackErr : "firecrawl_failed");
      }
    }
    if (err instanceof SidecarUnavailableError) {
      const unavailable = new SidecarUnavailableError(
        `stealth-fetch sidecar unavailable (systemctl status stealth-fetch): ${err.message}`,
        { cause: err },
      );
      if (!cfg.firecrawlFallback) {
        logger.warn(`[stealth-fetch] v${PLUGIN_VERSION} ${unavailable.message}`);
        throw unavailable;
      }
      try {
        return await firecrawlFallback(params, cfg, deps, signal, "stealth-fetch sidecar unavailable");
      } catch (fallbackErr) {
        if (signal?.aborted) {
          throw abortReason(signal);
        }
        const detail = describeFallbackFailure(fallbackErr);
        logger.warn(`[stealth-fetch] v${PLUGIN_VERSION} ${unavailable.message}; ${detail}`);
        throw new SidecarUnavailableError(`${unavailable.message}; ${detail}`, { cause: err });
      }
    }
    throw err;
  }
}
