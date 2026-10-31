import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStealthWebFetchProvider } from "../src/provider.js";
import { SidecarBlockedError, SidecarUnavailableError } from "../src/sidecar.js";
import { fakeFirecrawl, freeLoopbackPort, okPayload, openclawConfig, sendJson, startFakeSidecar, type FakeSidecar } from "./helpers.js";

let sidecar: FakeSidecar;

beforeEach(async () => {
  sidecar = await startFakeSidecar();
});

afterEach(async () => {
  await sidecar.close();
});

function providerTool(pluginConfig: Record<string, unknown>, deps: Parameters<typeof createStealthWebFetchProvider>[0] = {}) {
  const provider = createStealthWebFetchProvider({ busyRetryDelayMs: 10, ...deps });
  const tool = provider.createTool({ config: openclawConfig(pluginConfig) as never });
  if (!tool) {
    throw new Error("createTool вернул null");
  }
  return { provider, tool };
}

describe("провайдер stealth: метаданные", () => {
  it("keyless, id stealth, безопасные credential-заглушки", () => {
    const provider = createStealthWebFetchProvider();
    expect(provider.id).toBe("stealth");
    expect(provider.requiresCredential).toBe(false);
    expect(provider.envVars).toEqual([]);
    expect(provider.credentialPath).toBe("plugins.entries.openclaw-stealth-fetch.config.webFetch.apiKey");
    expect(provider.getCredentialValue({ stealth: { apiKey: "x" } })).toBeUndefined();
    const target: Record<string, unknown> = {};
    provider.setCredentialValue(target, "secret");
    expect(target).toEqual({});
  });
});

