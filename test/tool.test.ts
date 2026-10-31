import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFetchStealthTool, FETCH_STEALTH_PARAMETERS } from "../src/tool.js";
import { fakeFirecrawl, okPayload, openclawConfig, sendJson, startFakeSidecar, type FakeSidecar } from "./helpers.js";

let sidecar: FakeSidecar;

beforeEach(async () => {
  sidecar = await startFakeSidecar();
});

afterEach(async () => {
  await sidecar.close();
});

type ExecuteFn = (toolCallId: string, params: unknown, signal?: AbortSignal) => Promise<{ content: Array<{ type: string; text?: string }>; details: Record<string, unknown> }>;

function makeTool(pluginConfig: Record<string, unknown>, extra: Record<string, unknown> = {}, deps: Record<string, unknown> = {}) {
  const tool = createFetchStealthTool({ resolveConfig: () => openclawConfig(pluginConfig, extra), busyRetryDelayMs: 10, ...deps });
  return { tool, execute: tool.execute as unknown as ExecuteFn };
}

describe("fetch_stealth", () => {
  it("метаданные инструмента", () => {
    const { tool } = makeTool({});
    expect(tool.name).toBe("fetch_stealth");
    expect(tool.description).toMatch(/stealth cascade/);
    expect(tool.description).toMatch(/web_fetch returns a challenge/);
    expect(FETCH_STEALTH_PARAMETERS.required).toEqual(["url"]);
    expect(Object.keys(FETCH_STEALTH_PARAMETERS.properties)).toEqual(["url", "extractMode", "egress", "method", "maxChars", "noCache"]);
  });

  it("прокидывает egress/method/noCache/extractMode и отдаёт обёрнутый текст + сводку", async () => {
    sidecar.setHandler((request, res) =>
      sendJson(
        res,
        200,
        okPayload({
          url: String(request.body?.url),
          finalUrl: "https://www.rbc.ru/politics",
          method: "camoufox",
          egress: "direct",
          title: "РБК — Политика",
          text: "Текст статьи",
          rawLength: 12,
          layers: [
            { method: "chrome", egress: "direct", result: "blocked" },
            { method: "camoufox", egress: "direct", result: "ok" },
          ],
        }),
      ),
    );
    const { execute } = makeTool({ sidecar: { baseUrl: sidecar.baseUrl }, firecrawlFallback: false }, { tools: { web: { fetch: { maxChars: 20000 } } } });
    const result = await execute("call-1", { url: "https://www.rbc.ru/politics", egress: "direct", method: "camoufox", noCache: true, extractMode: "text" });

    expect(sidecar.requests[0]?.body).toEqual({
      url: "https://www.rbc.ru/politics",
      extractMode: "text",
      maxChars: 20000,
      egress: "direct",
      method: "camoufox",
      timeoutSeconds: 90,
      noCache: true,
    });

    const details = result.details;
    expect(details).toMatchObject({
      url: "https://www.rbc.ru/politics",
      finalUrl: "https://www.rbc.ru/politics",
      status: 200,
      method: "camoufox",
      egress: "direct",
      extractor: "stealth:camoufox:direct",
      extractMode: "text",
      summary: "runtime=v0.1.2 method=camoufox egress=direct status=200",
      externalContent: { untrusted: true, source: "web_fetch", provider: "openclaw-stealth-fetch", wrapped: true },
      rawLength: 12,
      truncated: false,
    });
    expect(String(details.text)).toContain("<<<EXTERNAL_UNTRUSTED_CONTENT");
    expect(String(details.text)).toContain("Текст статьи");
    expect(String(details.title)).toContain("РБК — Политика");
    expect(String(details.warning)).toMatch(/cascade: chrome:direct=blocked; served by camoufox:direct/);
    expect(result.content[0]?.type).toBe("text");
    expect(JSON.parse(result.content[0]?.text ?? "{}")).toMatchObject({ method: "camoufox", egress: "direct" });
  });

  it("maxChars по умолчанию 50000 и режет текст с truncated=true", async () => {
    sidecar.setHandler((request, res) => sendJson(res, 200, okPayload({ url: String(request.body?.url), text: "a".repeat(600), rawLength: 600 })));
    const { execute } = makeTool({ sidecar: { baseUrl: sidecar.baseUrl }, firecrawlFallback: false });
    const first = await execute("call-2", { url: "https://example.com/" });
    expect(sidecar.requests[0]?.body).toMatchObject({ maxChars: 50000, egress: "auto", method: "auto" });
    expect(first.details.truncated).toBe(false);

    const second = await execute("call-3", { url: "https://example.com/", maxChars: 200 });
    expect(sidecar.requests[1]?.body).toMatchObject({ maxChars: 200 });
    expect(second.details.truncated).toBe(true);
    expect(String(second.details.text)).not.toContain("a".repeat(201));
  });

  it("валидация параметров", async () => {
    const { execute } = makeTool({ sidecar: { baseUrl: sidecar.baseUrl }, firecrawlFallback: false });
    await expect(execute("c", {})).rejects.toThrow(/url is required/);
    await expect(execute("c", { url: "https://example.com/", egress: "tor" })).rejects.toThrow(/egress must be one of auto, ru, direct/);
    await expect(execute("c", { url: "https://example.com/", method: "selenium" })).rejects.toThrow(/method must be one of/);
    await expect(execute("c", { url: "https://example.com/", maxChars: 5 })).rejects.toThrow(/maxChars/);
    await expect(execute("c", { url: "http://127.0.0.1:18789/" })).rejects.toThrow(/Blocked/);
    expect(sidecar.requests).toHaveLength(0);
  });

  it("ok:false и откат выключен → ошибка с protection", async () => {
    sidecar.setHandler((request, res) => sendJson(res, 200, { ok: false, url: request.body?.url, protection: "akamai", error: "bot detected", layers: [] }));
    const { execute } = makeTool({ sidecar: { baseUrl: sidecar.baseUrl }, firecrawlFallback: false });
    await expect(execute("c", { url: "https://example.com/" })).rejects.toThrow("Stealth fetch blocked by akamai: cascade_exhausted");
  });

  it("Firecrawl-откат вернул капчу → ошибка инструмента с понятным текстом", async () => {
    sidecar.setHandler((request, res) => sendJson(res, 200, { ok: false, url: request.body?.url, protection: "smartcaptcha", error: "smartcaptcha on all layers", layers: [] }));
    const fc = fakeFirecrawl(() => ({
      status: 200,
      body: { success: true, data: { markdown: "Please confirm that you are not a robot\n\nYandex SmartCaptcha", metadata: { title: "Are you not a robot?", sourceURL: "https://yandex.ru/showcaptcha?cc=1", statusCode: 200 } } },
    }));
    const { execute } = makeTool({ sidecar: { baseUrl: sidecar.baseUrl }, firecrawlFallback: true }, {}, { firecrawlFetchImpl: fc.fetchImpl });
    await expect(execute("c", { url: "https://yandex.ru/search/?text=example+query", egress: "direct" })).rejects.toThrow(
      /^Stealth fetch blocked by smartcaptcha: cascade_exhausted; Firecrawl fallback returned a challenge page \(yandex-smartcaptcha; /,
    );
  });

  it("Firecrawl-откат вернул нормальный текст → контент, extractor stealth:firecrawl", async () => {
    sidecar.setHandler((request, res) => sendJson(res, 200, { ok: false, url: request.body?.url, protection: "qrator", error: "blocked", layers: [] }));
    const fc = fakeFirecrawl(() => ({ status: 200, body: { success: true, data: { markdown: "# Статья\n\nОбычный текст.", metadata: { title: "Статья", sourceURL: "https://site.example/a", statusCode: 200 } } } }));
    const { execute } = makeTool({ sidecar: { baseUrl: sidecar.baseUrl }, firecrawlFallback: true }, {}, { firecrawlFetchImpl: fc.fetchImpl });
    const result = await execute("c", { url: "https://site.example/a" });
    expect(result.details).toMatchObject({ extractor: "stealth:firecrawl", fallback: "firecrawl", method: "firecrawl" });
    expect(String(result.details.text)).toContain("Обычный текст.");
  });

  it("abort через signal", async () => {
    sidecar.setHandler(async (request, res) => {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      if (!res.destroyed) {
        sendJson(res, 200, okPayload({ url: String(request.body?.url) }));
      }
    });
    const { execute } = makeTool({ sidecar: { baseUrl: sidecar.baseUrl }, firecrawlFallback: false });
    const controller = new AbortController();
    const promise = execute("c", { url: "https://example.com/" }, controller.signal);
    setTimeout(() => controller.abort(new Error("tool abort")), 50);
    await expect(promise).rejects.toThrow("aborted");
  });
});
