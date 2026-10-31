"""Direct HTTP: validated DNS -> per-transfer libcurl RESOLVE pin + bounded callback.

No proxy route is supported here. The request URL is never rewritten to an IP:
Host, TLS hostname verification and SNI continue to use its canonical hostname.
"""
from __future__ import annotations

import asyncio
import ipaddress
import time
from dataclasses import dataclass
from typing import Any

from .ssrf import resolve_target

MAX_BODY_BYTES = 8_000_000


class TransportError(Exception):
    """A local fixed diagnostic; never contains a transport/provider exception."""


class BodyLimitError(TransportError):
    pass


class BoundedBody:
    def __init__(self, limit: int):
        self.limit = max(1, min(int(limit), MAX_BODY_BYTES))
        self.body = bytearray()
        self.exceeded = False

    def write(self, chunk: bytes) -> int:
        from curl_cffi.curl import CURL_WRITEFUNC_ERROR
        # libcurl has already decompressed this chunk. Reject before copying it.
        if len(chunk) > self.limit - len(self.body):
            self.exceeded = True
            return CURL_WRITEFUNC_ERROR
        self.body.extend(chunk)
        return len(chunk)


@dataclass
class PinnedResponse:
    status_code: int
    headers: Any
    content: bytes
    encoding: str
    primary_ip: str


async def pinned_get(url: str, *, headers: dict[str, str], timeout: float,
                     max_bytes: int = MAX_BODY_BYTES, impersonate: str = "chrome",
                     cookies: Any = None) -> PinnedResponse:
    from curl_cffi import CurlOpt
    from curl_cffi.requests import AsyncSession

    # Resolution and validation produce the exact addresses used by libcurl.
    started = time.monotonic()
    target = await asyncio.wait_for(asyncio.to_thread(resolve_target, url), timeout=max(0.001, timeout))
    timeout -= time.monotonic() - started
    if timeout <= 0:
        raise TransportError("http_transport_failed")
    body = BoundedBody(max_bytes)
    options = {
        CurlOpt.RESOLVE: target.resolve_rules,
        CurlOpt.PROXY: "",  # Explicitly overrides libcurl's proxy environment.
        CurlOpt.NOPROXY: "*",
        CurlOpt.FOLLOWLOCATION: 0,
        CurlOpt.FRESH_CONNECT: 1,
        CurlOpt.FORBID_REUSE: 1,
        CurlOpt.MAXFILESIZE_LARGE: body.limit,
        CurlOpt.SSL_VERIFYPEER: 1,
        CurlOpt.SSL_VERIFYHOST: 2,
    }
    try:
        # A fresh easy/multi handle per hop prevents reused connections/DNS entries
        # from defeating the current validation decision. No mutable shared options.
        async with AsyncSession(impersonate=impersonate, trust_env=False,
                                verify=True, curl_options=options, cookies=cookies,
                                max_clients=1) as session:
            response = await session.get(target.url, headers=headers,
                                         timeout=timeout, allow_redirects=False,
                                         content_callback=body.write)
            peer = ipaddress.ip_address(response.primary_ip)
            if str(peer) not in target.addresses:
                raise TransportError("destination_pin_mismatch")
            return PinnedResponse(response.status_code, response.headers,
                                  bytes(body.body), response.encoding or "utf-8", str(peer))
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        # libcurl 8.15 enforces the wire/file limit; the callback separately
        # enforces decompressed bytes (native decompression enforcement is newer).
        if body.exceeded or getattr(exc, "code", None) == 63:
            raise BodyLimitError("response_body_too_large") from None
        raise TransportError("http_transport_failed") from None
