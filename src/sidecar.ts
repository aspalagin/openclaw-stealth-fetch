import { diagnosticLabel, diagnosticReason, abortError } from "./diagnostics.js";
import { readBoundedText, ResponseLimitError } from "./streams.js";
/**
 * HTTP-клиент сайдкара stealth-fetch (POST /fetch, GET /health).
 *
 * Классификация исходов:
 *  - SidecarFetchOk            — 200 ok:true;
 *  - SidecarBlockedError       — 200 ok:false (каскад не пробил защиту) → кандидат на Firecrawl-откат;
 *  - SidecarUnavailableError   — ECONNREFUSED/таймаут/5xx/503 busy после повторов/битый JSON → кандидат на откат;
 *  - SidecarRequestError       — 400 (невалидный URL), без отката;
 *  - SsrFBlockedError          — 403 (SSRF-блок сайдкара), без отката;
 *  - abort reason              — внешний AbortSignal сработал.
 */

import { SsrFBlockedError } from "openclaw/plugin-sdk/ssrf-runtime";
import type { FetchLike, PluginLogger, SidecarFetchBlocked, SidecarFetchOk, SidecarFetchRequest, SidecarHealth, SidecarLayer } from "./types.js";

export const DEFAULT_BUSY_RETRIES = 2;
export const DEFAULT_BUSY_RETRY_DELAY_MS = 3_000;
/** Запас клиентского таймаута поверх timeoutSeconds, который исполняет сам сайдкар. */
export const DEFAULT_CLIENT_TIMEOUT_GRACE_MS = 15_000;
export const DEFAULT_REQUEST_TIMEOUT_SECONDS = 90;
/** Ответ сайдкара читаем целиком, но ограничиваем на случай ошибки в нём. */
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const ERROR_DETAIL_MAX_CHARS = 600;

export class SidecarUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "SidecarUnavailableError";
  }
}

export class SidecarBlockedError extends Error {
  readonly protection: string;
  readonly detail: string;
  readonly layers: SidecarLayer[];
  readonly status?: number;
  readonly finalUrl?: string;
  readonly tookMs?: number;
  constructor(payload: SidecarFetchBlocked, fallback?: { protection: string; reason: string } | "firecrawl_failed") {
    const protection = cleanLabel(payload.protection) || "unknown";
    let detail = "cascade_exhausted";
    if (fallback === "firecrawl_failed") detail += "; Firecrawl fallback failed";
    else if (fallback) detail += "; Firecrawl fallback returned a challenge page (" + diagnosticLabel(fallback.protection) + "; " + diagnosticReason(fallback.reason) + ")";
    super(`Stealth fetch blocked by ${protection}: ${detail}`);
    this.name = "SidecarBlockedError";
    this.protection = protection;
    this.detail = detail;
    this.layers = safeLayers(payload.layers);
    this.status = typeof payload.status === "number" ? payload.status : undefined;
    this.finalUrl = undefined;
    this.tookMs = typeof payload.tookMs === "number" ? payload.tookMs : undefined;
  }
}

export class SidecarRequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "SidecarRequestError";
    this.status = status;
  }
}

export interface SidecarClientOptions {
  baseUrl: string;
  fetchImpl?: FetchLike;
  logger?: PluginLogger;
  signal?: AbortSignal;
  busyRetries?: number;
  busyRetryDelayMs?: number;
  clientTimeoutGraceMs?: number;
}

