"""FastAPI-приложение: /health, /fetch, /metrics."""
from __future__ import annotations

import asyncio
import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import __version__, diagnostics
from .browsers import BrowserManager
from .cascade import Cascade
from .config import load_config
from .layers import HttpLayer, JinaLayer
from .store import Store

log = logging.getLogger("stealth_fetch.app")


class FetchRequest(BaseModel):
    url: str
    extractMode: Literal["markdown", "text"] = "markdown"
    maxChars: int | None = Field(default=None, ge=1)
    egress: Literal["auto", "ru", "direct"] = "auto"
    method: Literal["auto", "http", "chrome", "camoufox", "jina"] = "auto"
    timeoutSeconds: float | None = Field(default=None, ge=1)
    noCache: bool = False


@asynccontextmanager
async def lifespan(app: FastAPI):
    cfg = load_config()
    logging.getLogger().setLevel(cfg.get("log_level", "INFO"))
    state_dir = Path(cfg["state_dir"])
    store = Store(state_dir / "cache.sqlite")
    http = HttpLayer(cfg)
    jina = JinaLayer(cfg)
    browsers = BrowserManager(cfg)
    cascade = Cascade(cfg, store, http, jina, browsers)
    app.state.cfg = cfg
    app.state.cascade = cascade
    app.state.browsers = browsers
    app.state.started = time.time()
    await asyncio.to_thread(browsers.ensure_xvfb)
    try:
        await cascade.ensure_egress(force=True)
    except Exception as e:  # noqa: BLE001
        log.warning("egress_check_failed")

    async def housekeeping() -> None:
        while True:
            await asyncio.sleep(30)
            try:
                await browsers.reap_idle()
                if browsers.xvfb_state() != "running":
                    await asyncio.to_thread(browsers.ensure_xvfb)
                await cascade.ensure_egress()
            except Exception as e:  # noqa: BLE001
                log.warning("housekeeping_failed")

    task = asyncio.create_task(housekeeping())
    log.info("stealth-fetch %s started on %s:%s", __version__, cfg["listen"]["host"], cfg["listen"]["port"])
    try:
        yield
    finally:
        task.cancel()
        try:
            await browsers.shutdown()
        except Exception as e:  # noqa: BLE001
            log.warning("browser_shutdown_failed")
        await http.close()
        store.close()


app = FastAPI(title="stealth-fetch", version=__version__, lifespan=lifespan, docs_url=None, redoc_url=None)


@app.get("/health")
async def health(request: Request) -> dict[str, Any]:
    c: Cascade = request.app.state.cascade
    b: BrowserManager = request.app.state.browsers
    eg = await c.ensure_egress()
    return {
        "ok": True,
        "version": __version__,
        "browsers": b.status(),
        "xvfb": b.xvfb_state(),
        "egress": {"ru": {"up": bool(eg.get("up")), "ip": None, "checkedAt": eg.get("checkedAt"),
                          "error": diagnostics.code(eg.get("error"))}},
        "queue": {"browserWaiting": b.waiting},
        "uptimeSeconds": int(time.time() - request.app.state.started),
    }


@app.get("/metrics")
async def metrics(request: Request) -> dict[str, Any]:
    c: Cascade = request.app.state.cascade
    b: BrowserManager = request.app.state.browsers
    return {"counters": c.metrics_snapshot(), "browserPagesTotal": b.pages_total, "browsers": b.status(),
            "uptimeSeconds": int(time.time() - request.app.state.started)}


@app.post("/fetch")
async def fetch(req: FetchRequest, request: Request) -> JSONResponse:
    c: Cascade = request.app.state.cascade
    try:
        status, body = await c.run(req.model_dump())
    except Exception as e:  # noqa: BLE001
        log.error("internal_error")
        return JSONResponse({"ok": False, "error": "internal_error"}, status_code=500)
    return JSONResponse(body, status_code=status)


@app.exception_handler(Exception)
async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
    log.error("internal_error")
    return JSONResponse({"ok": False, "error": "internal_error"}, status_code=500)


@app.exception_handler(RequestValidationError)
async def _invalid_request(request: Request, exc: RequestValidationError) -> JSONResponse:
    # FastAPI's default 422 includes input/context values. Do not echo them.
    return JSONResponse({"ok": False, "error": "invalid_request"}, status_code=422)


@app.exception_handler(HTTPException)
async def _http_error(request: Request, exc: HTTPException) -> JSONResponse:
    return JSONResponse({"ok": False, "error": "request_failed"}, status_code=exc.status_code)


@app.middleware("http")
async def _minimize_unhandled_errors(request: Request, call_next):
    # ServerErrorMiddleware otherwise re-raises after its handler and Uvicorn can
    # print a raw traceback. Catch before it crosses the ASGI boundary.
    try:
        return await call_next(request)
    except Exception:
        log.error("internal_error")
        return JSONResponse({"ok": False, "error": "internal_error"}, status_code=500)
