import { describe, expect, it } from "vitest";
import { assertStealthTargetAllowed } from "../src/ssrf.js";
import { resolvePluginConfig } from "../src/config.js";
import { buildFirecrawlScrapeBody } from "../src/firecrawl.js";
import { sidecarFetch, sidecarHealth } from "../src/sidecar.js";
import { startFakeSidecar } from "./helpers.js";

describe("public release guards", () => {
  it("external fallback is opt-in", () => {
    expect(resolvePluginConfig().firecrawlFallback).toBe(false);
  });
  it("rejects embedded target credentials without echoing them", () => {
    expect(() => assertStealthTargetAllowed("https://user:synthetic-marker@example.com/")).toThrow("Blocked credentials");
    try { assertStealthTargetAllowed("https://user:synthetic-marker@example.com/"); } catch (err) { expect(String(err)).not.toContain("synthetic-marker"); }
  });
  it("requests Firecrawl cache bypass when noCache is set", () => {
    expect(buildFirecrawlScrapeBody("https://example.com/", 10, true)).toMatchObject({ maxAge: 0, storeInCache: false });
    expect(buildFirecrawlScrapeBody("https://example.com/", 10)).toMatchObject({ maxAge: 172800000, storeInCache: true });
  });
  it("never forwards sidecar POST or health across redirects", async () => {
    let forwarded = 0;
    const target = await startFakeSidecar((_req, res) => { forwarded++; res.end("unexpected"); });
    const redirector = await startFakeSidecar((_req, res) => { res.writeHead(307, { location: target.baseUrl + "/leak" }); res.end(); });
    try {
      await expect(sidecarFetch({ url: "https://example.com/", extractMode: "markdown", egress: "direct", method: "http" }, { baseUrl: redirector.baseUrl })).rejects.toThrow();
      await expect(sidecarHealth({ baseUrl: redirector.baseUrl })).rejects.toThrow();
      expect(forwarded).toBe(0);
    } finally { await redirector.close(); await target.close(); }
  });
});
