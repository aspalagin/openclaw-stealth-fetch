import assert from "node:assert/strict";
import { lstatSync } from "node:fs";
import plugin, { PLUGIN_VERSION } from "@aspalagin/openclaw-stealth-fetch";
assert.equal(PLUGIN_VERSION, "0.1.2");
assert.equal(lstatSync("node_modules/openclaw").isSymbolicLink(), false);
assert.equal(lstatSync("node_modules/@aspalagin/openclaw-stealth-fetch").isSymbolicLink(), false);
let provider;
let factory;
const pluginConfig = { sidecar: { baseUrl: "http://127.0.0.1:18801" }, firecrawlFallback: true };
const config = { plugins: { entries: { "openclaw-stealth-fetch": { enabled: true, config: pluginConfig } } } };
plugin.register({
  config, pluginConfig, registrationMode: "full",
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  registerWebFetchProvider(value) { provider = value; },
  registerTool(value) { factory = value; },
});
assert.equal(provider.id, "stealth");
const tool = factory({ config });
let challenge = false;
let fetchCalls = 0;
globalThis.fetch = async (input) => {
  fetchCalls++;
  const endpoint = String(input);
  if (endpoint === "http://127.0.0.1:18801/fetch") {
    if (challenge) return Response.json({ ok: false, error: "synthetic challenge", protection: "smartcaptcha", layers: [] });
    return Response.json({ ok: true, url: "https://example.com/", finalUrl: "https://example.com/", status: 200, text: "Synthetic article content", rawLength: 25, truncated: false, method: "http", egress: "direct", tookMs: 1, layers: [] });
  }
  assert.equal(endpoint, "https://api.firecrawl.dev/v2/scrape");
  return Response.json({ success: true, data: { markdown: "Please confirm that you are not a robot. Yandex SmartCaptcha", metadata: { title: "Are you not a robot?", statusCode: 200, sourceURL: "https://example.com/" } } });
};
const result = await tool.execute("smoke", { url: "https://example.com/" });
assert.equal(result.details.extractor, "stealth:http:direct");
assert.match(result.details.text, /EXTERNAL_UNTRUSTED_CONTENT/);
assert.equal((await provider.createTool({ config }).execute({ url: "https://example.com/" })).text, "Synthetic article content");
challenge = true;
await assert.rejects(tool.execute("smoke", { url: "https://example.com/" }), /challenge page/);
await assert.rejects(tool.execute("smoke", { url: "http://127.0.0.1/" }), /Blocked/);
const callsBeforeUnsupportedRoute = fetchCalls;
await assert.rejects(tool.execute("routing", { url: "https://example.com/", egress: "ru" }), /proxy_route_unsupported/);
pluginConfig.defaultEgress = "ru";
await assert.rejects(factory({ config }).execute("routing", { url: "https://example.com/" }), /proxy_route_unsupported/);
await assert.rejects(provider.createTool({ config }).execute({ url: "https://example.com/" }), /proxy_route_unsupported/);
assert.equal(fetchCalls, callsBeforeUnsupportedRoute, "unsupported ru route must not call sidecar or Firecrawl");
console.log("Clean artifact: registration, provider, tool, challenge rejection, SSRF rejection, fail-closed explicit/default ru passed; no live HTTP.");
