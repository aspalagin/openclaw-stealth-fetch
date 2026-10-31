import { throwIfAbortedSafe } from "./diagnostics.js";
/**
 * Провайдер web_fetch «stealth».
 *
 * Контракт ядра (OpenClaw 2026.10.5, fetchWebPayload → buildWebFetchPayload):
 *  execute({url, extractMode, maxChars}, {signal}) → { text, finalUrl, status, title, contentType,
 *  extractor, warning, truncated, rawLength, tookMs, fetchedAt }. Ядро САМО оборачивает text как внешний
 *  контент и режет по maxChars, поэтому здесь text отдаётся сырым (без wrapExternalContent).
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { PLUGIN_ID, PROVIDER_ID, StealthConfigError, resolvePluginConfig, type StealthPluginConfig } from "./config.js";
import { runStealthFetch, silentLogger, type StealthDeps } from "./stealth.js";
import type { ExtractMode, PluginLogger } from "./types.js";

export type WebFetchProviderPlugin = Parameters<OpenClawPluginApi["registerWebFetchProvider"]>[0];
export type WebFetchProviderContext = Parameters<WebFetchProviderPlugin["createTool"]>[0];
export type WebFetchProviderToolDefinition = NonNullable<ReturnType<WebFetchProviderPlugin["createTool"]>>;

export const STEALTH_CREDENTIAL_PATH = `plugins.entries.${PLUGIN_ID}.config.webFetch.apiKey`;

export interface ProviderDeps extends StealthDeps {
  /** plugins.entries.<id>.config из register(api); живой ctx.config имеет приоритет. */
  pluginConfig?: Record<string, unknown>;
}

export interface ProviderExecuteArgs {
  url?: unknown;
  extractMode?: unknown;
  maxChars?: unknown;
}

function readExtractMode(value: unknown): ExtractMode {
  return value === "text" ? "text" : "markdown";
}

function readPositiveInteger(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const num = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isInteger(num) && num > 0 ? num : undefined;
}

/** Конфиг для текущего вызова: живой конфиг ядра → снимок из register → ошибка конфигурации. */
export function resolveProviderConfig(ctx: WebFetchProviderContext | undefined, deps: ProviderDeps): StealthPluginConfig {
  return resolvePluginConfig({ config: ctx?.config, pluginConfig: deps.pluginConfig });
}

export function createStealthWebFetchProvider(deps: ProviderDeps = {}): WebFetchProviderPlugin {
  const logger: PluginLogger = deps.logger ?? silentLogger;
  return {
    id: PROVIDER_ID,
    label: "Stealth Fetch",
    hint: "Local anti-bot cascade (TLS impersonation → headed Chrome → Camoufox → Jina) with pinned direct HTTP; browser and external-reader layers require opt-in. Proxy egress is unsupported.",
    requiresCredential: false,
    credentialLabel: "Not required (keyless)",
    envVars: [],
    placeholder: "",
    signupUrl: "",
    autoDetectOrder: 90,
    credentialPath: STEALTH_CREDENTIAL_PATH,
    inactiveSecretPaths: [],
    // Провайдер keyless: credential-аксессоры — безопасные заглушки, ничего не читают и не пишут.
    getCredentialValue: () => undefined,
    setCredentialValue: () => undefined,
    getConfiguredCredentialValue: () => undefined,
    setConfiguredCredentialValue: () => undefined,
    createTool: (ctx) => ({
      description: "Fetch a page through the stealth anti-bot cascade sidecar (keyless).",
      parameters: {},
      execute: async (args: Record<string, unknown>, executionContext?: { signal?: AbortSignal }) => {
        const signal = executionContext?.signal;
        throwIfAbortedSafe(signal);
        let cfg: StealthPluginConfig;
        try {
          cfg = resolveProviderConfig(ctx, deps);
        } catch (err) {
          if (err instanceof StealthConfigError) {
            logger.error(err.message);
          }
          throw err;
        }
        const result = await runStealthFetch(
          {
            url: typeof args.url === "string" ? args.url : "",
            extractMode: readExtractMode(args.extractMode),
            maxChars: readPositiveInteger(args.maxChars),
          },
          cfg,
          { ...deps, logger },
          signal,
        );
        return {
          url: result.url,
          finalUrl: result.finalUrl,
          status: result.status,
          ...(result.title ? { title: result.title } : {}),
          ...(result.contentType ? { contentType: result.contentType } : {}),
          extractor: result.extractor,
          extractMode: readExtractMode(args.extractMode),
          text: result.text,
          rawLength: result.rawLength,
          truncated: result.truncated,
          tookMs: result.tookMs,
          fetchedAt: new Date().toISOString(),
          ...(result.cached !== undefined ? { cached: result.cached } : {}),
          ...(result.warning ? { warning: result.warning } : {}),
        };
      },
    }),
  };
}
