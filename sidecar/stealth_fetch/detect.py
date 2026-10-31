"""Challenge-page detection using title, URL and short-body signatures.

Classification rules:
  1. сигнатура по <title>/финальному URL → block (login-redirect → empty, consent → empty);
  2. статус ∈ BLOCK_STATUS и видимого текста < 3000 → block (имя — body-сигнатура либо http-<status>);
  3. body-сигнатура (кроме «captcha»/«robot-check») при видимом тексте < 2500 → block;
  4. видимого текста < 500 → empty (JS-оболочка/редирект на логин);
  5. иначе ok.
Слово «captcha» в формах логина (cnews, habr) и «akamai» в скриптах Bing не считаются заглушкой.
"""
from __future__ import annotations

import html as htmlmod
import re
from dataclasses import dataclass

BLOCK_STATUS = {401, 403, 405, 406, 407, 409, 412, 418, 421, 429, 451, 500, 502, 503, 999}
BODY_SIG_MAX_TEXT = 2500  # видимого текста меньше — страница подозрительна, смотрим body-сигнатуры
OK_MIN_TEXT = 500         # меньше — «пустая/JS-оболочка»
BLOCK_MAX_TEXT = 3000     # при блокирующем статусе и тексте короче — блок
SMALL_HTML = 4096         # HTML короче — статическая страница, а не JS-оболочка (при тексте ≥ 40 и 2xx)

# Нормализованные имена защиты (контракт /fetch → protection).
PROTECTIONS = {
    "cloudflare", "ddos-guard", "qrator", "servicepipe", "smartcaptcha", "google", "perimeterx",
    "datadome", "variti", "reddit", "ddg", "js-shell", "login-redirect", "unknown",
}

# TITLE/URL-сигнатуры: надёжные, проверяются по <title> и финальному URL.
TITLE_SIGS: list[tuple[str, str]] = [
    ("cloudflare", r"just a moment|attention required!|security verification|cdn-cgi/challenge|__cf_chl"),
    ("ddos-guard", r"ddos-guard|check\.ddos-guard"),
    ("smartcaptcha", r"are you not a robot|showcaptcha|smartcaptcha|вы не робот\?|подтвердите, что запросы"),
    ("google", r"/sorry/index|unusual traffic"),
    ("consent", r"consent\.google\.com|before you continue to google"),
    ("servicepipe", r"/xpvnsulc/|hcheck="),
    ("perimeterx", r"are you a robot\?|press & hold"),
    ("reddit", r"prove your humanity|whoa there, pardner|blocked by network security"),
    ("ddg", r"bots use duckduckgo too|anomaly"),
    ("cloudflare", r"всё в порядке, но|все в порядке, но"),  # 4PDA (Cloudflare + своя проверка)
    ("login-redirect", r"passport\.yandex|authwall|linkedin\.com/checkpoint|linkedin\.com/uas/login"),
    ("unknown", r"access denied|verifying your browser|checking your browser|доступ ограничен|доступ запрещ|похоже, вы робот"),
]

# BODY-сигнатуры: проверяются по HTML только при коротком видимом тексте (< BODY_SIG_MAX_TEXT).
BODY_SIGS: list[tuple[str, str]] = [
    ("cloudflare", r"cf-chl|challenge-platform|cf_chl_opt|cf-browser-verification|cf-error-details|verify you are human|checking if the site connection is secure|enable javascript and cookies to continue"),
    ("ddos-guard", r"ddos-guard|__ddg[0-9_]|ddg-captcha"),
    ("qrator", r"qrator"),
    ("smartcaptcha", r"smartcaptcha|captcha\.yandex|нам очень жаль, но запросы"),
    ("google", r"having trouble accessing google search|enablejs"),
    ("ddg", r"bots use duckduckgo too"),
    ("variti", r"variti"),
    ("servicepipe", r"servicepipe|убедиться, что имеем дело именно с вами"),
    ("perimeterx", r"_pxhc|px-captcha|perimeterx|human-challenge"),
    ("reddit", r"blocked by network security|prove your humanity"),
    ("unknown", r"errors\.edgesuite\.net|reference #[0-9a-f.]{8,}"),  # akamai
    ("datadome", r"datadome|captcha-delivery\.com"),
    ("js-shell", r"javascript is not available|something went wrong, but don.t fret"),  # X
    ("unknown", r"access denied|verifying your browser|checking your browser|подозрительн\w+ активност|прошу подтвердить, что вы не робот|please enable js and disable any ad blocker"),
    ("captcha", r"captcha"),
    ("robot-check", r"not a robot|не робот|robot check"),
]
_SOFT_BODY = {"captcha", "robot-check"}  # сами по себе не блок (формы логина)

