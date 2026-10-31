"""Извлечение контента: trafilatura → readability-lxml + markdownify → raw; отдельный serp-экстрактор для выдач."""
from __future__ import annotations

import html as htmlmod
import logging
import re
from dataclasses import dataclass
from urllib.parse import parse_qs, urljoin, urlsplit

from .detect import strip_text, title_of

log = logging.getLogger("stealth_fetch.extract")

SERP_HOSTS = {
    "yandex": re.compile(r"(^|\.)(yandex\.(ru|com|kz|by|uz|tr)|ya\.ru)$"),
    "google": re.compile(r"(^|\.)google\.[a-z.]+$"),
    "bing": re.compile(r"(^|\.)bing\.com$"),
    "ddg": re.compile(r"(^|\.)duckduckgo\.com$"),
}


@dataclass
class Extracted:
    text: str
    extractor: str   # trafilatura | readability | serp | raw
    title: str


def serp_engine(url: str) -> str | None:
    p = urlsplit(url)
    host = (p.hostname or "").lower()
    path = p.path or "/"
    for name, rx in SERP_HOSTS.items():
        if rx.search(host):
            if name == "yandex" and path.startswith("/search"):
                return name
            if name == "google" and path.startswith("/search"):
                return name
            if name == "bing" and path.startswith("/search"):
                return name
            if name == "ddg" and (path.startswith("/html") or path.startswith("/lite") or "q=" in (p.query or "")):
                return name
    return None


def _txt(el) -> str:
    return re.sub(r"\s+", " ", " ".join(el.itertext())).strip()


def _ddg_real_url(href: str) -> str:
    # https://duckduckgo.com/l/?uddg=<encoded>&rut=...
    if "uddg=" in href:
        q = parse_qs(urlsplit(href).query)
        if q.get("uddg"):
            return q["uddg"][0]
    return href


def extract_serp(html: str, url: str, engine: str) -> list[dict[str, str]]:
    """Список результатов {title, url, snippet}. Селекторы по состоянию на 10.2026; есть общий fallback."""
    try:
        from lxml import html as lh
    except Exception:  # noqa: BLE001
        return []
    try:
        doc = lh.fromstring(html)
    except Exception:  # noqa: BLE001
        return []
    doc.make_links_absolute(url, resolve_base_href=True)
    out: list[dict[str, str]] = []
    seen: set[str] = set()

    def add(title: str, href: str, snippet: str) -> None:
        href = _ddg_real_url(href or "")
        title = re.sub(r"\s+", " ", title or "").strip()
        if not href or not href.startswith("http") or not title or href in seen:
            return
        h = urlsplit(href).hostname or ""
        if engine == "yandex" and ("yandex." in h and "/search" in href):
            return
        if engine == "google" and ("google." in h and ("/search" in href or "/preferences" in href or "accounts." in h)):
            return
        if engine == "bing" and ("bing.com" in h and "/search" in href):
            return
        seen.add(href)
        out.append({"title": title[:300], "url": href, "snippet": re.sub(r"\s+", " ", snippet or "").strip()[:500]})

    if engine == "yandex":
        for li in doc.xpath('//li[contains(@class,"serp-item")] | //div[contains(@class,"serp-item")]'):
            h2 = li.xpath('.//h2')
            a = (h2[0].xpath('.//a[@href]') if h2 else []) or li.xpath('.//a[contains(@class,"Link") and @href]')
            if not a:
                continue
            title = _txt(h2[0]) if h2 else _txt(a[0])
            sn = li.xpath('.//*[contains(@class,"OrganicText") or contains(@class,"text-container") or contains(@class,"Snippet")]')
            add(title, a[0].get("href"), _txt(sn[0]) if sn else "")
    elif engine == "google":
        for h3 in doc.xpath('//h3'):
            a = h3.xpath('ancestor::a[@href][1]') or h3.xpath('.//a[@href]')
            if not a:
                continue
            cont = h3.xpath('ancestor::div[@data-hveid or contains(@class,"g")][1]')
            sn = ""
            if cont:
                cand = cont[0].xpath('.//div[@data-sncf] | .//div[contains(@class,"VwiC3b")] | .//span[contains(@class,"aCOpRe")]')
                sn = _txt(cand[0]) if cand else ""
            add(_txt(h3), a[0].get("href"), sn)
    elif engine == "bing":
        for li in doc.xpath('//li[contains(@class,"b_algo")]'):
            a = li.xpath('.//h2//a[@href]')
            if not a:
                continue
            sn = li.xpath('.//div[contains(@class,"b_caption")]//p | .//p')
            add(_txt(a[0]), a[0].get("href"), _txt(sn[0]) if sn else "")
    elif engine == "ddg":
        for r in doc.xpath('//div[contains(@class,"result")]'):
            a = r.xpath('.//a[contains(@class,"result__a") and @href]')
            if not a:
                continue
            sn = r.xpath('.//*[contains(@class,"result__snippet")]')
            add(_txt(a[0]), a[0].get("href"), _txt(sn[0]) if sn else "")
    if not out:  # общий fallback: внешние ссылки внутри заголовков
        for h in doc.xpath('//h2 | //h3'):
            a = h.xpath('.//a[@href]') or h.xpath('ancestor::a[@href][1]')
            if a:
                add(_txt(h), a[0].get("href"), "")
    return out