describe("провайдер stealth: execute", () => {
  it("ok:true → форма ядра, text сырой (без обёртки), extractor stealth:<method>:<egress>", async () => {
    sidecar.setHandler((request, res) =>
      sendJson(
        res,
        200,
        okPayload({
          url: String(request.body?.url),
          finalUrl: "https://www.rbc.ru/",
          method: "chrome",
          egress: "direct",
          status: 200,
          title: "РБК",
          text: "# РБК\n\nНовости",
          rawLength: 15,
          tookMs: 4321,
          layers: [
            { method: "http", egress: "direct", result: "blocked:qrator", tookMs: 900 },
            { method: "chrome", egress: "direct", result: "ok", tookMs: 3400 },
          ],
        }),
      ),
    );
    const { tool } = providerTool({ sidecar: { baseUrl: sidecar.baseUrl, timeoutSeconds: 95 }, defaultEgress: "direct", firecrawlFallback: false });
    const result = await tool.execute({ url: "https://www.rbc.ru", extractMode: "markdown", maxChars: 20000 }, {});

    expect(result).toMatchObject({
      url: "https://www.rbc.ru/",
      finalUrl: "https://www.rbc.ru/",
      status: 200,
      title: "РБК",
      contentType: "text/html",
      extractor: "stealth:chrome:direct",
      extractMode: "markdown",
      text: "# РБК\n\nНовости",
      rawLength: 15,
      truncated: false,
      tookMs: 4321,
      cached: false,
    });
    expect(String(result.text)).not.toContain("EXTERNAL_UNTRUSTED_CONTENT");
    expect(result.warning).toMatch(/cascade: http:direct=blocked:qrator; served by chrome:direct/);
    expect(typeof result.fetchedAt).toBe("string");

    expect(sidecar.requests).toHaveLength(1);
    const [req] = sidecar.requests;
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/fetch");
    expect(req.body).toEqual({
      url: "https://www.rbc.ru/",
      extractMode: "markdown",
      maxChars: 20000,
      egress: "direct",
      method: "auto",
      timeoutSeconds: 95,
    });
  });

  it("timeoutSeconds, отправляемый сайдкару, не превышает 110", async () => {
    const { tool } = providerTool({ sidecar: { baseUrl: sidecar.baseUrl, timeoutSeconds: 120 }, firecrawlFallback: false });
    await tool.execute({ url: "https://example.com/", extractMode: "text" }, {});
    expect(sidecar.requests[0]?.body).toMatchObject({ extractMode: "text", timeoutSeconds: 110 });
    expect(sidecar.requests[0]?.body).not.toHaveProperty("maxChars");
  });

  it("без warning, если сработал первый слой и egress совпал", async () => {
    const { tool } = providerTool({ sidecar: { baseUrl: sidecar.baseUrl }, firecrawlFallback: false });
    const result = await tool.execute({ url: "https://example.com/", extractMode: "markdown" }, {});
    expect(result.warning).toBeUndefined();
    expect(result.extractor).toBe("stealth:http:direct");
  });

  it("ok:false и откат выключен → throw с protection", async () => {
    sidecar.setHandler((request, res) =>
      sendJson(res, 200, {
        ok: false,
        url: request.body?.url,
        finalUrl: request.body?.url,
        status: 403,
        protection: "cloudflare-turnstile",
        error: "challenge not solved after camoufox",
        layers: [{ method: "http", egress: "direct", result: "challenge" }],
        tookMs: 50000,
      }),
    );
    const { tool } = providerTool({ sidecar: { baseUrl: sidecar.baseUrl }, firecrawlFallback: false });
    const promise = tool.execute({ url: "https://protected.example.com/", extractMode: "markdown" }, {});
    await expect(promise).rejects.toBeInstanceOf(SidecarBlockedError);
    await expect(promise).rejects.toThrow("Stealth fetch blocked by cloudflare-turnstile: cascade_exhausted");
  });

  it("сайдкар недоступен (ECONNREFUSED) и откат выключен → понятная ошибка", async () => {
    const port = await freeLoopbackPort();
    const { tool } = providerTool({ sidecar: { baseUrl: `http://127.0.0.1:${port}` }, firecrawlFallback: false });
    const promise = tool.execute({ url: "https://example.com/", extractMode: "markdown" }, {});
    await expect(promise).rejects.toBeInstanceOf(SidecarUnavailableError);
    await expect(promise).rejects.toThrow(/stealth-fetch sidecar unavailable \(systemctl status stealth-fetch\): sidecar transport_failed/);
  });

  it("5xx сайдкара → unavailable", async () => {
    sidecar.setHandler((_request, res) => sendJson(res, 500, { error: "boom" }));
    const { tool } = providerTool({ sidecar: { baseUrl: sidecar.baseUrl }, firecrawlFallback: false });
    await expect(tool.execute({ url: "https://example.com/", extractMode: "markdown" }, {})).rejects.toThrow(/sidecar unavailable .*HTTP 500: sidecar_request_failed/);
  });

  it("503 busy → до двух повторов, затем успех", async () => {
    let calls = 0;
    sidecar.setHandler((request, res) => {
      calls += 1;
      if (calls <= 2) {
        sendJson(res, 503, { error: "busy" });
        return;
      }
      sendJson(res, 200, okPayload({ url: String(request.body?.url) }));
    });
    const { tool } = providerTool({ sidecar: { baseUrl: sidecar.baseUrl }, firecrawlFallback: false });
    const result = await tool.execute({ url: "https://example.com/", extractMode: "markdown" }, {});
    expect(result.status).toBe(200);
    expect(calls).toBe(3);
  });

  it("503 busy трижды → unavailable", async () => {
    sidecar.setHandler((_request, res) => sendJson(res, 503, { error: "busy" }));
    const { tool } = providerTool({ sidecar: { baseUrl: sidecar.baseUrl }, firecrawlFallback: false });
    await expect(tool.execute({ url: "https://example.com/", extractMode: "markdown" }, {})).rejects.toThrow(/busy \(503\) after 3 attempts/);
    expect(sidecar.requests).toHaveLength(3);
  });

  it("400 сайдкара → ошибка без отката; 403 → SSRF-блок", async () => {
    sidecar.setHandler((_request, res) => sendJson(res, 400, { error: "invalid url" }));
    const fc = fakeFirecrawl(() => ({ status: 200, body: { success: true, data: { markdown: "x" } } }));
    const { tool } = providerTool({ sidecar: { baseUrl: sidecar.baseUrl }, firecrawlFallback: true }, { firecrawlFetchImpl: fc.fetchImpl });
    await expect(tool.execute({ url: "https://example.com/%", extractMode: "markdown" }, {})).rejects.toThrow(/rejected the URL: sidecar_request_failed/);
    sidecar.setHandler((_request, res) => sendJson(res, 403, { error: "ssrf: resolves to 10.0.0.1" }));
    await expect(tool.execute({ url: "https://internal.example.com/", extractMode: "markdown" }, {})).rejects.toThrow(/SSRF policy/);
    expect(fc.calls).toHaveLength(0);
  });

  it("SSRF-URL отклоняются до обращения к сайдкару", async () => {
    const { tool } = providerTool({ sidecar: { baseUrl: sidecar.baseUrl }, firecrawlFallback: true });
    for (const url of ["http://127.0.0.1:18789/", "http://10.0.0.1/", "http://localhost/", "http://169.254.169.254/latest", "http://[::1]:18789/", "ftp://example.com/x"]) {
      await expect(tool.execute({ url, extractMode: "markdown" }, {}), url).rejects.toThrow(/Blocked/);
    }
    await expect(tool.execute({ url: "", extractMode: "markdown" }, {})).rejects.toThrow(/url is required/);
    await expect(tool.execute({ url: "nonsense", extractMode: "markdown" }, {})).rejects.toThrow(/Invalid URL/);
    expect(sidecar.requests).toHaveLength(0);
  });

  it("abort через signal прерывает запрос к сайдкару", async () => {
    let sawRequest = false;
    sidecar.setHandler(async (request, res) => {
      sawRequest = true;
      await new Promise((resolve) => setTimeout(resolve, 3000));
      if (!res.destroyed) {
        sendJson(res, 200, okPayload({ url: String(request.body?.url) }));
      }
    });
    const { tool } = providerTool({ sidecar: { baseUrl: sidecar.baseUrl }, firecrawlFallback: true });
    const controller = new AbortController();
    const startedAt = Date.now();
    const promise = tool.execute({ url: "https://example.com/", extractMode: "markdown" }, { signal: controller.signal });
    setTimeout(() => controller.abort(new Error("test abort")), 100);
    await expect(promise).rejects.toThrow("aborted");
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(sawRequest).toBe(true);
  });

  it("невалидный sidecar.baseUrl (не loopback) → ошибка конфигурации, сайдкар не вызывается", async () => {
    const { tool } = providerTool({ sidecar: { baseUrl: "http://10.0.0.5:18801" } });
    await expect(tool.execute({ url: "https://example.com/", extractMode: "markdown" }, {})).rejects.toThrow(/sidecar\.baseUrl must point to a loopback address/);
    expect(sidecar.requests).toHaveLength(0);
  });
});

