import { throwIfAbortedSafe } from "./diagnostics.js";
/**
 * Инструмент fetch_stealth — явный вызов каскада с выбором egress/method.
 *
 * В отличие от провайдера, здесь обёртку внешнего контента и обрезку по maxChars делает сам плагин
 * (как firecrawl_scrape): text → truncateSanitizedExternalContent → wrapWebContent("web_fetch"),
 * результат — jsonResult с короткой сводкой method/egress/finalUrl.
 */

import type { AnyAgentTool, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { truncateSanitizedExternalContent, wrapExternalContent, wrapWebContent } from "openclaw/plugin-sdk/security-runtime";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { PLUGIN_ID, PLUGIN_VERSION, TOOL_NAME, StealthConfigError, resolvePluginConfig, resolveToolDefaultMaxChars } from "./config.js";
import { runStealthFetch, silentLogger, type StealthDeps } from "./stealth.js";
import { EGRESS_VALUES, METHOD_VALUES, type Egress, type ExtractMode, type PluginLogger, type StealthMethod } from "./types.js";

export const FETCH_STEALTH_DESCRIPTION =
  "Fetch a page through the stealth cascade (TLS impersonation → headed Chrome → Camoufox → Jina) with pinned direct HTTP and opt-in experimental browser/external readers; " +
  "use when web_fetch returns a challenge/JS-shell or a blocked page.";

export const FETCH_STEALTH_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["url"],
  properties: {
    url: { type: "string", description: "HTTP or HTTPS URL to fetch." },
    extractMode: {
      type: "string",
      enum: ["markdown", "text"],
      description: 'Extraction mode: "markdown" (default) or "text".',
    },
    egress: {
      type: "string",
      enum: ["auto", "ru", "direct"],
      description: 'Egress: "auto" or "direct". Historical "ru" is unsupported and fails closed; no silent fallback.',
    },
    method: {
      type: "string",
      enum: ["auto", "http", "chrome", "camoufox", "jina"],
      description: 'Cascade entry point: "auto" (default, full cascade) or force one layer: "http" (TLS impersonation), "chrome" (headed Chrome), "camoufox", "jina" (r.jina.ai).',
    },
    maxChars: { type: "integer", minimum: 100, description: "Maximum characters to return (default: tools.web.fetch.maxChars or 50000)." },
    noCache: { type: "boolean", description: "Bypass the sidecar cache and fetch fresh." },
  },
} as const;

const TITLE_MAX_CHARS = 512;

export interface ToolDeps extends StealthDeps {
  /** Актуальный конфиг OpenClaw для вызова (getRuntimeConfig → runtimeConfig → config → api.config). */
  resolveConfig?: () => unknown;
  /** plugins.entries.<id>.config из register(api) — запасной источник. */
  pluginConfig?: Record<string, unknown>;
}

function readString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readEnum<T extends string>(params: Record<string, unknown>, key: string, allowed: readonly T[]): T | undefined {
  const value = readString(params, key)?.toLowerCase();
  if (value === undefined) {
    return undefined;
  }
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${key} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function readMaxChars(params: Record<string, unknown>): number | undefined {
  const raw = params.maxChars;
  if (raw === undefined || raw === null || raw === "") {
    return undefined;
  }
  const value = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isInteger(value) || value < 100) {
    throw new Error("maxChars must be an integer >= 100");
  }
  return value;
}

/** Контекст, который ядро передаёт фабрике инструмента; поля берём по мере надобности. */
export type ToolFactoryContext = Pick<OpenClawPluginToolContext, "config" | "runtimeConfig" | "getRuntimeConfig">;

export function configResolverFromContext(ctx: ToolFactoryContext | undefined, fallback?: unknown): () => unknown {
  return () => ctx?.getRuntimeConfig?.() ?? ctx?.runtimeConfig ?? ctx?.config ?? fallback;
}

export function createFetchStealthTool(deps: ToolDeps = {}): AnyAgentTool {
  const logger: PluginLogger = deps.logger ?? silentLogger;
  const tool = {
    name: TOOL_NAME,
    label: "Stealth Fetch",
    resultContentSource: "network" as const,
    description: FETCH_STEALTH_DESCRIPTION,
    parameters: FETCH_STEALTH_PARAMETERS,
    execute: async (_toolCallId: string, rawParams: unknown, signal?: AbortSignal) => {
      throwIfAbortedSafe(signal);
      const params = (rawParams && typeof rawParams === "object" ? rawParams : {}) as Record<string, unknown>;
      const url = readString(params, "url");
      if (!url) {
        throw new Error("url is required");
      }
      const extractMode: ExtractMode = readEnum(params, "extractMode", ["markdown", "text"] as const) ?? "markdown";
      const egress: Egress | undefined = readEnum(params, "egress", EGRESS_VALUES);
      const method: StealthMethod | undefined = readEnum(params, "method", METHOD_VALUES);
      const noCache = params.noCache === true;
      const config = deps.resolveConfig?.();
      let cfg;
      try {
        cfg = resolvePluginConfig({ config, pluginConfig: deps.pluginConfig });
      } catch (err) {
        if (err instanceof StealthConfigError) {
          logger.error(err.message);
        }
        throw err;
      }
      const maxChars = readMaxChars(params) ?? resolveToolDefaultMaxChars(config);

      const result = await runStealthFetch(
        { url, extractMode, maxChars, egress, method, noCache },
        cfg,
        { ...deps, logger },
        signal,
      );

      const bounded = truncateSanitizedExternalContent(result.text, maxChars);
      const text = wrapWebContent(bounded.text, "web_fetch");
      const title = result.title
        ? wrapExternalContent(truncateSanitizedExternalContent(result.title, TITLE_MAX_CHARS).text, { source: "web_fetch", includeWarning: false })
        : undefined;
      return jsonResult({
        url: result.url,
        finalUrl: result.finalUrl,
        status: result.status,
        ...(title ? { title } : {}),
        ...(result.contentType ? { contentType: result.contentType } : {}),
        summary: `runtime=v${PLUGIN_VERSION} method=${result.method} egress=${result.egress} status=${result.status}`,
        method: result.method,
        egress: result.egress,
        extractor: result.extractor,
        extractMode,
        ...(result.cached !== undefined ? { cached: result.cached } : {}),
        ...(result.fallback ? { fallback: result.fallback } : {}),
        ...(result.layers && result.layers.length ? { layers: result.layers } : {}),
        externalContent: { untrusted: true, source: "web_fetch", provider: PLUGIN_ID, wrapped: true },
        truncated: result.truncated || bounded.truncated,
        rawLength: result.rawLength,
        length: text.length,
        tookMs: result.tookMs,
        ...(result.warning ? { warning: result.warning } : {}),
        text,
      });
    },
  };
  return tool as unknown as AnyAgentTool;
}
