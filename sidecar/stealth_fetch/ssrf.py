"""Public HTTP(S) destinations and immutable DNS decisions for the real connect."""
from __future__ import annotations

import ipaddress
import socket
from dataclasses import dataclass
from urllib.parse import urlsplit, urlunsplit


class UrlError(ValueError):
    """Invalid target; messages are fixed codes, never input values."""


class BlockedTarget(ValueError):
    """Non-public/blocked destination; messages never echo a URL."""


_BLOCKED_HOSTS = {"localhost", "localhost.localdomain", "metadata.google.internal"}
_CGNAT = ipaddress.ip_network("100.64.0.0/10")


def _ip_blocked(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.is_site_local or ip.sixtofour is not None or ip.teredo is not None:
            return True
        if ip in ipaddress.ip_network("64:ff9b::/96") or ip in ipaddress.ip_network("64:ff9b:1::/48"):
            return True
    return not ip.is_global or ip.is_reserved or ip.is_multicast or (isinstance(ip, ipaddress.IPv4Address) and ip in _CGNAT)


def validate_url(url: str) -> str:
    if not isinstance(url, str) or not url.strip():
        raise UrlError("invalid_target")
    url = url.strip()
    if len(url) > 4096 or "\\" in url or any(ord(c) < 32 or ord(c) == 127 for c in url):
        raise UrlError("invalid_target")
    try:
        p = urlsplit(url)
        if p.scheme not in ("http", "https") or not p.hostname or p.username or p.password:
            raise ValueError()
        port = p.port
        if port is not None and not 1 <= port <= 65535:
            raise ValueError()
        host = p.hostname.rstrip(".").lower()
        if not host or "%" in host:
            raise ValueError()
        try:
            ip = ipaddress.ip_address(host)
        except ValueError:
            host = host.encode("idna").decode("ascii")
            authority = host
        else:
            host = str(ip)
            authority = "[" + host + "]" if ip.version == 6 else host
        if port is not None:
            authority += ":" + str(port)
        # Canonical authority is shared by validation and libcurl. Fragments are
        # never sent over HTTP, and do not belong in the request handed to curl.
        return urlunsplit((p.scheme, authority, p.path or "/", p.query, ""))
    except (ValueError, UnicodeError):
        raise UrlError("invalid_target") from None


def _check_literal_or_name(host: str):
    if host in _BLOCKED_HOSTS or host.endswith((".localhost", ".internal", ".local")):
        raise BlockedTarget("blocked_target")
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return None
    if _ip_blocked(ip):
        raise BlockedTarget("blocked_target")
    return ip


@dataclass(frozen=True)
class ResolvedTarget:
    url: str
    addresses: tuple[str, ...]
    resolve_rules: tuple[str, ...]


def resolve_target(url: str) -> ResolvedTarget:
    canonical = validate_url(url)
    p = urlsplit(canonical)
    host = p.hostname
    port = p.port or (443 if p.scheme == "https" else 80)
    literal = _check_literal_or_name(host)
    if literal is not None:
        return ResolvedTarget(canonical, (str(literal),), ())
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM, proto=socket.IPPROTO_TCP)
        addresses = {ipaddress.ip_address(info[4][0]) for info in infos}
    except (OSError, ValueError):
        raise UrlError("invalid_target") from None
    if not addresses or len(addresses) > 64:
        raise UrlError("invalid_target")
    if any(_ip_blocked(ip) for ip in addresses):
        raise BlockedTarget("blocked_target")
    ordered = tuple(sorted(str(ip) for ip in addresses))
    encoded = ["[" + ip + "]" if ":" in ip else ip for ip in ordered]
    # No '+' prefix: permanent entry for this transfer's fresh handle, no DNS
    # cache expiry/fallback to a second resolution. All addresses were validated.
    rule = host + ":" + str(port) + ":" + ",".join(encoded)
    return ResolvedTarget(canonical, ordered, (rule,))


def check_host(url: str, resolve: bool = True) -> None:
    if resolve:
        resolve_target(url)
    else:
        _check_literal_or_name(urlsplit(validate_url(url)).hostname)


def check_url(url: str, resolve: bool = True) -> str:
    canonical = validate_url(url)
    check_host(canonical, resolve=resolve)
    return canonical
