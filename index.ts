/**
 * openclaw-stealth-fetch: провайдер web_fetch «stealth» + инструмент fetch_stealth.
 *
 * Оба ходят в локальный сайдкар stealth-fetch (http://127.0.0.1:18801), который гоняет каскад
 * TLS-имперсонация → optional Chrome → Camoufox → Jina; egress auto/direct.
 * Исторический ru отклоняется до сети (proxy_route_unsupported).
 * При недоступном сайдкаре или непробитой защите — keyless-откат на Firecrawl (если включён).
 */

import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { PLUGIN_ID, PLUGIN_VERSION, PROVIDER_ID, TOOL_NAME, StealthConfigError, resolvePluginConfig } from "./src/config.js";
import { createStealthWebFetchProvider } from "./src/provider.js";
import { configResolverFromContext, createFetchStealthTool } from "./src/tool.js";

export { PLUGIN_ID, PLUGIN_VERSION, PROVIDER_ID, TOOL_NAME } from "./src/config.js";
export { detectChallengePage, FirecrawlChallengeError } from "./src/challenge.js";
export { createStealthWebFetchProvider } from "./src/provider.js";
export { createFetchStealthTool } from "./src/tool.js";
export { runStealthFetch } from "./src/stealth.js";

const plugin = definePluginEntry({
  id: PLUGIN_ID,
  name: "Stealth Fetch",
  description:
    "Провайдер web_fetch «stealth» и инструмент fetch_stealth: локальный сайдкар с каскадом TLS-имперсонация → headed Chrome → Camoufox → Jina, pinned direct HTTP и опциональный keyless-откат на Firecrawl.",
  register(api: OpenClawPluginApi) {
    const logger = api.logger;
    const deps = { logger, pluginConfig: api.pluginConfig };

    let sidecarNote = "";
    try {
      const cfg = resolvePluginConfig({ config: api.config, pluginConfig: api.pluginConfig });
      sidecarNote = ` timeout=${cfg.sidecarTimeoutSeconds}s egress=${cfg.defaultEgress} firecrawlFallback=${cfg.firecrawlFallback}`;
    } catch (err) {
      // Регистрируем всё равно: ошибка конфигурации всплывёт в каждом вызове понятным сообщением.
      logger.error(err instanceof StealthConfigError ? err.message : `[${PLUGIN_ID}] config error`);
    }

    api.registerWebFetchProvider(createStealthWebFetchProvider(deps));
    api.registerTool(
      (toolCtx) => createFetchStealthTool({ ...deps, resolveConfig: configResolverFromContext(toolCtx, api.config) }),
      { name: TOOL_NAME },
    );
    // Registration also runs for discovery/inspection; only a committed reload activates Gateway callbacks.
    logger.info(`[${PLUGIN_ID}] v${PLUGIN_VERSION} web_fetch provider "${PROVIDER_ID}" and tool ${TOOL_NAME} registered; mode=${api.registrationMode ?? "unknown"};${sidecarNote}`);
  },
});

export default plugin;
