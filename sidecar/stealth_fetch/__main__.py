"""python -m stealth_fetch — запуск uvicorn с настройками из конфига."""
from __future__ import annotations

import logging
import sys

import uvicorn

from .config import load_config


def main() -> int:
    cfg = load_config()
    logging.basicConfig(
        level=cfg.get("log_level", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )
    uvicorn.run(
        "stealth_fetch.app:app",
        host=cfg["listen"]["host"],
        port=int(cfg["listen"]["port"]),
        workers=1,
        log_config=None,
        access_log=False,
        timeout_graceful_shutdown=15,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