describe("провайдер stealth: keyless Firecrawl", () => {
  it("ok:false + откат включён → keyless Firecrawl, extractor stealth:firecrawl, без Authorization", async () => {
    sidecar.setHandler((request, res) =>
      sendJson(res, 200, { ok: false, url: request.body?.url, protection: "qrator", error: "all layers blocked", layers: [{ method: "chrome", egress: "direct", result: "blocked" }] }),
    );
    const fc = fakeFirecrawl(() => ({
      status: 200,
      body: { success: true, data: { markdown: "# From Firecrawl\n\nbody", metadata: { title: "FC title", sourceURL: "https://protected.example.com/page", statusCode: 200 } } },
    }));
    const { tool } = providerTool({ sidecar: { baseUrl: sidecar.baseUrl }, firecrawlFallback: true }, { firecrawlFetchImpl: fc.fetchImpl });
    const result = await tool.execute({ url: "https://protected.example.com/", extractMode: "markdown" }, {});

    expect(result).toMatchObject({
      finalUrl: "https://protected.example.com/page",
      status: 200,
      title: "FC title",
      extractor: "stealth:firecrawl",
      text: "# From Firecrawl\n\nbody",
    });
    expect(result.warning).toMatch(/blocked by qrator.*served by keyless Firecrawl/);

    expect(fc.calls).toHaveLength(1);
    const [call] = fc.calls;
    expect(call.url).toBe("https://api.firecrawl.dev/v2/scrape");
    expect(call.init.method).toBe("POST");
    const headers = call.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain("authorization");
    expect(call.body).toEqual({
      url: "https://protected.example.com/",
      formats: ["markdown"],
      onlyMainContent: true,
      timeout: 60000,
      maxAge: 172800000,
      proxy: "auto",
      storeInCache: true,
    });
  });

  it("сайдкар недоступен + откат включён → Firecrawl; extractMode text → plain", async () => {
    const port = await freeLoopbackPort();
    const fc = fakeFirecrawl(() => ({ status: 200, body: { success: true, data: { markdown: "# Title\n\nSome **bold** text", metadata: { statusCode: 200 } } } }));
    const { tool } = providerTool({ sidecar: { baseUrl: `http://127.0.0.1:${port}` }, firecrawlFallback: true }, { firecrawlFetchImpl: fc.fetchImpl });
    const result = await tool.execute({ url: "https://example.com/", extractMode: "text" }, {});
    expect(result.extractor).toBe("stealth:firecrawl");
    expect(String(result.text)).not.toMatch(/^# /);
    expect(result.warning).toMatch(/sidecar unavailable; served by keyless Firecrawl/);
  });

  it("Firecrawl вернул страницу капчи (Yandex SmartCaptcha) → ошибка, а не контент", async () => {
    sidecar.setHandler((request, res) =>
      sendJson(res, 200, {
        ok: false,
        url: request.body?.url,
        protection: "smartcaptcha",
        error: "smartcaptcha on all layers",
        layers: [
          { method: "http", egress: "direct", result: "captcha" },
          { method: "chrome", egress: "direct", result: "captcha" },
        ],
      }),
    );
    const fc = fakeFirecrawl(() => ({
      status: 200,
      body: {
        success: true,
        data: {
          markdown: "Please confirm that you are not a robot\n\n![](https://yandex.ru/captcha.png)\n\nYandex SmartCaptcha",
          metadata: { title: "Are you not a robot?", sourceURL: "https://yandex.ru/showcaptcha?cc=1&retpath=https%3A%2F%2Fyandex.ru%2Fsearch%2F%3Ftext%3Dexample", statusCode: 200 },
        },
      },
    }));
    const { tool } = providerTool({ sidecar: { baseUrl: sidecar.baseUrl }, firecrawlFallback: true }, { firecrawlFetchImpl: fc.fetchImpl });
    const promise = tool.execute({ url: "https://yandex.ru/search/?text=example+query", extractMode: "markdown" }, {});
    await expect(promise).rejects.toBeInstanceOf(SidecarBlockedError);
    await expect(promise).rejects.toThrow(
      /^Stealth fetch blocked by smartcaptcha: cascade_exhausted; Firecrawl fallback returned a challenge page \(yandex-smartcaptcha; finalUrl/,
    );
    expect(fc.calls).toHaveLength(1);
  });

  it("Firecrawl вернул капчу без показательного finalUrl — ловится по title/тексту; сайдкар недоступен", async () => {
    const port = await freeLoopbackPort();
    const fc = fakeFirecrawl(() => ({
      status: 200,
      body: { success: true, data: { markdown: "Verify you are human by completing the action below.", metadata: { title: "Just a moment...", sourceURL: "https://protected.example.com/", statusCode: 200 } } },
    }));
    const { tool } = providerTool({ sidecar: { baseUrl: `http://127.0.0.1:${port}` }, firecrawlFallback: true }, { firecrawlFetchImpl: fc.fetchImpl });
    const promise = tool.execute({ url: "https://protected.example.com/", extractMode: "markdown" }, {});
    await expect(promise).rejects.toBeInstanceOf(SidecarUnavailableError);
    await expect(promise).rejects.toThrow(/sidecar unavailable .*; Firecrawl fallback returned a challenge page \(cloudflare-challenge; title\)/);
  });

  it("Firecrawl вернул нормальный текст с 'подозрительным' словом в длинной статье → контент как раньше", async () => {
    sidecar.setHandler((request, res) => sendJson(res, 200, { ok: false, url: request.body?.url, protection: "qrator", error: "blocked", layers: [] }));
    const article = `# Обзор антибот-систем\n\n${"Текст статьи о защите сайтов. ".repeat(80)}Yandex SmartCaptcha просит confirm that you are not a robot.`;
    const fc = fakeFirecrawl(() => ({ status: 200, body: { success: true, data: { markdown: article, metadata: { title: "Обзор антибот-систем", sourceURL: "https://blog.example/antibot", statusCode: 200 } } } }));
    const { tool } = providerTool({ sidecar: { baseUrl: sidecar.baseUrl }, firecrawlFallback: true }, { firecrawlFetchImpl: fc.fetchImpl });
    const result = await tool.execute({ url: "https://blog.example/antibot", extractMode: "markdown" }, {});
    expect(result.extractor).toBe("stealth:firecrawl");
    expect(result.text).toBe(article);
    expect(result.title).toBe("Обзор антибот-систем");
  });

  it("откат тоже упал → ошибка содержит и protection, и причину Firecrawl", async () => {
    sidecar.setHandler((request, res) => sendJson(res, 200, { ok: false, url: request.body?.url, protection: "cloudflare", error: "challenge", layers: [] }));
    const fc = fakeFirecrawl(() => ({ status: 402, body: { success: false, error: "Payment Required" } }));
    const { tool } = providerTool({ sidecar: { baseUrl: sidecar.baseUrl }, firecrawlFallback: true }, { firecrawlFetchImpl: fc.fetchImpl });
    await expect(tool.execute({ url: "https://example.com/", extractMode: "markdown" }, {})).rejects.toThrow(
      /Stealth fetch blocked by cloudflare: cascade_exhausted; Firecrawl fallback failed/,
    );
  });
});
