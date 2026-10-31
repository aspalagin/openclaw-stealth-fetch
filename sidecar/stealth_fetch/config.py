"""Конфигурация: /etc/stealth-fetch/config.json поверх значений по умолчанию (глубокое слияние)."""
from __future__ import annotations

import copy
import ipaddress
import json
import os
from pathlib import Path
from typing import Any

DEFAULTS: dict[str, Any] = {
    "listen": {"host": "127.0.0.1", "port": 18801},
    "state_dir": "/var/lib/stealth-fetch",
    "egress": {
        "ru": {
            "proxy": None,        # для curl_cffi (DNS на стороне прокси)
            "browser_proxy": None,  # для Chrome/Camoufox
            "check_url": "https://ipinfo.io/ip",
            "check_interval_seconds": 300,
            "locale": "ru-RU",
            "timezone": "Europe/Moscow",
            "accept_language": "ru-RU,ru;q=0.9,en;q=0.8",
        },
        "direct": {
            "locale": "en-US",
            "accept_language": "en-US,en;q=0.9,ru;q=0.5",
        },
    },
    "routing": {
        # egress ru для TLD и доменов; direct принудительно для direct_domains и всего остального
        "ru_tlds": [".ru", ".рф", ".xn--p1ai", ".su", ".by", ".kz"],
        "ru_domains": ["rt.com", "sputniknews.com", "yandex.com", "ya.ru", "dzen.ru"],
        "direct_domains": ["habr.com", "github.com"],
    },
    "cache": {"ttl_ok_seconds": 900, "ttl_block_seconds": 180},
    "budgets": {"http": 15, "chrome": 35, "camoufox": 35, "jina": 30, "total_default": 75, "total_cap": 110},
    "http": {"max_parallel": 8, "impersonate": "chrome", "max_redirects": 5, "max_body_bytes": 8_000_000},
    "browser": {
        "enabled": False,  # Experimental: requires external network isolation.
        "display": ":99",
        "screen": "1920x1080x24",
        "xvfb": "/usr/bin/Xvfb",
        "chrome_executable": "/usr/bin/google-chrome",
        "chromium_sandbox": True,       # Keep the Chromium sandbox enabled; no silent downgrade.
        "idle_seconds": 600,            # закрыть тёплый браузер после простоя
        "max_pages": 50,                # ... и после N страниц
        "challenge_wait_seconds": 20,   # ожидание прохождения JS-челленджа
        "settle_seconds": 1.5,          # догрузка после челленджа
        "queue_timeout_seconds": 60,    # очередь к браузеру дольше → 503 busy
        "camoufox_headless": True,
    },
    "jina": {"enabled": False, "base": "https://r.jina.ai/", "rpm_without_key": 20, "timeout_seconds": 30},
    "memory": {"prefer_hours": 24, "block_hours": 1, "rl_seconds": 60},
    "log_level": "INFO",
}


def _merge(base: dict, over: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in (over or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = copy.deepcopy(v)
    return out


def load_config(path: str | None = None) -> dict[str, Any]:
    path = path or os.environ.get("STEALTH_FETCH_CONFIG", "/etc/stealth-fetch/config.json")
    p = Path(path)
    data: dict[str, Any] = {}
    if p.exists():
        data = json.loads(p.read_text(encoding="utf-8"))
    cfg = _merge(DEFAULTS, data)
    host = str(cfg["listen"]["host"]).lower()
    try:
        loopback = host == "localhost" or ipaddress.ip_address(host).is_loopback
    except ValueError:
        loopback = False
    if not loopback:
        raise ValueError("sidecar listen.host must be loopback; remote mode is unsupported")
    if any(cfg.get("egress", {}).get("ru", {}).get(k) for k in ("proxy", "browser_proxy")):
        raise ValueError("proxy_route_unsupported: only direct pinned HTTP is supported")
    cfg["_config_path"] = str(p)
    sd = Path(cfg["state_dir"])
    sd.mkdir(parents=True, exist_ok=True, mode=0o700)
    for sub in ("profiles", "cookies", "memory"):
        (sd / sub).mkdir(parents=True, exist_ok=True, mode=0o700)
    return cfg


def ru_egress_enabled(cfg: dict[str, Any]) -> bool:
    """The optional proxy route requires explicit HTTP and browser proxy settings."""
    ru = cfg.get("egress", {}).get("ru", {})
    return bool(ru.get("proxy") and ru.get("browser_proxy"))
