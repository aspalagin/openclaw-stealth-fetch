// No Vite/TS transforms: exercise the shipped entry and its real registered callbacks.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import plugin, { PLUGIN_VERSION } from "../dist/index.js";

const URL = "https://yandex.ru/search/?text=example+query";
// Synthetic challenge text; no captured responses or CAPTCHA tokens.
const CAPTCHA = ("[Yandex](https://www.yandex.com/)\n\n# Please confirm that you are not a robot\n\n" +
  "We're sorry, but it looks like requests sent from your device are automated.\n\n" +
  "I'm not a robot  Press to continue\n\n[Yandex SmartCaptcha]\n").padEnd(781, ".");
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const blocked = { ok: false, protection: "smartcaptcha", error: "blocked by smartcaptcha", layers: [{ method: "http", egress: "direct", result: "blocked:smartcaptcha" }] };

function register(t, { text = CAPTCHA, title = "Are you not a robot?", sidecar = "blocked", defaultEgress = "auto" } = {}) {
  const calls = [];
  const logs = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const target = String(input);
    calls.push({ url: target, body: JSON.parse(init.body) });
    if (target === "http://127.0.0.1:18801/fetch") {
      if (sidecar === "unavailable") throw new TypeError("fetch failed: ECONNREFUSED (mock)");
      if (sidecar === "ok") return json({ ok: true, url: URL, finalUrl: URL, status: 200, title: "News", contentType: "text/html", text: "Ordinary news", rawLength: 13, truncated: false, method: "http", egress: "direct", tookMs: 1, layers: [] });
      return json(blocked);
    }
    assert.equal(target, "https://api.firecrawl.dev/v2/scrape", "unexpected network target");
    return json({ success: true, data: { markdown: text, metadata: { title, sourceURL: URL, statusCode: 200 } } });
  });
  let provider;
  let factory;
  const pluginConfig = { sidecar: { baseUrl: "http://127.0.0.1:18801" }, firecrawlFallback: true, defaultEgress };
  const config = { plugins: { entries: { "openclaw-stealth-fetch": { enabled: true, config: pluginConfig } } } };
  plugin.register({
    config, pluginConfig, registrationMode: "full",
    logger: Object.fromEntries(["info", "warn", "error", "debug"].map((level) => [level, (message) => logs.push(message)])),
    registerWebFetchProvider(value) { provider = value; },
    registerTool(value) { factory = value; },
  });
  return { provider: provider.createTool({ config }), tool: factory({ config }), calls, logs };
}

test("native explicit ru rejects before unavailable sidecar or Firecrawl", async (t) => {
  const { tool, calls } = register(t, { sidecar: "unavailable", title: "Ordinary", text: "Ordinary article" });
  await assert.rejects(tool.execute("routing", { url: URL, egress: "ru" }), /proxy_route_unsupported/);
  assert.equal(calls.length, 0);
});

test("native default ru rejects both tool and provider before any request", async (t) => {
  const { tool, provider, calls } = register(t, { sidecar: "unavailable", defaultEgress: "ru", title: "Ordinary", text: "Ordinary article" });
  await assert.rejects(tool.execute("routing", { url: URL }), /proxy_route_unsupported/);
  await assert.rejects(provider.execute({ url: URL }), /proxy_route_unsupported/);
  assert.equal(calls.length, 0);
});

function assertInvocationVersion(logs) {
  assert.ok(logs.some((line) => line.startsWith(`[stealth-fetch] v${PLUGIN_VERSION} `)), "no versioned invocation log (registration alone is not activation proof)");
}

// Keep these sequential: each registered production callback uses global fetch.
test("native artifact versions and registration diagnostics are coherent", (t) => {
  const pkg = JSON.parse(readFileSync(new globalThis.URL("../package.json", import.meta.url)));
  const manifest = JSON.parse(readFileSync(new globalThis.URL("../openclaw.plugin.json", import.meta.url)));
  const lock = JSON.parse(readFileSync(new globalThis.URL("../package-lock.json", import.meta.url)));
  assert.equal(PLUGIN_VERSION, pkg.version);
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[""].version, pkg.version);
  const { logs } = register(t);
  assert.ok(logs.some((line) => line.includes("registered; mode=full;")));
});

test("registered fetch_stealth rejects synthetic 200 SmartCaptcha at unchanged search URL", async (t) => {
  const { tool, calls, logs } = register(t);
  assert.equal(CAPTCHA.length, 781);
  await assert.rejects(tool.execute("test", { url: URL, method: "http", egress: "direct", noCache: true, maxChars: 1801 }), /Firecrawl fallback returned a challenge page \(yandex-smartcaptcha/);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.noCache, true);
  assert.equal(calls[0].body.method, "http");
  assertInvocationVersion(logs);
});

test("registered provider rejects the same 200 CAPTCHA before output wrapping", async (t) => {
  const { provider, calls, logs } = register(t);
  await assert.rejects(provider.execute({ url: URL, maxChars: 1801 }), /Firecrawl fallback returned a challenge page/);
  assert.equal(calls.length, 2);
  assertInvocationVersion(logs);
});

test("native artifact rejects body-only SmartCaptcha without a CAPTCHA finalUrl or title", async (t) => {
  const { tool } = register(t, { title: "Yandex" });
  await assert.rejects(tool.execute("test", { url: URL }), /challenge page \(yandex-smartcaptcha; body/);
});

test("unavailable-sidecar path also rejects Firecrawl challenge", async (t) => {
  const { provider } = register(t, { sidecar: "unavailable", title: "Just a moment...", text: "Please enable JavaScript and cookies" });
  await assert.rejects(provider.execute({ url: URL }), /sidecar unavailable.*Firecrawl fallback returned a challenge page \(cloudflare-challenge/);
});

test("native artifact still serves real Firecrawl articles mentioning SmartCaptcha", async (t) => {
  const article = "An ordinary article about service reliability. ".repeat(60) + "Yandex SmartCaptcha";
  const { tool, provider, calls, logs } = register(t, { title: "Service reliability", text: article });
  const result = await tool.execute("test", { url: URL, maxChars: 1801 });
  assert.equal(result.details.status, 200);
  assert.equal(result.details.extractor, "stealth:firecrawl");
  assert.ok(result.details.summary.startsWith(`runtime=v${PLUGIN_VERSION} `));
  assert.match(result.details.text, /EXTERNAL_UNTRUSTED_CONTENT/);
  const raw = await provider.execute({ url: URL });
  assert.equal(raw.text, article);
  assert.equal(raw.extractor, "stealth:firecrawl");
  assert.equal(calls.length, 4);
  assertInvocationVersion(logs);
});

test("native artifact preserves ordinary sidecar success without Firecrawl", async (t) => {
  const { tool, provider, calls, logs } = register(t, { sidecar: "ok" });
  assert.equal((await tool.execute("test", { url: URL })).details.extractor, "stealth:http:direct");
  assert.equal((await provider.execute({ url: URL })).text, "Ordinary news");
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.url.startsWith("http://127.0.0.1:18801/")));
  assertInvocationVersion(logs);
});
