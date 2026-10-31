"""SQLite-хранилище: кэш результатов, память доменов (предпочтения/блоки/429), счётчики."""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any


class Store:
    def __init__(self, path: str | Path):
        self.path = str(path)
        self._lock = threading.Lock()
        self._db = sqlite3.connect(self.path, check_same_thread=False, isolation_level=None)
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA synchronous=NORMAL")
        self._db.executescript(
            """
            CREATE TABLE IF NOT EXISTS cache (
                key TEXT PRIMARY KEY, created REAL NOT NULL, expires REAL NOT NULL, payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS domain_pref (
                host TEXT PRIMARY KEY, method TEXT, egress TEXT, until REAL NOT NULL, updated REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS domain_block (
                host TEXT NOT NULL, method TEXT NOT NULL, egress TEXT NOT NULL, protection TEXT, until REAL NOT NULL,
                PRIMARY KEY (host, method, egress));
            CREATE TABLE IF NOT EXISTS domain_rl (
                host TEXT PRIMARY KEY, last429 REAL NOT NULL, next_allowed REAL NOT NULL);
            """
        )
        self._last_gc = 0.0

    # ---- cache ----
    def cache_get(self, key: str) -> dict[str, Any] | None:
        now = time.time()
        with self._lock:
            row = self._db.execute("SELECT payload, expires FROM cache WHERE key=?", (key,)).fetchone()
        if not row or row[1] < now:
            return None
        return json.loads(row[0])

    def cache_put(self, key: str, payload: dict[str, Any], ttl: float) -> None:
        now = time.time()
        with self._lock:
            self._db.execute(
                "INSERT OR REPLACE INTO cache (key, created, expires, payload) VALUES (?,?,?,?)",
                (key, now, now + ttl, json.dumps(payload, ensure_ascii=False)),
            )
            if now - self._last_gc > 300:
                self._db.execute("DELETE FROM cache WHERE expires < ?", (now,))
                self._db.execute("DELETE FROM domain_block WHERE until < ?", (now,))
                self._db.execute("DELETE FROM domain_pref WHERE until < ?", (now,))
                self._last_gc = now

    # ---- память доменов ----
    def pref_get(self, host: str) -> tuple[str, str] | None:
        with self._lock:
            row = self._db.execute(
                "SELECT method, egress FROM domain_pref WHERE host=? AND until > ?", (host, time.time())
            ).fetchone()
        return (row[0], row[1]) if row else None

    def pref_set(self, host: str, method: str, egress: str, hours: float) -> None:
        now = time.time()
        with self._lock:
            self._db.execute(
                "INSERT OR REPLACE INTO domain_pref (host, method, egress, until, updated) VALUES (?,?,?,?,?)",
                (host, method, egress, now + hours * 3600, now),
            )

    def blocks_get(self, host: str, egress: str) -> set[str]:
        with self._lock:
            rows = self._db.execute(
                "SELECT method FROM domain_block WHERE host=? AND egress=? AND until > ?", (host, egress, time.time())
            ).fetchall()
        return {r[0] for r in rows}

    def block_set(self, host: str, method: str, egress: str, protection: str, hours: float) -> None:
        with self._lock:
            self._db.execute(
                "INSERT OR REPLACE INTO domain_block (host, method, egress, protection, until) VALUES (?,?,?,?,?)",
                (host, method, egress, protection, time.time() + hours * 3600),
            )

    def block_clear(self, host: str, method: str, egress: str) -> None:
        with self._lock:
            self._db.execute("DELETE FROM domain_block WHERE host=? AND method=? AND egress=?", (host, method, egress))

    def rl_hit(self, host: str, seconds: float) -> None:
        now = time.time()
        with self._lock:
            self._db.execute(
                "INSERT OR REPLACE INTO domain_rl (host, last429, next_allowed) VALUES (?,?,?)",
                (host, now, now + seconds),
            )

    def rl_wait(self, host: str) -> float:
        """Сколько секунд ещё нельзя обращаться к домену после 429 (0 — можно)."""
        with self._lock:
            row = self._db.execute("SELECT next_allowed FROM domain_rl WHERE host=?", (host,)).fetchone()
        if not row:
            return 0.0
        return max(0.0, row[0] - time.time())

    def rl_consume(self, host: str, seconds: float) -> None:
        """Разрешённый повторный запрос сделан — следующий не раньше чем через seconds."""
        with self._lock:
            self._db.execute("UPDATE domain_rl SET next_allowed=? WHERE host=?", (time.time() + seconds, host))

    def close(self) -> None:
        with self._lock:
            self._db.close()
