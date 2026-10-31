"""Каскад: кэш → выбор egress → http → chrome → camoufox → jina; память доменов; сборка ответа."""
from __future__ import annotations

import asyncio
import hashlib
import logging
import threading
import time
from collections import Counter
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlsplit

from . import ssrf, diagnostics
from .browsers import BrowserManager, Busy
from .extract import extract, plain_from_markdown
from .layers import HttpLayer, JinaLayer, LayerResult, check_egress_ru
from .store import Store
from .config import ru_egress_enabled

log = logging.getLogger("stealth_fetch.cascade")

ORDER = ["http", "chrome", "camoufox", "jina"]

ADVICE = {
    "qrator": "Qrator (JS-челлендж, часто по стране): попробуй egress=ru или method=chrome.",
    "servicepipe": "Servicepipe: нужен браузер (method=chrome/camoufox) или российский выход.",
    "smartcaptcha": "Yandex SmartCaptcha: нужен headed-браузер или российский выход; при повторах — ручной браузер.",
    "cloudflare": "Cloudflare: из российского выхода часто ломается — попробуй egress=direct или ручной браузер.",
    "datadome": "DataDome: обычно только headed Chrome; иначе ручной браузер.",
    "perimeterx": "PerimeterX/HUMAN: обычно только headed Chrome; иначе ручной браузер.",
    "reddit": "Reddit: access may be restricted; use an authorized interactive browser if needed.",
    "google": "Google: выдача с DC-IP требует браузера; при капче — другой выход/ручной браузер.",
    "ddg": "DuckDuckGo-челлендж: нужен браузер.",
    "login-redirect": "Редирект на логин: контент за авторизацией, нужен ручной браузер с сессией.",
    "js-shell": "Страница — JS-оболочка без контента: нужен браузерный слой (method=chrome).",
}


