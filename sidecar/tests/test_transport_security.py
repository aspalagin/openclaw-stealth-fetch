"""Real libcurl connects to controlled loopback servers; no external sites.

Only the fixture's named origins receive a test-only ResolvedTarget admitting
loopback. Production validation is used for every other/redirect destination.
This is not a production allow-private option and does not change source policy.
"""
import asyncio
import copy
import gzip
import json
import socket
import ssl
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

import pytest
from stealth_fetch import ssrf, transport
from stealth_fetch.config import DEFAULTS
from stealth_fetch.layers import HttpLayer
from stealth_fetch.transport import pinned_get, BodyLimitError, TransportError, BoundedBody


@pytest.fixture(autouse=True)
def forbid_unexpected_curl_connect(monkeypatch):
    # A regression must fail locally rather than contact a public test IP. This
    # guard only rejects options; it never rewrites the production connection.
    import curl_cffi.requests
    from curl_cffi import CurlOpt
    original = curl_cffi.requests.AsyncSession
    def local_only(**kwargs):
        options = kwargs["curl_options"]
        rules = options.get(CurlOpt.RESOLVE, ())
        assert rules and all(rule.endswith(":127.0.0.1") and rule.split(":", 1)[0] in {"pin.invalid", "next.invalid", "wrong.invalid"} for rule in rules)
        assert options[CurlOpt.PROXY] == ""
        return original(**kwargs)
    monkeypatch.setattr(curl_cffi.requests, "AsyncSession", local_only)


@pytest.fixture
def origin(tmp_path):
    state = {"requests": [], "sent": 0, "redirect": None, "sni": []}
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        def log_message(self, *args): pass
        def do_GET(self):
            state["requests"].append((self.path, self.headers.get("Host")))
            if self.path == "/redirect":
                self.send_response(302); self.send_header("Location", state["redirect"])
                self.send_header("Content-Length", "0"); self.end_headers(); return
            if self.path in ("/large", "/chunked", "/gzip"):
                body = gzip.compress(b"x" * 100_000) if self.path == "/gzip" else b"x" * 500_000
                self.send_response(200); self.send_header("Content-Type", "text/plain")
                if self.path == "/chunked": self.send_header("Transfer-Encoding", "chunked")
                else: self.send_header("Content-Length", str(len(body)))
                if self.path == "/gzip": self.send_header("Content-Encoding", "gzip")
                self.end_headers()
                try:
                    for i in range(0, len(body), 256):
                        chunk = body[i:i+256]
                        if self.path == "/chunked": self.wfile.write((hex(len(chunk))[2:] + "\r\n").encode() + chunk + b"\r\n")
                        else: self.wfile.write(chunk)
                        self.wfile.flush(); state["sent"] += len(chunk); time.sleep(0.001)
                    if self.path == "/chunked": self.wfile.write(b"0\r\n\r\n")
                except (BrokenPipeError, ConnectionResetError): pass
                return
            body = b"Synthetic ordinary content. " * 40
            self.send_response(200); self.send_header("Content-Length", str(len(body)))
            self.send_header("Content-Type", "text/plain"); self.end_headers(); self.wfile.write(body)
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    state["port"] = server.server_port
    state["server"] = server
    yield state
    server.shutdown(); server.server_close(); thread.join(timeout=2)


@pytest.fixture
def admit_fixture_origin(monkeypatch):
    original = ssrf.resolve_target
    calls = []
    def fixture_resolve(url):
        p = urlsplit(url)
        if p.hostname in ("pin.invalid", "next.invalid", "wrong.invalid"):
            calls.append(p.hostname)
            return ssrf.ResolvedTarget(url, ("127.0.0.1",), (p.hostname + ":" + str(p.port) + ":127.0.0.1",))
        return original(url)
    monkeypatch.setattr(transport, "resolve_target", fixture_resolve)
    return calls


