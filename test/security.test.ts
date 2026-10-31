import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { firecrawlKeylessScrape, FIRECRAWL_MAX_RESPONSE_BYTES } from "../src/firecrawl.js";
import { detectChallengePage, FirecrawlChallengeError } from "../src/challenge.js";
import { readBoundedText } from "../src/streams.js";
import { createFetchStealthTool } from "../src/tool.js";
import { createStealthWebFetchProvider } from "../src/provider.js";
import { sidecarHealth } from "../src/sidecar.js";
import { resolvePluginConfig } from "../src/config.js";
import { startFakeSidecar, okPayload, openclawConfig } from "./helpers.js";

const MARKER = "SYNTHETIC_DIAGNOSTIC_SENTINEL";
const signed = "https://example.com/private?signature=" + MARKER + "#" + MARKER;
const json = (value: unknown, status = 200) => Response.json(value, { status });
const capture = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (error) { return error as Error; } throw new Error("expected rejection"); };
const safeError = (error: Error) => JSON.stringify(Object.fromEntries(Object.getOwnPropertyNames(error).map((key) => [key, (error as unknown as Record<string, unknown>)[key]])));

describe("unsupported proxy route fails closed before all transports", () => {
  for (const sidecarState of ["unavailable", "blocked", "success"]) {
    for (const route of ["explicit", "default"]) {
      it(route + " ru never reaches " + sidecarState + " sidecar or Firecrawl", async () => {
        let sidecarCalls = 0;
        let providerCalls = 0;
        const tool = createFetchStealthTool({
          pluginConfig: { defaultEgress: route === "default" ? "ru" : "direct", firecrawlFallback: true },
          fetchImpl: async () => {
            sidecarCalls++;
            if (sidecarState === "unavailable") throw new Error("synthetic unavailable");
            return json(sidecarState === "success" ? okPayload() : { ok: false, error: "proxy_route_unsupported" });
          },
          firecrawlFetchImpl: async () => { providerCalls++; return json({ success: true, data: { markdown: "Ordinary article" } }); },
        });
        await expect(tool.execute("routing", { url: signed, ...(route === "explicit" ? { egress: "ru" } : {}) })).rejects.toThrow("proxy_route_unsupported");
        expect({ sidecarCalls, providerCalls }).toEqual({ sidecarCalls: 0, providerCalls: 0 });
      });
    }
  }
});

describe("provider default routing", () => {
  it("defaultEgress ru cannot reach unavailable sidecar or opted-in Firecrawl", async () => {
    let sidecarCalls = 0;
    let providerCalls = 0;
    const provider = createStealthWebFetchProvider({
      fetchImpl: async () => { sidecarCalls++; throw new Error("synthetic unavailable"); },
      firecrawlFetchImpl: async () => { providerCalls++; return json({ success: true, data: { markdown: "Ordinary article" } }); },
    });
    const tool = provider.createTool({ config: openclawConfig({ defaultEgress: "ru", firecrawlFallback: true }) as never });
    expect(tool).not.toBeNull();
    await expect(tool!.execute({ url: signed }, {})).rejects.toThrow("proxy_route_unsupported");
    expect({ sidecarCalls, providerCalls }).toEqual({ sidecarCalls: 0, providerCalls: 0 });
  });
});

