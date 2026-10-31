"""Сетевые слои без браузера: http (curl_cffi) и jina (r.jina.ai). Результат — LayerResult."""
from __future__ import annotations

import asyncio
import http.cookiejar
import json
import logging
import os
import re
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urljoin

from . import ssrf
from .config import ru_egress_enabled
from .detect import Verdict, classify, strip_text, title_of
from . import diagnostics
from .transport import pinned_get, TransportError, BodyLimitError

log = logging.getLogger("stealth_fetch.layers")

TEXT_TYPES = ("text/", "application/json", "application/xml", "application/xhtml", "application/rss", "application/atom",
              "application/javascript", "application/x-www-form-urlencoded")


@dataclass
class LayerResult:
    method: str
    egress: str
    status: int = 0
    final_url: str = ""
    html: str = ""              # сырое тело (HTML) — для http/chrome/camoufox
    text: str = ""              # готовый текст — для jina
    title: str = ""
    content_type: str = "text/html"
    took_ms: int = 0
    error: str = ""             # сетевая/внутренняя ошибка (result=error)
    verdict: Verdict | None = None
    blocked_target: bool = False  # SSRF по finalUrl/редиректу
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def result_label(self) -> str:
        if self.blocked_target:
            return "blocked-target"
        if self.error:
            return "error"
        if self.verdict is None:
            return "unknown"
        return self.verdict.label()

    def summary(self) -> dict[str, Any]:
        d = {"method": self.method, "egress": self.egress, "result": self.result_label, "tookMs": self.took_ms}
        if self.status:
            d["status"] = self.status
        if self.error:
            d["error"] = self.error[:200]
        return diagnostics.layer_summary(d)


# ---------------------------------------------------------------- http (curl_cffi)
class HttpLayer:
    def __init__(self, cfg: dict[str, Any]):
        self.cfg = cfg
        self.sem = asyncio.Semaphore(int(cfg["http"]["max_parallel"]))
        self._jars: dict[str, http.cookiejar.MozillaCookieJar] = {}
        self._jar_lock = threading.Lock()
        self._cookie_dir = Path(cfg["state_dir"]) / "cookies"

    def _jar(self, egress: str) -> http.cookiejar.MozillaCookieJar:
        if egress not in self._jars:
            path = self._cookie_dir / f"http-{egress}.txt"
            jar = http.cookiejar.MozillaCookieJar(str(path))
            if path.exists():
                try:
                    jar.load(ignore_discard=True, ignore_expires=True)
                except Exception as e:  # noqa: BLE001
                    log.warning("cookie_jar_unreadable")
            self._jars[egress] = jar
        return self._jars[egress]

    def save_cookies(self) -> None:
        with self._jar_lock:
            for jar in self._jars.values():
                try:
                    jar.save(ignore_discard=True, ignore_expires=True)
                    os.chmod(jar.filename, 0o600)
                except Exception as e:  # noqa: BLE001
                    log.debug("cookie_save_failed")

    async def close(self) -> None:
        self.save_cookies()

    async def fetch(self, url: str, egress: str, budget: float) -> LayerResult:
        from curl_cffi.requests import Cookies
        t0 = time.monotonic()
        res = LayerResult(method="http", egress=egress)
        if egress != "direct":
            res.error = "proxy_route_unsupported"
            return res
        headers = {"Accept-Language": self.cfg["egress"]["direct"]["accept_language"]}
        max_redirects = int(self.cfg["http"]["max_redirects"])
        cur = url
        async with self.sem:
            try:
                for hop in range(max_redirects + 1):
                    remaining = budget - (time.monotonic() - t0)
                    if remaining <= 0:
                        res.error = "budget_exhausted"
                        break
                    r = await pinned_get(cur, headers=headers, timeout=remaining,
                                         max_bytes=int(self.cfg["http"]["max_body_bytes"]),
                                         impersonate=self.cfg["http"]["impersonate"],
                                         cookies=Cookies(self._jar("direct")))
                    res.status, res.final_url = r.status_code, cur
                    loc = r.headers.get("location")
                    if r.status_code in (301, 302, 303, 307, 308) and loc:
                        if hop >= max_redirects:
                            res.error = "too_many_redirects"
                            break
                        # The next pinned_get validates and pins the new host before
                        # connecting. libcurl itself never follows a redirect.
                        cur = urljoin(cur, loc)
                        continue
                    ct = (r.headers.get("content-type") or "text/html").split(";")[0].strip().lower()
                    if not any(ct.startswith(t) for t in TEXT_TYPES):
                        res.error = "unsupported_content_type"
                        break
                    res.content_type = ct
                    try:
                        res.html = r.content.decode(r.encoding, "replace")
                    except LookupError:
                        res.html = r.content.decode("utf-8", "replace")
                    break
            except ssrf.BlockedTarget:
                res.blocked_target, res.error = True, "blocked_target"
            except ssrf.UrlError:
                res.error = "invalid_target"
            except BodyLimitError:
                res.error = "response_body_too_large"
            except Exception:
                res.error = "http_transport_failed"
            finally:
                self.save_cookies()
        res.took_ms = int((time.monotonic() - t0) * 1000)
        if res.html and not res.error:
            if res.content_type.startswith(("text/html", "application/xhtml")):
                res.verdict = classify(res.status, res.html, res.final_url)
                res.title = res.verdict.title
            else:
                res.verdict = Verdict("ok" if 200 <= res.status < 300 else "block",
                                      "" if 200 <= res.status < 300 else "unknown", len(res.html), "")
        return res