def test_real_connect_uses_pin_and_original_host_despite_proxy_environment(origin, admit_fixture_origin, monkeypatch):
    for name in ["http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]:
        monkeypatch.setenv(name, "socks5h://synthetic-user:synthetic-marker@proxy.invalid:1080")
    result = asyncio.run(pinned_get("http://pin.invalid:" + str(origin["port"]) + "/", headers={}, timeout=5))
    assert result.primary_ip == "127.0.0.1"
    assert result.content.startswith(b"Synthetic")
    assert origin["requests"] == [("/", "pin.invalid:" + str(origin["port"]))]
    assert admit_fixture_origin == ["pin.invalid"]


def layer(tmp_path):
    cfg = copy.deepcopy(DEFAULTS); cfg["state_dir"] = str(tmp_path)
    (tmp_path / "cookies").mkdir(exist_ok=True)
    return HttpLayer(cfg)


def test_redirect_private_blocked_before_any_second_connect(origin, admit_fixture_origin, tmp_path):
    origin["redirect"] = "http://127.0.0.1:" + str(origin["port"]) + "/forbidden"
    result = asyncio.run(layer(tmp_path).fetch("http://pin.invalid:" + str(origin["port"]) + "/redirect", "direct", 5))
    assert result.blocked_target and result.error == "blocked_target"
    assert [x[0] for x in origin["requests"]] == ["/redirect"]


def test_redirect_mixed_dns_blocked_before_connect(origin, admit_fixture_origin, tmp_path, monkeypatch):
    origin["redirect"] = "http://mixed.invalid:" + str(origin["port"]) + "/forbidden"
    monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **k: [(socket.AF_INET,1,6,"",("1.1.1.1",80)),(socket.AF_INET,1,6,"",("127.0.0.1",80))])
    result = asyncio.run(layer(tmp_path).fetch("http://pin.invalid:" + str(origin["port"]) + "/redirect", "direct", 5))
    assert result.blocked_target
    assert [x[0] for x in origin["requests"]] == ["/redirect"]


def test_each_redirect_gets_a_new_pin_and_host(origin, admit_fixture_origin, tmp_path):
    origin["redirect"] = "http://next.invalid:" + str(origin["port"]) + "/"
    result = asyncio.run(layer(tmp_path).fetch("http://pin.invalid:" + str(origin["port"]) + "/redirect", "direct", 5))
    assert not result.error and result.verdict.ok
    assert admit_fixture_origin == ["pin.invalid", "next.invalid"]
    assert origin["requests"][-1][1].startswith("next.invalid:")


@pytest.mark.parametrize("path", ["/large", "/chunked", "/gzip"])
def test_real_transport_stops_oversized_decoded_bodies(origin, admit_fixture_origin, path):
    with pytest.raises(BodyLimitError, match="response_body_too_large"):
        asyncio.run(pinned_get("http://pin.invalid:" + str(origin["port"]) + path, headers={}, timeout=5, max_bytes=1024))
    time.sleep(0.02)
    if path != "/gzip": assert origin["sent"] < 500_000


def test_one_oversized_callback_chunk_is_not_copied():
    from curl_cffi.curl import CURL_WRITEFUNC_ERROR
    body = BoundedBody(10)
    assert body.write(b"x" * 100_000) == CURL_WRITEFUNC_ERROR
    assert body.exceeded and len(body.body) == 0


def test_production_validator_never_admits_loopback(origin):
    with pytest.raises(ssrf.BlockedTarget):
        asyncio.run(pinned_get("http://127.0.0.1:" + str(origin["port"]) + "/", headers={}, timeout=2))
    assert not origin["requests"]


def test_tls_pin_retains_sni_and_certificate_hostname(origin, admit_fixture_origin, tmp_path, monkeypatch):
    import curl_cffi.requests
    cert, key = tmp_path / "cert.pem", tmp_path / "key.pem"
    subprocess.run(["openssl","req","-x509","-newkey","rsa:2048","-nodes","-keyout",str(key),"-out",str(cert),"-days","1","-subj","/CN=pin.invalid","-addext","subjectAltName=DNS:pin.invalid"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    server = origin["server"]
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.load_cert_chain(cert,key)
    ctx.set_servername_callback(lambda sock, name, context: origin["sni"].append(name))
    server.socket = ctx.wrap_socket(server.socket, server_side=True)
    original = curl_cffi.requests.AsyncSession
    def trusted_fixture_ca(**kwargs):
        kwargs["verify"] = str(cert)  # Trust only this ephemeral CA, never verify=False.
        return original(**kwargs)
    monkeypatch.setattr(curl_cffi.requests,"AsyncSession",trusted_fixture_ca)
    result = asyncio.run(pinned_get("https://pin.invalid:" + str(origin["port"]) + "/",headers={},timeout=5))
    assert result.content.startswith(b"Synthetic") and origin["sni"][-1] == "pin.invalid"
    with pytest.raises(TransportError):
        asyncio.run(pinned_get("https://wrong.invalid:" + str(origin["port"]) + "/",headers={},timeout=5))
    assert len(origin["requests"]) == 1  # Mismatch failed before HTTP.
    monkeypatch.setattr(curl_cffi.requests,"AsyncSession",original)
    with pytest.raises(TransportError):
        asyncio.run(pinned_get("https://pin.invalid:" + str(origin["port"]) + "/",headers={},timeout=5))
    assert len(origin["requests"]) == 1  # An untrusted self-signed CA also fails.
