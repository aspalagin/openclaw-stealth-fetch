/**
 * Конфигурация плагина: plugins.entries.openclaw-stealth-fetch.config.
 *
 * Источник значений: живой конфиг OpenClaw (ctx.config) → снимок pluginConfig из register(api) → дефолты.
 * sidecar.baseUrl принимается только с loopback-хостом: сайдкар — локальный процесс, и отправлять ему URL
 * по сети (или подменить его чужим сервисом через конфиг) нельзя.
 */

import { isLoopbackHost } from "openclaw/plugin-sdk/ssrf-runtime";
import { EGRESS_VALUES, type Egress } from "./types.js";

export const PLUGIN_ID = "openclaw-stealth-fetch";
/** Держать в синхроне с package.json / openclaw.plugin.json. Версию реально исполняемого пути подтверждает лог вызова, не регистрации. */
export const PLUGIN_VERSION = "0.1.2";
export const PROVIDER_ID = "stealth";
export const TOOL_NAME = "fetch_stealth";

export const DEFAULT_SIDECAR_BASE_URL = "http://127.0.0.1:18801";
export const DEFAULT_SIDECAR_TIMEOUT_SECONDS = 90;
/** Верхняя граница sidecar.timeoutSeconds в конфиге. */
export const MAX_SIDECAR_TIMEOUT_SECONDS = 120;
/** Верхняя граница timeoutSeconds, который реально отправляется сайдкару. */
export const MAX_REQUEST_TIMEOUT_SECONDS = 110;
export const MIN_SIDECAR_TIMEOUT_SECONDS = 5;
/** Дефолт maxChars для fetch_stealth, если tools.web.fetch.maxChars не задан. */
export const DEFAULT_TOOL_MAX_CHARS = 50_000;

export class StealthConfigError extends Error {
  constructor(message: string) {
    super(`[${PLUGIN_ID}] ${message}`);
    this.name = "StealthConfigError";
  }
}

export interface StealthPluginConfig {
  /** Нормализованный origin сайдкара без завершающего слэша, например http://127.0.0.1:18801 */
  sidecarBaseUrl: string;
  sidecarTimeoutSeconds: number;
  firecrawlFallback: boolean;
  defaultEgress: Egress;
}

export interface ConfigSources {
  /** Полный конфиг OpenClaw (ctx.config / api.config). */
  config?: unknown;
  /** plugins.entries.<id>.config, как передано в register(api). */
  pluginConfig?: Record<string, unknown>;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** plugins.entries.<pluginId>.config из полного конфига OpenClaw. */
export function pluginEntryConfig(config: unknown, pluginId: string = PLUGIN_ID): Record<string, unknown> | undefined {
  const entries = asRecord(asRecord(asRecord(config)?.plugins)?.entries);
  return asRecord(asRecord(entries?.[pluginId])?.config);
}

/** tools.web.fetch из полного конфига OpenClaw. */
export function webFetchConfig(config: unknown): Record<string, unknown> | undefined {
  return asRecord(asRecord(asRecord(asRecord(config)?.tools)?.web)?.fetch);
}

/** Проверяет и нормализует sidecar.baseUrl: только http(s) и только loopback-хост. */
export function validateSidecarBaseUrl(raw: unknown): string {
  const value = typeof raw === "string" && raw.trim() ? raw.trim() : DEFAULT_SIDECAR_BASE_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new StealthConfigError(`sidecar.baseUrl is not a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new StealthConfigError(`sidecar.baseUrl must use http:// or https://`);
  }
  if (url.username || url.password) {
    throw new StealthConfigError("sidecar.baseUrl must not contain credentials");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!isLoopbackHost(hostname)) {
    throw new StealthConfigError(
      `sidecar.baseUrl must point to a loopback address (127.0.0.1, localhost, ::1)`,
    );
  }
  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${pathname}`;
}

export function resolveTimeoutSeconds(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") {
    return DEFAULT_SIDECAR_TIMEOUT_SECONDS;
  }
  const value = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(value) || value <= 0) {
    throw new StealthConfigError(`sidecar.timeoutSeconds must be a positive number`);
  }
  return Math.min(MAX_SIDECAR_TIMEOUT_SECONDS, Math.max(MIN_SIDECAR_TIMEOUT_SECONDS, Math.floor(value)));
}

export function resolveEgress(raw: unknown, fallback: Egress = "auto"): Egress {
  if (raw === undefined || raw === null || raw === "") {
    return fallback;
  }
  const value = String(raw).trim().toLowerCase();
  if ((EGRESS_VALUES as readonly string[]).includes(value)) {
    return value as Egress;
  }
  throw new StealthConfigError(`defaultEgress must be one of ${EGRESS_VALUES.join("|")}`);
}

/** Собирает конфиг плагина; бросает StealthConfigError при невалидных значениях. */
export function resolvePluginConfig(sources: ConfigSources = {}): StealthPluginConfig {
  const entry = pluginEntryConfig(sources.config) ?? sources.pluginConfig ?? {};
  const sidecar = asRecord(entry.sidecar) ?? {};
  const fallbackRaw = entry.firecrawlFallback;
  return {
    sidecarBaseUrl: validateSidecarBaseUrl(sidecar.baseUrl),
    sidecarTimeoutSeconds: resolveTimeoutSeconds(sidecar.timeoutSeconds),
    firecrawlFallback: typeof fallbackRaw === "boolean" ? fallbackRaw : false,
    defaultEgress: resolveEgress(entry.defaultEgress),
  };
}

/** tools.web.fetch.maxChars → дефолт для fetch_stealth (с учётом maxCharsCap, если задан). */
export function resolveToolDefaultMaxChars(config: unknown): number {
  const fetch = webFetchConfig(config);
  const configured = typeof fetch?.maxChars === "number" && Number.isFinite(fetch.maxChars) && fetch.maxChars >= 100
    ? Math.floor(fetch.maxChars)
    : DEFAULT_TOOL_MAX_CHARS;
  const cap = typeof fetch?.maxCharsCap === "number" && Number.isFinite(fetch.maxCharsCap) && fetch.maxCharsCap >= 100
    ? Math.floor(fetch.maxCharsCap)
    : undefined;
  return cap !== undefined ? Math.min(configured, cap) : configured;
}
