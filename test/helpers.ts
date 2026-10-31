import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { StealthPluginConfig } from "../src/config.js";
import type { SidecarFetchOk } from "../src/types.js";

export interface FakeSidecarRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown> | undefined;
}

export type FakeSidecarHandler = (
  request: FakeSidecarRequest,
  res: ServerResponse,
) => Promise<void> | void;

export interface FakeSidecar {
  baseUrl: string;
  port: number;
  requests: FakeSidecarRequest[];
  setHandler(handler: FakeSidecarHandler): void;
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

export function okPayload(overrides: Partial<SidecarFetchOk> & { url?: string } = {}): SidecarFetchOk {
  const url = overrides.url ?? "https://example.com/";
  return {
    ok: true,
    url,
    finalUrl: url,
    status: 200,
    title: "Example Domain",
    contentType: "text/html",
    method: "http",
    egress: "direct",
    extractor: "readability",
    text: "# Example Domain\n\nThis domain is for use in illustrative examples.",
    rawLength: 64,
    truncated: false,
    tookMs: 123,
    cached: false,
    layers: [{ method: "http", egress: "direct", result: "ok", tookMs: 123 }],
    ...overrides,
  };
}

/** Фейковый сайдкар на случайном порту loopback. */
export async function startFakeSidecar(initial?: FakeSidecarHandler): Promise<FakeSidecar> {
  const requests: FakeSidecarRequest[] = [];
  let handler: FakeSidecarHandler = initial ?? ((request, res) => sendJson(res, 200, okPayload({ url: String(request.body?.url ?? "") })));
  const server: Server = createServer(async (req, res) => {
    const raw = await readBody(req);
    let body: Record<string, unknown> | undefined;
    try {
      body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
    } catch {
      body = undefined;
    }
    const request: FakeSidecarRequest = { method: req.method ?? "GET", path: req.url ?? "/", headers: req.headers, body };
    requests.push(request);
    try {
      await handler(request, res);
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    requests,
    setHandler(next) {
      handler = next;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/** Порт, на котором гарантированно никто не слушает. */
export async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

export function testConfig(overrides: Partial<StealthPluginConfig> & { sidecarBaseUrl: string }): StealthPluginConfig {
  return {
    sidecarTimeoutSeconds: 90,
    firecrawlFallback: false,
    defaultEgress: "auto",
    ...overrides,
  };
}

/** Полный конфиг OpenClaw с plugins.entries.openclaw-stealth-fetch.config. */
export function openclawConfig(pluginConfig: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    plugins: { entries: { "openclaw-stealth-fetch": { enabled: true, config: pluginConfig } } },
    ...extra,
  };
}

/** Мок fetch для Firecrawl: записывает запросы и отдаёт заданный ответ. */
export function fakeFirecrawl(responder: (init: RequestInit, url: string) => { status: number; body: unknown }) {
  const calls: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const parsed = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ url, init: init ?? {}, body: parsed });
    const { status, body } = responder(init ?? {}, url);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}
