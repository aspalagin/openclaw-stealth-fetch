/**
 * Общие типы плагина: контракт сайдкара stealth-fetch и вспомогательные типы.
 */

export type FetchLike = typeof fetch;

export interface PluginLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug?(message: string): void;
}

export type Egress = "auto" | "ru" | "direct";
export type StealthMethod = "auto" | "http" | "chrome" | "camoufox" | "jina";
export type ExtractMode = "markdown" | "text";

export const EGRESS_VALUES: readonly Egress[] = ["auto", "ru", "direct"];
export const METHOD_VALUES: readonly StealthMethod[] = ["auto", "http", "chrome", "camoufox", "jina"];

/** Тело POST /fetch сайдкара (контракт зафиксирован 31.10.2026). */
export interface SidecarFetchRequest {
  url: string;
  extractMode: ExtractMode;
  maxChars?: number;
  egress: Egress;
  method: StealthMethod;
  timeoutSeconds?: number;
  noCache?: boolean;
}

export interface SidecarLayer {
  method: string;
  egress: string;
  result: string;
  tookMs?: number;
}

/** 200 {"ok":true,…} */
export interface SidecarFetchOk {
  ok: true;
  url: string;
  finalUrl: string;
  status: number;
  title?: string;
  contentType?: string;
  method: string;
  egress: string;
  extractor?: string;
  text: string;
  rawLength: number;
  truncated: boolean;
  tookMs: number;
  cached?: boolean;
  layers: SidecarLayer[];
}

/** 200 {"ok":false,…} — каскад не пробил защиту. */
export interface SidecarFetchBlocked {
  ok: false;
  url: string;
  finalUrl?: string;
  status?: number;
  protection?: string;
  error?: string;
  layers: SidecarLayer[];
  tookMs?: number;
}

export interface SidecarHealth {
  ok: boolean;
  version?: string;
  browsers?: Record<string, unknown>;
  egress?: { ru?: { up?: boolean; ip?: string } };
  queue?: Record<string, unknown>;
}

/** Нормализованный результат стелс-загрузки (сайдкар либо Firecrawl-откат). */
export interface StealthFetchResult {
  url: string;
  finalUrl: string;
  status: number;
  title?: string;
  contentType?: string;
  /** stealth:<method>:<egress> либо stealth:firecrawl */
  extractor: string;
  method: string;
  egress: string;
  /** Сырой текст (markdown или plain) без обёртки внешнего контента. */
  text: string;
  rawLength: number;
  truncated: boolean;
  tookMs: number;
  cached?: boolean;
  warning?: string;
  layers?: SidecarLayer[];
  fallback?: "firecrawl";
}