# ---------------------------------------------------------------- jina (r.jina.ai)
class TokenBucket:
    def __init__(self, rate_per_min: int):
        self.capacity = max(1, rate_per_min)
        self.tokens = float(self.capacity)
        self.rate = self.capacity / 60.0
        self.ts = time.monotonic()
        self.lock = threading.Lock()

    def take(self) -> bool:
        with self.lock:
            now = time.monotonic()
            self.tokens = min(self.capacity, self.tokens + (now - self.ts) * self.rate)
            self.ts = now
            if self.tokens >= 1:
                self.tokens -= 1
                return True
            return False


class JinaLayer:
    def __init__(self, cfg: dict[str, Any]):
        self.cfg = cfg
        self.bucket = TokenBucket(int(cfg["jina"]["rpm_without_key"]))

    @property
    def api_key(self) -> str:
        return (os.environ.get("JINA_API_KEY") or "").strip()

    async def fetch(self, url: str, egress: str, budget: float, mode: str) -> LayerResult:
        t0 = time.monotonic()
        res = LayerResult(method="jina", egress=egress, final_url=url)
        if not self.cfg["jina"].get("enabled", False):
            res.error = "jina_disabled"
            return res
        key = self.api_key
        if not key and not self.bucket.take():
            res.error = "jina_rate_limited"
            res.took_ms = int((time.monotonic() - t0) * 1000)
            return res
        headers = {
            "Accept": "application/json",
            "X-Return-Format": "markdown" if mode == "markdown" else "text",
            "X-Timeout": str(int(min(budget, self.cfg["jina"]["timeout_seconds"]))),
        }
        if key:
            headers["Authorization"] = f"Bearer {key}"
        if egress != "direct":
            res.error = "proxy_route_unsupported"
            return res
        try:
            r = await pinned_get(self.cfg["jina"]["base"] + url, headers=headers,
                                 timeout=min(budget, self.cfg["jina"]["timeout_seconds"] + 5),
                                 max_bytes=int(self.cfg["http"]["max_body_bytes"]),
                                 impersonate=self.cfg["http"]["impersonate"])
            res.status = r.status_code
            data: dict[str, Any] = {}
            try:
                data = json.loads(r.content)
            except Exception:  # noqa: BLE001
                pass
            d = data.get("data") if isinstance(data, dict) else None
            if r.status_code == 200 and isinstance(d, dict):
                res.text = (d.get("content") or "").strip()
                res.title = (d.get("title") or "")[:200]
                res.final_url = d.get("url") or url
                res.status = 200
                # Jina мог получить ту же заглушку — проверяем сигнатуры по заголовку/тексту;
                # порог «пусто» для готового markdown ниже, чем для сырого HTML (200 символов)
                probe_html = f"<title>{res.title}</title><body>{res.text[:4000]}</body>"
                v = classify(200, probe_html, res.final_url, text_len=len(res.text))
                if v.kind == "block":
                    res.verdict = v
                elif len(res.text) < 200:
                    res.verdict = Verdict("empty", "js-shell", len(res.text), res.title)
                else:
                    res.verdict = Verdict("ok", "", len(res.text), res.title)
            else:
                res.error = "jina_http_error"
        except BodyLimitError:
            res.error = "response_body_too_large"
        except Exception:
            res.error = "jina_request_failed"
        res.took_ms = int((time.monotonic() - t0) * 1000)
        return res


# ---------------------------------------------------------------- проверка egress
async def check_egress_ru(cfg: dict[str, Any]) -> dict[str, Any]:
    # Remote DNS cannot be secured by a local precheck. No proxy probes/network.
    return {"up": False, "ip": None, "error": "proxy_route_unsupported", "tookMs": 0}


def visible_len(html: str) -> int:
    return len(strip_text(html))


__all__ = ["HttpLayer", "JinaLayer", "LayerResult", "check_egress_ru", "visible_len", "title_of"]
