import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIDECAR_BASE_URL,
  DEFAULT_SIDECAR_TIMEOUT_SECONDS,
  StealthConfigError,
  resolvePluginConfig,
  resolveToolDefaultMaxChars,
  validateSidecarBaseUrl,
} from "../src/config.js";
import { openclawConfig } from "./helpers.js";

describe("sidecar.baseUrl: только loopback", () => {
  it("принимает 127.0.0.1, localhost и [::1] и нормализует слэш", () => {
    expect(validateSidecarBaseUrl("http://127.0.0.1:18801")).toBe("http://127.0.0.1:18801");
    expect(validateSidecarBaseUrl("http://127.0.0.1:18801/")).toBe("http://127.0.0.1:18801");
    expect(validateSidecarBaseUrl("http://localhost:18801")).toBe("http://localhost:18801");
    expect(validateSidecarBaseUrl("http://[::1]:18801")).toBe("http://[::1]:18801");
    expect(validateSidecarBaseUrl(undefined)).toBe(DEFAULT_SIDECAR_BASE_URL);
    expect(validateSidecarBaseUrl("")).toBe(DEFAULT_SIDECAR_BASE_URL);
  });

  it("отклоняет не-loopback хосты, чужие схемы и креды", () => {
    expect(() => validateSidecarBaseUrl("http://10.0.0.5:18801")).toThrow(StealthConfigError);
    expect(() => validateSidecarBaseUrl("http://10.0.0.5:18801")).toThrow(/loopback/);
    expect(() => validateSidecarBaseUrl("http://stealth.example.com")).toThrow(/loopback/);
    expect(() => validateSidecarBaseUrl("http://0.0.0.0:18801")).toThrow(/loopback/);
    expect(() => validateSidecarBaseUrl("ftp://127.0.0.1:18801")).toThrow(/http:\/\/ or https:\/\//);
    expect(() => validateSidecarBaseUrl("http://user:pw@127.0.0.1:18801")).toThrow(/credentials/);
    expect(() => validateSidecarBaseUrl("not a url")).toThrow(/valid URL/);
  });
});

describe("resolvePluginConfig", () => {
  it("дефолты без конфига", () => {
    expect(resolvePluginConfig()).toEqual({
      sidecarBaseUrl: DEFAULT_SIDECAR_BASE_URL,
      sidecarTimeoutSeconds: DEFAULT_SIDECAR_TIMEOUT_SECONDS,
      firecrawlFallback: false,
      defaultEgress: "auto",
    });
  });

  it("живой конфиг ядра приоритетнее снимка pluginConfig; timeout режется до 120", () => {
    const cfg = resolvePluginConfig({
      config: openclawConfig({ sidecar: { baseUrl: "http://localhost:19999/", timeoutSeconds: 500 }, firecrawlFallback: false, defaultEgress: "ru" }),
      pluginConfig: { sidecar: { baseUrl: "http://127.0.0.1:1" } },
    });
    expect(cfg).toEqual({ sidecarBaseUrl: "http://localhost:19999", sidecarTimeoutSeconds: 120, firecrawlFallback: false, defaultEgress: "ru" });
  });

  it("снимок pluginConfig используется, если в живом конфиге записи нет", () => {
    const cfg = resolvePluginConfig({ config: { plugins: { entries: {} } }, pluginConfig: { defaultEgress: "direct", sidecar: { timeoutSeconds: 3 } } });
    expect(cfg.defaultEgress).toBe("direct");
    expect(cfg.sidecarTimeoutSeconds).toBe(5);
  });

  it("невалидные значения → StealthConfigError", () => {
    expect(() => resolvePluginConfig({ pluginConfig: { defaultEgress: "tor" } })).toThrow(/defaultEgress/);
    expect(() => resolvePluginConfig({ pluginConfig: { sidecar: { timeoutSeconds: -1 } } })).toThrow(/timeoutSeconds/);
    expect(() => resolvePluginConfig({ pluginConfig: { sidecar: { baseUrl: "http://192.168.0.1:18801" } } })).toThrow(/loopback/);
  });
});

describe("resolveToolDefaultMaxChars", () => {
  it("50000 по умолчанию, иначе tools.web.fetch.maxChars с учётом maxCharsCap", () => {
    expect(resolveToolDefaultMaxChars(undefined)).toBe(50_000);
    expect(resolveToolDefaultMaxChars({ tools: { web: { fetch: { maxChars: 20_000 } } } })).toBe(20_000);
    expect(resolveToolDefaultMaxChars({ tools: { web: { fetch: { maxChars: 80_000, maxCharsCap: 30_000 } } } })).toBe(30_000);
    expect(resolveToolDefaultMaxChars({ tools: { web: { fetch: { maxCharsCap: 10_000 } } } })).toBe(10_000);
  });
});
