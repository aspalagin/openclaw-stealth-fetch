import { describe, expect, it } from "vitest";
import { CHALLENGE_BODY_MAX_CHARS, detectChallengePage } from "../src/challenge.js";

const YANDEX_CAPTCHA_MD =
  "Please confirm that you are not a robot\n\n![](https://yandex.ru/captcha.png)\n\n" +
  "Yandex SmartCaptcha\n\nIf you have problems with the task, please contact support.";

describe("detectChallengePage", () => {
  it("Yandex SmartCaptcha: по finalUrl /showcaptcha", () => {
    const hit = detectChallengePage({ finalUrl: "https://yandex.ru/showcaptcha?cc=1&retpath=https%3A%2F%2Fyandex.ru%2Fsearch", title: "x", text: "y" });
    expect(hit?.protection).toBe("yandex-smartcaptcha");
    expect(hit?.reason).toBe("finalUrl");
  });

  it("Yandex SmartCaptcha: по title и по тексту", () => {
    expect(detectChallengePage({ finalUrl: "https://yandex.ru/search/?text=example", title: "Are you not a robot?", text: "ok" })?.protection).toBe("yandex-smartcaptcha");
    expect(detectChallengePage({ title: "Вы не робот?" })?.protection).toBe("yandex-smartcaptcha");
    const byBody = detectChallengePage({ finalUrl: "https://yandex.ru/search/?text=example", title: "Яндекс", text: YANDEX_CAPTCHA_MD });
    expect(byBody?.protection).toBe("yandex-smartcaptcha");
    expect(byBody?.reason).toBe("body");
  });

  it("другие URL-паттерны", () => {
    expect(detectChallengePage({ finalUrl: "https://www.google.com/sorry/index?continue=x" })?.protection).toBe("google-sorry");
    expect(detectChallengePage({ finalUrl: "https://site.example/xpvnsulc/abc" })?.protection).toBe("challenge-redirect");
    expect(detectChallengePage({ finalUrl: "https://site.example/cdn-cgi/challenge-platform/h/b/orchestrate" })?.protection).toBe("cloudflare-challenge");
    // паттерн только в хосте, а не в пути — не заглушка
    expect(detectChallengePage({ finalUrl: "https://showcaptcha.example/" })).toBeUndefined();
  });

  it("титулы Cloudflare / DDoS-Guard / Access denied / прочие", () => {
    expect(detectChallengePage({ title: "Just a moment..." })?.protection).toBe("cloudflare-challenge");
    expect(detectChallengePage({ title: "Attention Required! | Cloudflare" })?.protection).toBe("cloudflare-block");
    expect(detectChallengePage({ title: "Security Verification" })?.protection).toBe("challenge");
    expect(detectChallengePage({ title: "Prove your humanity" })?.protection).toBe("challenge");
    expect(detectChallengePage({ title: "Are you a robot?" })?.protection).toBe("captcha");
    expect(detectChallengePage({ title: "Access Denied" })?.protection).toBe("access-denied");
    expect(detectChallengePage({ title: "DDoS-Guard" })?.protection).toBe("ddos-guard");
  });

  it("фразы в коротком теле", () => {
    expect(detectChallengePage({ text: "Verify you are human by completing the action below." })?.protection).toBe("cloudflare-turnstile");
    expect(detectChallengePage({ text: "Please enable JavaScript and cookies to continue" })?.protection).toBe("cloudflare-challenge");
    expect(detectChallengePage({ text: "Press & Hold to confirm you are a human (and not a bot)." })?.protection).toBe("datadome");
    expect(detectChallengePage({ text: "Press &amp; Hold" })?.protection).toBe("datadome");
    expect(detectChallengePage({ text: "<script src=\"https://ct.captcha-delivery.com/c.js\"></script>" })?.protection).toBe("datadome");
    expect(detectChallengePage({ text: "The request was blocked by network security." })?.protection).toBe("network-security-block");
  });

  it("длинная страница с теми же фразами — не заглушка (статья про капчи)", () => {
    const article = `${"Lorem ipsum dolor sit amet. ".repeat(80)} Our review of Yandex SmartCaptcha: it asks you to confirm that you are not a robot.`;
    expect(article.length).toBeGreaterThan(CHALLENGE_BODY_MAX_CHARS);
    expect(detectChallengePage({ finalUrl: "https://blog.example/captcha-review", title: "Captcha review", text: article })).toBeUndefined();
  });

  it("обычная страница — не заглушка", () => {
    expect(detectChallengePage({ finalUrl: "https://www.kommersant.ru/", title: "Коммерсантъ — новости", text: "# Новости\n\nТекст статьи." })).toBeUndefined();
    expect(detectChallengePage({})).toBeUndefined();
    expect(detectChallengePage({ finalUrl: "not a url", title: "", text: "" })).toBeUndefined();
  });
});