class Cascade:
    def __init__(self, cfg: dict[str, Any], store: Store, http: HttpLayer, jina: JinaLayer, browsers: BrowserManager):
        self.cfg = cfg
        self.store = store
        self.http = http
        self.jina = jina
        self.browsers = browsers
        self.metrics: Counter[str] = Counter()
        self._mlock = threading.Lock()
        self.egress_ru: dict[str, Any] = {"up": False, "ip": None, "checkedAt": None, "error": "not checked"}
        self._egress_checked = 0.0
        self._egress_lock = asyncio.Lock()
        self.started = time.time()

    # ------------------------------------------------------------ egress
    async def ensure_egress(self, force: bool = False) -> dict[str, Any]:
        return {"up": False, "ip": None, "checkedAt": None, "error": "proxy_route_unsupported"}

    def _count(self, key: str) -> None:
        with self._mlock:
            self.metrics[key] += 1

    # ------------------------------------------------------------ роутинг
    def route_egress(self, host: str) -> str:
        if not ru_egress_enabled(self.cfg):
            return "direct"
        r = self.cfg["routing"]
        h = host.lower().rstrip(".")
        for d in r.get("direct_domains", []):
            if h == d or h.endswith("." + d):
                return "direct"
        for d in r.get("ru_domains", []):
            if h == d or h.endswith("." + d):
                return "ru"
        for tld in r.get("ru_tlds", []):
            if h.endswith(tld.lower()):
                return "ru"
        try:
            if h.encode("idna").decode().endswith(".xn--p1ai"):
                return "ru"
        except Exception:  # noqa: BLE001
            pass
        return "direct"

    # ------------------------------------------------------------ основной вход
    async def run(self, req: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        try:
            status, body = await self._run(req)
        except Exception:
            return 500, diagnostics.failure_payload({"error": "internal_error"})
        if not body.get("ok"):
            return status, diagnostics.failure_payload(body)
        body["layers"] = [diagnostics.layer_summary(x) for x in body.get("layers", []) if isinstance(x, dict)]
        return status, body

    async def _run(self, req: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        """Возвращает (http_status, json). 400/403 — ошибки входа, 503 — busy, 200 — результат каскада."""
        t0 = time.monotonic()
        if req.get("egress") == "ru" or any(self.cfg.get("egress", {}).get("ru", {}).get(k) for k in ("proxy", "browser_proxy")):
            return 400, {"ok": False, "error": "proxy_route_unsupported"}
        try:
            url = ssrf.check_url(req["url"], resolve=True)
        except ssrf.BlockedTarget as e:
            self._count("input:blocked-target")
            return 403, {"ok": False, "error": "blocked_target", "url": req.get("url")}
        except ssrf.UrlError as e:
            self._count("input:bad-url")
            return 400, {"ok": False, "error": "invalid_target", "url": req.get("url")}

        mode = req.get("extractMode") or "markdown"
        max_chars = int(req.get("maxChars") or 200_000)
        egress_req = req.get("egress") or "auto"
        method_req = req.get("method") or "auto"
        budgets = self.cfg["budgets"]
        total = float(req.get("timeoutSeconds") or budgets["total_default"])
        total = min(total, float(budgets["total_cap"]))
        no_cache = bool(req.get("noCache"))
        host = (urlsplit(url).hostname or "").lower()
        layers: list[dict[str, Any]] = []

        key = hashlib.sha1(f"{url}|{mode}|{egress_req}|{method_req}".encode()).hexdigest()
        if not no_cache:
            cached = await asyncio.to_thread(self.store.cache_get, key)
            if cached:
                cached = dict(cached)
                cached["cached"] = True
                cached["tookMs"] = int((time.monotonic() - t0) * 1000)
                self._count("cache:hit")
                return 200, cached

        # 429-кулдаун домена
        rl_wait = await asyncio.to_thread(self.store.rl_wait, host)
        if rl_wait > 0:
            self._count("rl:cooldown")
            return 200, {"ok": False, "url": url, "finalUrl": url, "status": 429, "protection": "unknown",
                         "error": f"домен недавно ответил 429 — повтор не раньше чем через {int(rl_wait) + 1} с",
                         "layers": [], "tookMs": int((time.monotonic() - t0) * 1000)}

        # выбор egress: явный > выученное > routing > direct
        pref = None if method_req != "auto" else await asyncio.to_thread(self.store.pref_get, host)
        if egress_req in ("ru", "direct"):
            egress = egress_req
        elif pref and pref[1] in ("ru", "direct"):
            egress = pref[1]
        else:
            egress = self.route_egress(host)
        if egress == "ru":
            return 400, {"ok": False, "error": "proxy_route_unsupported"}

        # порядок слоёв
        if method_req != "auto":
            order = [method_req]
        else:
            order = [m for m in ORDER if (m not in ("chrome", "camoufox") or self.cfg["browser"].get("enabled", False)) and (m != "jina" or self.cfg["jina"].get("enabled", False))]
            if pref and pref[0] in order:
                # выученный слой первым; при его неудаче — остальные в обычном порядке
                order = [pref[0]] + [m for m in order if m != pref[0]]
                layers.append({"method": "routing", "egress": egress, "result": f"prefer:{pref[0]}", "tookMs": 0})
            blocked = await asyncio.to_thread(self.store.blocks_get, host, egress)
            if blocked:
                rest = [m for m in order if m not in blocked]
                if rest:
                    for m in order:
                        if m in blocked:
                            layers.append({"method": m, "egress": egress, "result": "skipped:recent-block", "tookMs": 0})
                    order = rest

        deadline = t0 + total
        best_block: LayerResult | None = None
        thin_best: LayerResult | None = None
        last: LayerResult | None = None
        exhausted = False
        for idx, method in enumerate(order):
            remaining = deadline - time.monotonic()
            if remaining < 3:
                exhausted = True
                break
            budget = min(float(budgets.get(method, 30)), remaining)
            try:
                res = await self._run_layer(method, url, egress, budget, mode)
            except Busy:
                self._count("browser:busy")
                return 503, {"ok": False, "error": "busy", "url": url, "layers": layers,
                             "tookMs": int((time.monotonic() - t0) * 1000)}
            layers.append(res.summary())
            last = res
            self._count(f"layer:{method}:{egress}:{res.result_label.split(':')[0]}")
            log.info("fetch method=%s egress=%s result=%s status=%s tookMs=%d", method, egress,
                     res.result_label, res.status, res.took_ms)
            if res.blocked_target:
                self._count("input:blocked-target")
                return 403, {"ok": False, "error": "blocked_target", "url": url,
                             "finalUrl": res.final_url, "layers": layers, "tookMs": int((time.monotonic() - t0) * 1000)}
            if res.status == 429:
                await asyncio.to_thread(self.store.rl_hit, host, float(self.cfg["memory"]["rl_seconds"]))
            if res.verdict is not None and res.verdict.ok:
                try:
                    ssrf.check_host(res.final_url or url, resolve=False)
                except (ssrf.BlockedTarget, ssrf.UrlError):
                    return 403, {"ok": False, "error": "blocked_target", "url": url,
                                 "finalUrl": res.final_url, "layers": layers, "tookMs": int((time.monotonic() - t0) * 1000)}
                out = await self._success(res, url, mode, max_chars, layers, t0)
                if method_req == "auto":
                    layer_no = ORDER.index(method) + 1
                    # учим предпочтение только по auto-запросам: явный egress — разовый override, не правило роутинга
                    if layer_no >= 2 and egress_req == "auto":
                        await asyncio.to_thread(self.store.pref_set, host, method, egress, float(self.cfg["memory"]["prefer_hours"]))
                    await asyncio.to_thread(self.store.block_clear, host, method, egress)
                if not no_cache:
                    await asyncio.to_thread(self.store.cache_put, key, out, float(self.cfg["cache"]["ttl_ok_seconds"]))
                self._count(f"ok:{method}:{egress}")
                return 200, out
            if res.verdict is not None and res.verdict.kind == "block":
                best_block = res
                self._count(f"protection:{res.verdict.protection}")
                if method_req == "auto":
                    await asyncio.to_thread(self.store.block_set, host, method, egress, res.verdict.protection,
                                            float(self.cfg["memory"]["block_hours"]))
            elif (res.verdict is not None and res.verdict.kind == "empty" and res.verdict.protection == "js-shell"
                  and res.html and res.verdict.text_len >= 40
                  and (thin_best is None or res.verdict.text_len > thin_best.verdict.text_len)):
                thin_best = res
            # empty/error → следующий слой

        # все слои «пусто» (не блок, не редирект на логин): отдаём самый содержательный как ok с пометкой thin
        if best_block is None and thin_best is not None and not exhausted:
            out = await self._success(thin_best, url, mode, max_chars, layers, t0)
            out["thin"] = True
            if not no_cache:
                await asyncio.to_thread(self.store.cache_put, key, out, float(self.cfg["cache"]["ttl_block_seconds"]))
            self._count(f"thin:{thin_best.method}:{egress}")
            return 200, out

        # неуспех
        took = int((time.monotonic() - t0) * 1000)
        if best_block is not None:
            prot = best_block.verdict.protection or "unknown"
            status = best_block.status
            final = best_block.final_url or url
        elif last is not None and last.verdict is not None:
            prot = last.verdict.protection or "js-shell"
            status = last.status
            final = last.final_url or url
        else:
            prot = "unknown"
            status = last.status if last else 0
            final = (last.final_url if last else "") or url
        tried = ", ".join(f"{l['method']}/{l['egress']}→{l['result']}" for l in layers if l["method"] != "routing")
        if exhausted:
            err = f"budget exhausted ({int(total)} с); пройдено: {tried}"
        elif last is not None and last.error and best_block is None:
            err = f"слои не дали контента: {tried}. {ADVICE.get(prot, '')}".strip()
        else:
            err = f"заглушка {prot}: {tried}. {ADVICE.get(prot, 'Попробуй другой egress или ручной браузер.')}".strip()
        out = {"ok": False, "url": url, "finalUrl": final, "status": status, "protection": prot, "error": "cascade_exhausted",
               "layers": layers, "tookMs": took, "cached": False}
        if not no_cache:
            await asyncio.to_thread(self.store.cache_put, key, out, float(self.cfg["cache"]["ttl_block_seconds"]))
        self._count(f"fail:{prot}")
        return 200, out

    async def _run_layer(self, method: str, url: str, egress: str, budget: float, mode: str) -> LayerResult:
        if method == "http":
            return await self.http.fetch(url, egress, budget)
        if method in ("chrome", "camoufox"):
            return await self.browsers.fetch(method, url, egress, budget)
        if method == "jina":
            return await self.jina.fetch(url, egress, budget, mode)
        raise ValueError(method)

    async def _success(self, res: LayerResult, url: str, mode: str, max_chars: int, layers: list, t0: float) -> dict[str, Any]:
        if res.method == "jina":
            text = res.text if mode == "markdown" else plain_from_markdown(res.text)
            extractor = "jina"
            title = res.title
            raw_len = len(res.text)
        elif not (res.content_type.startswith("text/html") or res.content_type.startswith("application/xhtml")):
            text, extractor, title, raw_len = res.html, "raw", res.title, len(res.html)
        else:
            ex = await asyncio.to_thread(extract, res.html, res.final_url or url, mode)
            text, extractor, title, raw_len = ex.text, ex.extractor, ex.title or res.title, len(res.html)
        truncated = False
        if max_chars and len(text) > max_chars:
            text = text[:max_chars]
            truncated = True
        return {
            "ok": True, "url": url, "finalUrl": res.final_url or url, "status": res.status, "title": title,
            "contentType": res.content_type, "method": res.method, "egress": res.egress, "extractor": extractor,
            "text": text, "rawLength": raw_len, "truncated": truncated, "tookMs": int((time.monotonic() - t0) * 1000),
            "cached": False, "layers": layers,
        }

    def metrics_snapshot(self) -> dict[str, Any]:
        with self._mlock:
            return dict(sorted(self.metrics.items()))
