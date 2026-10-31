import { describe, expect, it } from "vitest";
import plugin from "../index.js";

describe("plugin entry", () => {
  it("регистрирует провайдер stealth и инструмент fetch_stealth", () => {
    const providers: Array<{ id: string }> = [];
    const tools: Array<{ tool: unknown; opts?: { name?: string; optional?: boolean } }> = [];
    const logs: string[] = [];
    const api = {
      id: "openclaw-stealth-fetch",
      name: "Stealth Fetch",
      registrationMode: "full",
      config: { plugins: { entries: { "openclaw-stealth-fetch": { enabled: true, config: { sidecar: { baseUrl: "http://127.0.0.1:18801" } } } } } },
      pluginConfig: { sidecar: { baseUrl: "http://127.0.0.1:18801" } },
      logger: { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m), debug: () => undefined },
      registerWebFetchProvider: (provider: { id: string }) => providers.push(provider),
      registerTool: (tool: unknown, opts?: { name?: string; optional?: boolean }) => tools.push({ tool, opts }),
    };
    expect(plugin.id).toBe("openclaw-stealth-fetch");
    plugin.register(api as never);
    expect(providers.map((p) => p.id)).toEqual(["stealth"]);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.opts).toEqual({ name: "fetch_stealth" });
    const factory = tools[0]?.tool as (ctx: Record<string, unknown>) => { name: string };
    expect(typeof factory).toBe("function");
    expect(factory({ config: api.config }).name).toBe("fetch_stealth");
    expect(logs.join("\n")).toContain("mode=full");
    expect(logs.join("\n")).toMatch(/v0\.1\.2 .*registered;.*timeout=90s egress=auto firecrawlFallback=false/);
  });

  it("невалидный конфиг логируется, но регистрация не падает", () => {
    const logs: string[] = [];
    const api = {
      id: "openclaw-stealth-fetch",
      name: "Stealth Fetch",
      config: {},
      pluginConfig: { sidecar: { baseUrl: "http://10.1.1.1:18801" } },
      logger: { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m), debug: () => undefined },
      registerWebFetchProvider: () => undefined,
      registerTool: () => undefined,
    };
    expect(() => plugin.register(api as never)).not.toThrow();
    expect(logs.join("\n")).toMatch(/sidecar\.baseUrl must point to a loopback address/);
  });
});