describe("diagnostic minimization", () => {
  it("challenge reasons never repeat URL/title/body fragments", () => {
    for (const candidate of [{ finalUrl: signed.replace("/private", "/showcaptcha") }, { title: "Just a moment " + MARKER }, { text: "smartcaptcha " + MARKER }]) {
      const detection = detectChallengePage(candidate)!;
      const error = new FirecrawlChallengeError(detection);
      expect(safeError(error)).not.toContain(MARKER);
    }
  });
  it("drops provider exceptions, failed response snippets and warnings", async () => {
    for (const fetchImpl of [async () => { throw new Error(signed); }, async () => json({ error: signed }, 500), async () => json({ success: false, message: signed })]) {
      const error = await capture(() => firecrawlKeylessScrape({ url: signed, extractMode: "markdown", fetchImpl }));
      expect(safeError(error)).not.toContain(MARKER);
    }
    const result = await firecrawlKeylessScrape({ url: signed, extractMode: "markdown", fetchImpl: async () => json({ success: true, warning: signed, data: { markdown: "Article " + MARKER } }) });
    expect(result.text).toContain(MARKER);
    expect(result.warning).toBe("external_provider_warning");
  });
  it("does not echo configuration values or custom abort reasons", async () => {
    try { resolvePluginConfig({ pluginConfig: { sidecar: { baseUrl: signed } } }); } catch (err) { expect(String(err)).not.toContain(MARKER); }
    const controller = new AbortController(); controller.abort(new Error(signed));
    const error = await capture(() => firecrawlKeylessScrape({ url: signed, extractMode: "markdown", signal: controller.signal }));
    expect(safeError(error)).not.toContain(MARKER);
    expect(error.message).toBe("aborted");
  });
  it("cleans error chains, logger messages and layer labels", async () => {
    const logs: string[] = [];
    const logger = { info: (s: string) => logs.push(s), warn: (s: string) => logs.push(s), error: (s: string) => logs.push(s) };
    const tool = createFetchStealthTool({ pluginConfig: { firecrawlFallback: true }, logger,
      fetchImpl: async () => json({ ok: false, error: signed, finalUrl: signed, protection: "smartcaptcha", layers: [{ method: MARKER, egress: MARKER, result: MARKER }] }),
      firecrawlFetchImpl: async () => json({ success: true, data: { markdown: "smartcaptcha " + MARKER, metadata: { title: "Just a moment " + MARKER, sourceURL: signed } } }),
    });
    const error = await capture(() => tool.execute("test", { url: signed }));
    expect(safeError(error) + logs.join("\n")).not.toContain(MARKER);
    expect(error.message).toContain("challenge page");
  });
  it("keeps intentional content/URL metadata but not diagnostic summary or warning", async () => {
    const logs: string[] = [];
    const tool = createFetchStealthTool({ pluginConfig: { firecrawlFallback: false }, logger: { info:s=>logs.push(s),warn:s=>logs.push(s),error:s=>logs.push(s) },
      fetchImpl: async () => json(okPayload({ url: signed, finalUrl: signed, text: "Ordinary article " + MARKER, layers: [{ method: MARKER, egress: MARKER, result: MARKER }] })) });
    const value = await tool.execute("test", { url: signed });
    const details = value.details as Record<string, unknown>;
    expect(details.text).toContain(MARKER);
    expect(details.finalUrl).toBe(signed);
    expect(JSON.stringify({ summary: details.summary, warning: details.warning, layers: details.layers, logs })).not.toContain(MARKER);
  });
  it("minimizes health responses and transport error causes", async () => {
    const health = await sidecarHealth({ baseUrl: "http://127.0.0.1:18801", fetchImpl: async () => json({ ok: true, version: MARKER, error: signed, browsers: { chrome: MARKER }, egress: { ru: { error: signed, ip: MARKER } } }) });
    expect(JSON.stringify(health)).not.toContain(MARKER);
    const error = await capture(() => sidecarHealth({ baseUrl: "http://127.0.0.1:18801", fetchImpl: async () => { throw new Error(signed, { cause: new Error("socks5h://user:" + MARKER + "@proxy.invalid:1080") }); } }));
    expect(safeError(error)).not.toContain(MARKER);
  });
});

describe("bounded response streams", () => {
  it("rejects a single oversized chunk before retaining it and cancels the reader", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(100_000)); }, cancel() { cancelled = true; } }));
    await expect(readBoundedText(response, 10)).rejects.toThrow("response_body_too_large");
    expect(cancelled).toBe(true);
  });
  it("accepts exact byte limit and split Unicode sequences", async () => {
    const bytes = new TextEncoder().encode("éé");
    const response = new Response(new ReadableStream({ start(c) { c.enqueue(bytes.slice(0,1)); c.enqueue(bytes.slice(1)); c.close(); } }));
    expect(await readBoundedText(response,4)).toBe("éé");
  });
  it("bounds Firecrawl JSON without response.text and aborts on excess", async () => {
    let cancelled = false; let signal: AbortSignal | undefined;
    const error = await capture(() => firecrawlKeylessScrape({ url: signed, extractMode: "markdown", fetchImpl: async (_url, init) => {
      signal = init?.signal as AbortSignal;
      return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(FIRECRAWL_MAX_RESPONSE_BYTES + 1)); }, cancel() { cancelled = true; } }));
    } }));
    expect(error.message).toBe("Firecrawl response_body_too_large");
    expect(cancelled && signal?.aborted).toBe(true);
  });
  it("stops actual chunked HTTP transfer before the full oversized body", async () => {
    let completed = false; let stopped: Promise<void>;
    let resolveStop: () => void = () => {};
    stopped = new Promise<void>((resolve) => { resolveStop = resolve; });
    const server = await startFakeSidecar((_request, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      let sent = 0;
      const timer = setInterval(() => {
        res.write(Buffer.alloc(256_000, 120)); sent += 256_000;
        if (sent >= 32_000_000) { completed = true; clearInterval(timer); res.end(); }
      }, 1);
      res.once("close", () => { clearInterval(timer); resolveStop(); });
    });
    try {
      await expect(firecrawlKeylessScrape({ url: "https://example.com/", extractMode: "markdown", endpoint: server.baseUrl + "/scrape" })).rejects.toThrow("response_body_too_large");
      await stopped;
      expect(completed).toBe(false);
    } finally { await server.close(); }
  });
  it("counts decoded gzip bytes, not compressed Content-Length", async () => {
    const compressed = gzipSync(Buffer.alloc(FIRECRAWL_MAX_RESPONSE_BYTES + 1,120));
    const server = await startFakeSidecar((_request,res) => { res.writeHead(200,{"content-type":"application/json","content-encoding":"gzip","content-length":compressed.length});res.end(compressed); });
    try { await expect(firecrawlKeylessScrape({ url:"https://example.com/",extractMode:"markdown",endpoint:server.baseUrl+"/scrape" })).rejects.toThrow("response_body_too_large"); }
    finally { await server.close(); }
  });
});
