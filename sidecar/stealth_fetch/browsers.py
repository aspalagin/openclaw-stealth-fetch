"""Браузерные слои: Patchright + реальный Chrome (headed под Xvfb) и Camoufox (headless).

Каждый вид браузера живёт в собственном рабочем потоке (sync Playwright API привязан к потоку);
одновременно выполняется не более одной страничной операции (asyncio.Semaphore(1)).
Тёплый инстанс закрывается после idle_seconds простоя и после max_pages страниц;
при смене egress — закрывается и открывается с другим persistent-профилем.
Xvfb — дочерний процесс сервиса; при падении перезапускается перед следующим запуском Chrome.
"""
from __future__ import annotations

import asyncio
import logging
import os
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from .detect import OK_MIN_TEXT, challenge_in_progress, classify, strip_text
from .layers import LayerResult

log = logging.getLogger("stealth_fetch.browsers")


class Busy(Exception):
    """Очередь к браузеру дольше queue_timeout_seconds."""


class _Instance:
    def __init__(self, kind: str):
        self.kind = kind
        self.ctx = None          # BrowserContext
        self.pw = None           # patchright Playwright (chrome)
        self.cm = None           # camoufox context manager
        self.egress = ""
        self.pages = 0
        self.last_used = 0.0
        self.busy = False
        self.sandbox: bool | None = None
        self.started_at = 0.0

    @property
    def alive(self) -> bool:
        return self.ctx is not None

    def state(self) -> str:
        if not self.alive:
            return "stopped"
        return "busy" if self.busy else "idle"