def serp_markdown(results: list[dict[str, str]], url: str, engine: str) -> str:
    lines = [f"# Выдача {engine}: {url}", ""]
    for r in results:
        line = f"- **{r['title']}** — {r['url']}"
        if r.get("snippet"):
            line += f" — {r['snippet']}"
        lines.append(line)
    return "\n".join(lines)


def _markdownify(fragment: str, mode: str) -> str:
    # markdownify is MIT; no GPL converter dependency is used.
    if mode == "text":
        return strip_text(fragment)
    from bs4 import BeautifulSoup
    from markdownify import markdownify

    soup = BeautifulSoup(fragment, "html.parser")
    for el in soup(["script", "style", "noscript", "svg", "template", "img"]):
        el.decompose()
    txt = markdownify(str(soup), heading_style="ATX", strip=["img"])
    return re.sub(r"\n{3,}", "\n\n", txt).strip()


def _title(html: str) -> str:
    t = title_of(html)
    if t:
        return t
    try:
        import trafilatura

        md = trafilatura.extract_metadata(html)
        if md and md.title:
            return md.title[:200]
    except Exception:  # noqa: BLE001
        pass
    return ""


def extract(html: str, url: str, mode: str = "markdown") -> Extracted:
    """Основная точка: HTML → текст (markdown|text) с именем экстрактора."""
    mode = "text" if mode == "text" else "markdown"
    title = _title(html)
    engine = serp_engine(url)
    if engine:
        results = extract_serp(html, url, engine)
        if results:
            if mode == "markdown":
                return Extracted(serp_markdown(results, url, engine), "serp", title)
            return Extracted("\n".join(f"{r['title']} — {r['url']} — {r['snippet']}".rstrip(" —") for r in results), "serp", title)
    # 1. trafilatura
    try:
        import trafilatura

        out = trafilatura.extract(
            html, url=url, output_format="markdown" if mode == "markdown" else "txt",
            include_links=mode == "markdown", include_tables=True, favor_recall=True,
            include_comments=False, include_images=False, include_formatting=mode == "markdown",
        )
        if out and len(out.strip()) >= 200:
            return Extracted(out.strip(), "trafilatura", title)
    except Exception as e:  # noqa: BLE001
        log.debug("primary_extraction_failed")
    # 2. readability-lxml + markdownify
    try:
        from readability import Document

        doc = Document(html, url=url)
        summary = doc.summary(html_partial=True)
        txt = _markdownify(summary, mode)
        if txt and len(txt) >= 100:
            return Extracted(txt, "readability", title or (doc.short_title() or ""))
    except Exception as e:  # noqa: BLE001
        log.debug("fallback_extraction_failed")
    # 3. raw: весь документ через markdownify (markdown) или видимый текст
    try:
        if mode == "markdown":
            txt = _markdownify(html, mode)
            if txt:
                return Extracted(txt, "raw", title)
    except Exception:  # noqa: BLE001
        pass
    return Extracted(strip_text(html), "raw", title)


def plain_from_markdown(md: str) -> str:
    """Грубая конвертация markdown → text (для extractMode=text у Jina-слоя)."""
    t = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", md)
    t = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", t)
    t = re.sub(r"^#{1,6}\s*", "", t, flags=re.M)
    t = re.sub(r"[*_`~]{1,3}", "", t)
    return htmlmod.unescape(t).strip()
