import { diagnosticLabel, diagnosticReason } from "./diagnostics.js";
/**
 * Детекция антибот-заглушек в результате Firecrawl-отката.
 *
 * Firecrawl без ключа честно отдаёт HTTP 200 со страницей капчи (Yandex SmartCaptcha, Cloudflare
 * «Just a moment…», DataDome «Press & Hold» и т. п.). Такой «успех» нельзя отдавать модели как контент:
 * признаки ищутся в finalUrl, title и — для коротких страниц — в тексте.
 */

export interface ChallengeDetection {
  /** Короткая метка защиты: yandex-smartcaptcha, cloudflare-challenge, datadome, … */
  protection: string;
  /** Что именно совпало — для сообщения об ошибке и лога. */
  reason: string;
}

export interface ChallengeCandidate {
  finalUrl?: string;
  title?: string;
  text?: string;
}

/** Страницы длиннее этого порога по тексту не проверяются: у реального контента фразы могут встретиться в статье. */
export const CHALLENGE_BODY_MAX_CHARS = 1_500;

interface Pattern {
  re: RegExp;
  protection: string;
}

const URL_PATTERNS: Pattern[] = [
  { re: /\/showcaptcha/i, protection: "yandex-smartcaptcha" },
  { re: /\/sorry\//i, protection: "google-sorry" },
  { re: /\/xpvnsulc\//i, protection: "challenge-redirect" },
  { re: /cdn-cgi\/challenge/i, protection: "cloudflare-challenge" },
];

const TITLE_PATTERNS: Pattern[] = [
  { re: /are you not a robot/i, protection: "yandex-smartcaptcha" },
  { re: /вы не робот/i, protection: "yandex-smartcaptcha" },
  { re: /just a moment/i, protection: "cloudflare-challenge" },
  { re: /attention required/i, protection: "cloudflare-block" },
  { re: /security verification/i, protection: "challenge" },
  { re: /prove your humanity/i, protection: "challenge" },
  { re: /are you a robot/i, protection: "captcha" },
  { re: /access denied/i, protection: "access-denied" },
  { re: /ddos-guard/i, protection: "ddos-guard" },
];

const BODY_PATTERNS: Pattern[] = [
  { re: /confirm that you are not a robot/i, protection: "yandex-smartcaptcha" },
  { re: /smartcaptcha/i, protection: "yandex-smartcaptcha" },
  { re: /подтвердите, что запросы отправляли вы/i, protection: "yandex-smartcaptcha" },
  { re: /verify you are human/i, protection: "cloudflare-turnstile" },
  { re: /enable javascript and cookies/i, protection: "cloudflare-challenge" },
  { re: /press\s*&(?:amp;)?\s*hold/i, protection: "datadome" },
  { re: /captcha-delivery/i, protection: "datadome" },
  { re: /blocked by network security/i, protection: "network-security-block" },
];

/** Возвращает описание заглушки либо undefined, если страница выглядит как обычный контент. */
export function detectChallengePage(candidate: ChallengeCandidate): ChallengeDetection | undefined {
  const finalUrl = candidate.finalUrl?.trim() ?? "";
  if (finalUrl) {
    let pathAndQuery = finalUrl;
    try {
      const url = new URL(finalUrl);
      pathAndQuery = `${url.pathname}${url.search}`;
    } catch {
      // не URL — проверяем строку как есть
    }
    for (const pattern of URL_PATTERNS) {
      if (pattern.re.test(pathAndQuery)) {
        return { protection: pattern.protection, reason: "finalUrl" };
      }
    }
  }

  const title = candidate.title?.trim() ?? "";
  if (title) {
    for (const pattern of TITLE_PATTERNS) {
      if (pattern.re.test(title)) {
        return { protection: pattern.protection, reason: "title" };
      }
    }
  }

  const text = candidate.text?.trim() ?? "";
  if (text && text.length <= CHALLENGE_BODY_MAX_CHARS) {
    for (const pattern of BODY_PATTERNS) {
      const match = pattern.re.exec(text);
      if (match) {
        return { protection: pattern.protection, reason: "body" };
      }
    }
  }
  return undefined;
}

/** Firecrawl ответил 200, но страница — антибот-заглушка. */
export class FirecrawlChallengeError extends Error {
  readonly protection: string;
  readonly reason: string;
  constructor(detection: ChallengeDetection) {
    super(`Firecrawl fallback returned a challenge page (${diagnosticLabel(detection.protection)}; ${diagnosticReason(detection.reason)})`);
    this.name = "FirecrawlChallengeError";
    this.protection = diagnosticLabel(detection.protection);
    this.reason = diagnosticReason(detection.reason);
  }
}