export function errorMessage(_err: unknown): string { return "transport_failed"; }
export function abortReason(_signal: AbortSignal): Error { return abortError(); }
function cleanLabel(value: unknown): string { return diagnosticLabel(value); }
function safeLayers(value: unknown): SidecarLayer[] {
  return Array.isArray(value) ? value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    return [{ method: cleanLabel(item.method), egress: cleanLabel(item.egress), result: cleanLabel(item.result),
      ...(typeof item.tookMs === "number" && Number.isFinite(item.tookMs) ? { tookMs: item.tookMs } : {}) }];
  }) : [];
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(abortReason(signal as AbortSignal));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Один HTTP-вызов с клиентским таймаутом и пробросом внешнего AbortSignal. */
async function fetchWithDeadline(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ response: Response; rawText: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`sidecar did not answer within ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
  const onAbort = () => controller.abort(signal ? abortReason(signal) : new Error("aborted"));
  if (signal?.aborted) {
    onAbort();
  } else {
    signal?.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    if (response.status === 503) {
      try { await response.body?.cancel(); } catch { /* no diagnostic echo */ }
      return { response, rawText: "" };
    }
    const rawText = await readBoundedText(response, MAX_RESPONSE_BYTES, () => controller.abort());
    return { response, rawText };
  } catch (err) {
    if (signal?.aborted) throw abortError();
    throw new SidecarUnavailableError(err instanceof ResponseLimitError ? "sidecar response_body_too_large" : "sidecar transport_failed");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

function normalizeOk(payload: Record<string, unknown>, request: SidecarFetchRequest): SidecarFetchOk {
  const text = typeof payload.text === "string" ? payload.text : "";
  const layers = Array.isArray(payload.layers)
    ? (payload.layers as unknown[]).flatMap((layer) => {
        if (!layer || typeof layer !== "object") {
          return [];
        }
        const record = layer as Record<string, unknown>;
        return [
          {
            method: cleanLabel(record.method) || "?",
            egress: cleanLabel(record.egress) || "?",
            result: cleanLabel(record.result) || "?",
            ...(typeof record.tookMs === "number" ? { tookMs: record.tookMs } : {}),
          } satisfies SidecarLayer,
        ];
      })
    : [];
  return {
    ok: true,
    url: typeof payload.url === "string" ? payload.url : request.url,
    finalUrl: typeof payload.finalUrl === "string" && payload.finalUrl ? payload.finalUrl : request.url,
    status: typeof payload.status === "number" && Number.isFinite(payload.status) ? Math.floor(payload.status) : 200,
    ...(typeof payload.title === "string" && payload.title ? { title: payload.title } : {}),
    ...(typeof payload.contentType === "string" && payload.contentType ? { contentType: payload.contentType } : {}),
    method: cleanLabel(payload.method) || request.method,
    egress: cleanLabel(payload.egress) || request.egress,
    ...(typeof payload.extractor === "string" && payload.extractor ? { extractor: payload.extractor } : {}),
    text,
    rawLength: typeof payload.rawLength === "number" && Number.isFinite(payload.rawLength) ? Math.max(0, Math.floor(payload.rawLength)) : text.length,
    truncated: payload.truncated === true,
    tookMs: typeof payload.tookMs === "number" && Number.isFinite(payload.tookMs) ? Math.max(0, Math.floor(payload.tookMs)) : 0,
    ...(typeof payload.cached === "boolean" ? { cached: payload.cached } : {}),
    layers,
  };
}

/** POST /fetch с повторами на 503 busy. */
export async function sidecarFetch(request: SidecarFetchRequest, options: SidecarClientOptions): Promise<SidecarFetchOk> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const busyRetries = options.busyRetries ?? DEFAULT_BUSY_RETRIES;
  const busyRetryDelayMs = options.busyRetryDelayMs ?? DEFAULT_BUSY_RETRY_DELAY_MS;
  const grace = options.clientTimeoutGraceMs ?? DEFAULT_CLIENT_TIMEOUT_GRACE_MS;
  const timeoutMs = (request.timeoutSeconds ?? DEFAULT_REQUEST_TIMEOUT_SECONDS) * 1000 + grace;
  const endpoint = `${options.baseUrl}/fetch`;
  const body = JSON.stringify(request);

  for (let attempt = 0; ; attempt += 1) {
    if (options.signal?.aborted) {
      throw abortReason(options.signal);
    }
    let response: Response;
    let rawText: string;
    try {
      ({ response, rawText } = await fetchWithDeadline(
        fetchImpl,
        endpoint,
        {
          method: "POST",
          redirect: "error",
          headers: { "content-type": "application/json", accept: "application/json" },
          body,
        },
        timeoutMs,
        options.signal,
      ));
    } catch (err) {
      if (options.signal?.aborted) {
        throw abortReason(options.signal);
      }
      if (err instanceof SidecarUnavailableError) throw err;
      throw new SidecarUnavailableError("sidecar transport_failed");
    }

    if (response.status === 503) {
      if (attempt < busyRetries) {
        options.logger?.debug?.(`[stealth-fetch] sidecar busy (503), retry ${attempt + 1}/${busyRetries} in ${busyRetryDelayMs} ms`);
        await sleep(busyRetryDelayMs, options.signal);
        continue;
      }
      throw new SidecarUnavailableError(`sidecar: busy (503) after ${busyRetries + 1} attempts`);
    }

    if (options.signal?.aborted) {
      throw abortReason(options.signal);
    }
    let payload: Record<string, unknown> | undefined;
    try {
      const parsed: unknown = JSON.parse(rawText);
      payload = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
    } catch {
      payload = undefined;
    }
    const detail = diagnosticLabel(payload?.error, "sidecar_request_failed");

    if (response.status === 400) {
      throw new SidecarRequestError(400, `Stealth fetch rejected the URL: ${detail}`);
    }
    if (response.status === 403) {
      throw new SsrFBlockedError(`Stealth fetch sidecar blocked the target (SSRF policy): ${detail}`);
    }
    if (!response.ok) {
      throw new SidecarUnavailableError(`sidecar: HTTP ${response.status}: ${detail}`);
    }
    if (!payload) {
      throw new SidecarUnavailableError(`sidecar: invalid JSON in response`);
    }
    if (payload.ok === true) {
      return normalizeOk(payload, request);
    }
    if (payload.ok === false) {
      throw new SidecarBlockedError({
        ok: false,
        url: typeof payload.url === "string" ? payload.url : request.url,
        finalUrl: typeof payload.finalUrl === "string" ? payload.finalUrl : undefined,
        status: typeof payload.status === "number" ? payload.status : undefined,
        protection: typeof payload.protection === "string" ? payload.protection : undefined,
        error: typeof payload.error === "string" ? payload.error : undefined,
        layers: Array.isArray(payload.layers) ? (payload.layers as SidecarLayer[]) : [],
        tookMs: typeof payload.tookMs === "number" ? payload.tookMs : undefined,
      });
    }
    throw new SidecarUnavailableError(`sidecar: unexpected payload (no "ok" field)`);
  }
}

/** GET /health; бросает SidecarUnavailableError, если сайдкар не отвечает. */
export async function sidecarHealth(options: Omit<SidecarClientOptions, "busyRetries" | "busyRetryDelayMs">): Promise<SidecarHealth> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = `${options.baseUrl}/health`;
  let response: Response;
  let text: string;
  try {
    ({ response, rawText: text } = await fetchWithDeadline(fetchImpl, endpoint, { method: "GET", redirect: "error", headers: { accept: "application/json" } }, 5_000, options.signal));
  } catch (err) {
    if (options.signal?.aborted) {
      throw abortReason(options.signal);
    }
    if (err instanceof SidecarUnavailableError) throw err;
    throw new SidecarUnavailableError("sidecar transport_failed");
  }
  if (!response.ok) {
    throw new SidecarUnavailableError(`sidecar: HTTP ${response.status}`);
  }
  try {
    const value = JSON.parse(text);
    return { ok: value?.ok === true,
      ...(typeof value?.version === "string" && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(value.version) ? { version: value.version } : {}),
      browsers: { chrome: diagnosticLabel(value?.browsers?.chrome), camoufox: diagnosticLabel(value?.browsers?.camoufox) },
      egress: { ru: { up: value?.egress?.ru?.up === true } },
    };
  } catch {
    throw new SidecarUnavailableError(`sidecar: invalid JSON`);
  }
}