class BrowserManager:
    def __init__(self, cfg: dict[str, Any]):
        self.cfg = cfg
        self.bcfg = cfg["browser"]
        self.state_dir = Path(cfg["state_dir"])
        self.display = self.bcfg["display"]
        self.xvfb: subprocess.Popen | None = None
        self.inst = {"chrome": _Instance("chrome"), "camoufox": _Instance("camoufox")}
        self.exec = {k: ThreadPoolExecutor(max_workers=1, thread_name_prefix=f"browser-{k}") for k in self.inst}
        self.sem = asyncio.Semaphore(1)
        self.waiting = 0
        self.pages_total = {"chrome": 0, "camoufox": 0}
        self._xvfb_lock = threading.Lock()

    # ------------------------------------------------------------ Xvfb
    def ensure_xvfb(self) -> bool:
        if not self.bcfg.get("enabled", False):
            return False
        with self._xvfb_lock:
            if self.xvfb is not None and self.xvfb.poll() is None:
                return True
            if self.xvfb is not None:
                log.warning("Xvfb exited with code %s — restarting", self.xvfb.returncode)
            num = self.display.lstrip(":")
            lock = Path(f"/tmp/.X{num}-lock")
            sock = Path(f"/tmp/.X11-unix/X{num}")
            if lock.exists() and not sock.exists():
                lock.unlink(missing_ok=True)
            try:
                self.xvfb = subprocess.Popen(
                    [self.bcfg["xvfb"], self.display, "-screen", "0", self.bcfg["screen"], "-nolisten", "tcp", "-ac"],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=False,
                )
            except Exception as e:  # noqa: BLE001
                log.error("display_launch_failed")
                self.xvfb = None
                return False
            for _ in range(50):
                if sock.exists():
                    break
                if self.xvfb.poll() is not None:
                    log.error("Xvfb died at start (code %s)", self.xvfb.returncode)
                    return False
                time.sleep(0.1)
            os.environ["DISPLAY"] = self.display
            log.info("display_started")
            return sock.exists()

    def xvfb_state(self) -> str:
        return "running" if self.xvfb is not None and self.xvfb.poll() is None else "stopped"

    # ------------------------------------------------------------ публичный API
    def status(self) -> dict[str, str]:
        return {k: v.state() for k, v in self.inst.items()}

    async def fetch(self, kind: str, url: str, egress: str, budget: float) -> LayerResult:
        if not self.bcfg.get("enabled", False):
            return LayerResult(method=kind, egress=egress, error="browser_disabled")
        qt = float(self.bcfg["queue_timeout_seconds"])
        self.waiting += 1
        try:
            await asyncio.wait_for(self.sem.acquire(), timeout=qt)
        except asyncio.TimeoutError as e:
            raise Busy() from e
        finally:
            self.waiting -= 1
        try:
            loop = asyncio.get_running_loop()
            return await loop.run_in_executor(self.exec[kind], self._fetch_sync, kind, url, egress, budget)
        finally:
            self.sem.release()

    async def reap_idle(self) -> None:
        idle = float(self.bcfg["idle_seconds"])
        now = time.monotonic()
        for kind, inst in self.inst.items():
            if inst.alive and not inst.busy and now - inst.last_used > idle:
                log.info("%s idle %.0fs — closing", kind, now - inst.last_used)
                await asyncio.get_running_loop().run_in_executor(self.exec[kind], self._close, kind, "idle")

    async def shutdown(self) -> None:
        loop = asyncio.get_running_loop()
        for kind in self.inst:
            try:
                await asyncio.wait_for(loop.run_in_executor(self.exec[kind], self._close, kind, "shutdown"), 15)
            except Exception as e:  # noqa: BLE001
                log.warning("browser_close_failed")
        for ex in self.exec.values():
            ex.shutdown(wait=False, cancel_futures=True)
        if self.xvfb is not None and self.xvfb.poll() is None:
            self.xvfb.terminate()
            try:
                self.xvfb.wait(5)
            except subprocess.TimeoutExpired:
                self.xvfb.kill()

    # ------------------------------------------------------------ рабочий поток
    def _profile(self, kind: str, egress: str) -> str:
        p = self.state_dir / "profiles" / f"{kind}-{egress}"
        p.mkdir(parents=True, exist_ok=True)
        return str(p)

    def _launch_chrome(self, inst: _Instance, egress: str) -> None:
        from patchright.sync_api import sync_playwright

        if not self.ensure_xvfb():
            raise RuntimeError("Xvfb is not available")
        ru = self.cfg["egress"]["ru"]
        kw: dict[str, Any] = dict(
            user_data_dir=self._profile("chrome", egress),
            executable_path=self.bcfg["chrome_executable"],
            headless=False,
            no_viewport=True,
            args=["--disable-dev-shm-usage", "--hide-crash-restore-bubble", "--disable-session-crashed-bubble"],
            env={**os.environ, "DISPLAY": self.display},
        )
        if egress == "ru":
            kw["proxy"] = {"server": ru["browser_proxy"]}
            kw["locale"] = ru.get("locale") or "ru-RU"
            kw["timezone_id"] = ru.get("timezone") or "Europe/Moscow"
        sandbox_pref = bool(self.bcfg.get("chromium_sandbox", True))
        last_err: Exception | None = None
        for sandbox in [sandbox_pref]:
            pw = sync_playwright().start()
            try:
                inst.ctx = pw.chromium.launch_persistent_context(chromium_sandbox=sandbox, **kw)
                inst.pw = pw
                inst.sandbox = sandbox
                return
            except Exception as e:  # noqa: BLE001
                last_err = e
                try:
                    pw.stop()
                except Exception:  # noqa: BLE001
                    pass
                log.warning("browser_launch_failed")
        raise RuntimeError("browser_launch_failed") from None

    def _launch_camoufox(self, inst: _Instance, egress: str) -> None:
        from camoufox.sync_api import Camoufox

        ru = self.cfg["egress"]["ru"]
        kw: dict[str, Any] = dict(
            headless=bool(self.bcfg.get("camoufox_headless", True)),
            geoip=True,
            humanize=False,
            persistent_context=True,
            user_data_dir=self._profile("camoufox", egress),
        )
        if egress == "ru":
            kw["proxy"] = {"server": ru["browser_proxy"]}
        cm = Camoufox(**kw)
        inst.ctx = cm.__enter__()
        inst.cm = cm

    def _get(self, kind: str, egress: str) -> _Instance:
        inst = self.inst[kind]
        if inst.alive and (inst.egress != egress or inst.pages >= int(self.bcfg["max_pages"])):
            self._close(kind, "egress-change" if inst.egress != egress else "max-pages")
        if not inst.alive:
            t0 = time.monotonic()
            if kind == "chrome":
                self._launch_chrome(inst, egress)
            else:
                self._launch_camoufox(inst, egress)
            inst.egress = egress
            inst.pages = 0
            inst.started_at = time.monotonic()
            log.info("%s launched (egress=%s, sandbox=%s) in %.1fs", kind, egress, inst.sandbox, time.monotonic() - t0)
        inst.last_used = time.monotonic()
        return inst

    def _close(self, kind: str, reason: str) -> None:
        inst = self.inst[kind]
        if not inst.alive:
            return
        log.info("%s closing (%s, pages=%d)", kind, reason, inst.pages)
        try:
            if kind == "chrome":
                try:
                    inst.ctx.close()
                finally:
                    if inst.pw is not None:
                        inst.pw.stop()
            else:
                inst.cm.__exit__(None, None, None)
        except Exception as e:  # noqa: BLE001
            log.warning("browser_close_failed")
        finally:
            inst.ctx = None
            inst.pw = None
            inst.cm = None
            inst.egress = ""

    @staticmethod
    def _content(page, deadline: float) -> str:
        """page.content() с повторами: во время JS-навигации Playwright бросает
        «Unable to retrieve content because the page is navigating» (forbes.ru)."""
        last: Exception | None = None
        for _ in range(12):
            try:
                return page.content()
            except Exception as e:  # noqa: BLE001
                last = e
                if "navigating" not in str(e) and "Execution context was destroyed" not in str(e):
                    raise
                if time.monotonic() > deadline:
                    break
                try:
                    page.wait_for_load_state("domcontentloaded", timeout=3000)
                except Exception:  # noqa: BLE001
                    pass
                time.sleep(0.7)
        raise last if last else RuntimeError("content unavailable")

    def _fetch_sync(self, kind: str, url: str, egress: str, budget: float) -> LayerResult:
        t0 = time.monotonic()
        res = LayerResult(method=kind, egress=egress, final_url=url)
        inst = self.inst[kind]
        inst.busy = True
        try:
            try:
                inst = self._get(kind, egress)
            except Exception as e:  # noqa: BLE001
                res.error = "browser_launch_failed"
                self._close(kind, "launch-failed")
                return res
            launch_took = time.monotonic() - t0
            remaining = budget - launch_took
            if remaining < 5:
                res.error = "budget_exhausted"
                return res
            goto_ms = int(max(5.0, min(30.0, remaining - 3)) * 1000)
            challenge_wait = float(self.bcfg["challenge_wait_seconds"])
            settle = float(self.bcfg["settle_seconds"])
            page = None
            try:
                page = inst.ctx.new_page()
                resp = page.goto(url, wait_until="domcontentloaded", timeout=goto_ms)
                res.status = resp.status if resp else 0
                deadline = min(time.monotonic() + challenge_wait, t0 + budget - 2)
                while time.monotonic() < deadline and challenge_in_progress(self._content(page, deadline)):
                    time.sleep(1.5)
                time.sleep(min(settle, max(0.0, t0 + budget - time.monotonic() - 0.5)))
                res.html = self._content(page, t0 + budget - 0.5)
                # JS-оболочки (reddit, forbes, dzen) дорисовывают контент после domcontentloaded:
                # пока видимого текста < OK_MIN_TEXT — ждём до render_wait_seconds
                render_deadline = min(time.monotonic() + float(self.bcfg.get("render_wait_seconds", 8)), t0 + budget - 1)
                while len(strip_text(res.html)) < OK_MIN_TEXT and time.monotonic() < render_deadline:
                    time.sleep(1.0)
                    res.html = self._content(page, t0 + budget - 0.5)
                res.final_url = page.url or url
                try:
                    res.title = page.title()
                except Exception:  # noqa: BLE001
                    pass
            except Exception as e:  # noqa: BLE001
                msg = str(e)
                res.error = "browser_fetch_failed"
                if "Target page, context or browser has been closed" in msg or "TargetClosed" in type(e).__name__:
                    self._close(kind, "crashed")
            finally:
                if page is not None:
                    try:
                        page.close()
                    except Exception:  # noqa: BLE001
                        pass
                inst.pages += 1
                self.pages_total[kind] += 1
                inst.last_used = time.monotonic()
        finally:
            inst.busy = False
            res.took_ms = int((time.monotonic() - t0) * 1000)
        if res.html and not res.error:
            res.verdict = classify(res.status, res.html, res.final_url)
            if not res.title:
                res.title = res.verdict.title
        return res
