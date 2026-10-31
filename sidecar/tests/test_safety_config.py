import asyncio
import copy
import json
import socket
import pytest
from stealth_fetch import ssrf
from stealth_fetch.config import DEFAULTS, load_config, ru_egress_enabled
from stealth_fetch.cascade import Cascade
from stealth_fetch.layers import check_egress_ru, JinaLayer

@pytest.mark.parametrize("host", ["127.0.0.1", "localhost", "10.0.0.1", "192.168.0.1", "169.254.169.254", "[::1]", "100.64.0.1", "metadata.google.internal", "172.16.0.1", "[::ffff:127.0.0.1]", "service.local", "service.internal", "sub.localhost"])
def test_ssrf_private(host):
    with pytest.raises(ssrf.BlockedTarget): ssrf.check_url(f"http://{host}/", resolve=False)

@pytest.mark.parametrize("url", ["ftp://example.com/", "file:///etc/passwd", "example.com", "", "javascript:alert(1)", "http:///x", "https://example.com/" + "x" * 4100])
def test_bad_url(url):
    with pytest.raises(ssrf.UrlError): ssrf.check_url(url, resolve=False)

def test_public_url_without_dns():
    assert ssrf.check_url("https://example.com/a?q=example", resolve=False) == "https://example.com/a?q=example"

def test_dns_mixed_addresses_fail_closed(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **k: [(socket.AF_INET,1,6,"",("1.1.1.1",443)),(socket.AF_INET,1,6,"",("127.0.0.1",443))])
    with pytest.raises(ssrf.BlockedTarget): ssrf.check_url("https://example.com/")

def test_dns_failure_is_error(monkeypatch):
    def fail(*a, **k): raise socket.gaierror("synthetic failure")
    monkeypatch.setattr(socket, "getaddrinfo", fail)
    with pytest.raises(ssrf.UrlError): ssrf.check_url("https://example.com/")

ROUTES = [("example.ru","ru"),("example.рф","ru"),("example.xn--p1ai","ru"),("example.by","ru"),("example.kz","ru"),("rt.com","ru"),("dzen.ru","ru"),("habr.com","direct"),("github.com","direct"),("example.com","direct"),("sub.rt.com","ru")]
@pytest.mark.parametrize("host,expected", ROUTES)
@pytest.mark.parametrize("configured", [False, True])
def test_optional_routing(host, expected, configured):
    c = Cascade.__new__(Cascade)
    c.cfg = copy.deepcopy(DEFAULTS)
    if configured:
        c.cfg["egress"]["ru"].update(proxy="socks5h://proxy.example:1080",browser_proxy="socks5://proxy.example:1080")
    assert c.route_egress(host) == (expected if configured else "direct")

def test_no_proxy_never_probes():
    assert not ru_egress_enabled(DEFAULTS)
    assert asyncio.run(check_egress_ru(DEFAULTS))["up"] is False
    c = Cascade.__new__(Cascade); c.cfg = DEFAULTS
    assert asyncio.run(c.ensure_egress(force=True))["error"] == "proxy_route_unsupported"

def test_partial_proxy_not_enabled():
    cfg = copy.deepcopy(DEFAULTS); cfg["egress"]["ru"]["proxy"] = "socks5h://proxy.example:1080"
    assert not ru_egress_enabled(cfg)

def test_config_deep_merge_and_state_isolation(tmp_path):
    config = tmp_path / "config.json"
    state = tmp_path / "state"
    config.write_text(json.dumps({"state_dir": str(state), "browser":{"idle_seconds":10}}))
    cfg = load_config(str(config))
    assert cfg["browser"]["idle_seconds"] == 10
    assert cfg["browser"]["chromium_sandbox"] is True
    assert DEFAULTS["browser"]["idle_seconds"] == 600
    assert all((state / x).is_dir() for x in ["profiles","cookies","memory"])

def test_external_reader_can_be_disabled():
    cfg = copy.deepcopy(DEFAULTS); cfg["jina"]["enabled"] = False
    result = asyncio.run(JinaLayer(cfg).fetch("https://example.com/","direct",1,"markdown"))
    assert result.error == "jina_disabled"