# Признаки ещё идущего JS-челленджа — браузерный слой ждёт их исчезновения до 20 с.
CHALLENGE_RX = re.compile(
    r"just a moment|ddos-guard|checking your browser|verifying|один момент|подождите|"
    r"verification successful|waiting for .{0,40} to respond|/xpvnsulc/|showcaptcha|cf-chl",
    re.I,
)

_TAG_BLOCKS = re.compile(r"(?is)<(script|style|noscript|svg|template)[^>]*>.*?</\1>")
_TAGS = re.compile(r"(?s)<[^>]+>")
_WS = re.compile(r"\s+")
_TITLE = re.compile(r"(?is)<title[^>]*>(.*?)</title>")
_SCRIPT = re.compile(r"(?i)<script\b")


def strip_text(h: str) -> str:
    """Видимый текст: без script/style/noscript/svg, тегов и лишних пробелов."""
    if not h:
        return ""
    h = _TAG_BLOCKS.sub(" ", h)
    h = _TAGS.sub(" ", h)
    h = htmlmod.unescape(h)
    return _WS.sub(" ", h).strip()


def title_of(h: str) -> str:
    m = _TITLE.search(h or "")
    return _WS.sub(" ", htmlmod.unescape(m.group(1))).strip()[:200] if m else ""


@dataclass
class Verdict:
    kind: str            # ok | block | empty
    protection: str      # имя защиты (для block/empty) или "" / пометка
    text_len: int        # длина видимого текста
    title: str

    @property
    def ok(self) -> bool:
        return self.kind == "ok"

    def label(self) -> str:
        """Короткая метка для layers[].result: ok | blocked:<protection> | empty."""
        if self.kind == "ok":
            return "ok"
        if self.kind == "block":
            return f"blocked:{self.protection or 'unknown'}"
        return "empty" if not self.protection or self.protection == "js-shell" else f"empty:{self.protection}"


def classify(status: int, h: str, final_url: str, text_len: int | None = None) -> Verdict:
    """Классификация ответа. text_len — длина ВИДИМОГО текста (strip_text), не article-экстракта."""
    h = h or ""
    if text_len is None:
        text_len = len(strip_text(h))
    title = title_of(h)
    probe = f"{title}\n{final_url or ''}"
    for name, rx in TITLE_SIGS:
        if re.search(rx, probe, re.I):
            if name == "consent":
                return Verdict("empty", "login-redirect", text_len, title)
            if name == "login-redirect":
                return Verdict("empty", "login-redirect", text_len, title)
            return Verdict("block", name, text_len, title)
    body_sig = None
    if text_len < BODY_SIG_MAX_TEXT:
        for name, rx in BODY_SIGS:
            if re.search(rx, h, re.I):
                body_sig = name
                break
    if status in BLOCK_STATUS and text_len < BLOCK_MAX_TEXT:
        prot = body_sig if body_sig and body_sig not in _SOFT_BODY else "unknown"
        return Verdict("block", prot, text_len, title)
    if body_sig and body_sig not in _SOFT_BODY:
        return Verdict("block", body_sig, text_len, title)
    if text_len < OK_MIN_TEXT:
        # Короткая статическая страница (example.com: 577 байт HTML, один <script src>) — не JS-оболочка:
        # оболочки несут крупные бандлы/preload (reddit 190 КБ), а заглушки с коротким HTML уже пойманы сигнатурами.
        if text_len >= 40 and 200 <= status < 300 and (not _SCRIPT.search(h) or len(h) < SMALL_HTML):
            return Verdict("ok", "", text_len, title)
        return Verdict("empty", "js-shell", text_len, title)
    return Verdict("ok", "", text_len, title)


def challenge_in_progress(h: str) -> bool:
    """Страница ещё показывает JS-челлендж (по title и началу тела)."""
    if not h:
        return False
    return bool(CHALLENGE_RX.search(title_of(h) + "\n" + h[:3000]))
