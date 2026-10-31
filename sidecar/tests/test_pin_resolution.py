import socket
import pytest
from stealth_fetch import ssrf


def test_canonical_dns_decision_becomes_permanent_numeric_pin(monkeypatch):
    calls=[]
    def resolve(host, port, **kwargs):
        calls.append((host,port))
        return [(socket.AF_INET,1,6,'',('1.1.1.1',port))]
    monkeypatch.setattr(socket,'getaddrinfo',resolve)
    target=ssrf.resolve_target('https://EXAMPLE.COM.:8443/article?query=example#fragment')
    assert calls==[('example.com',8443)]
    assert target.url=='https://example.com:8443/article?query=example'
    assert target.resolve_rules==('example.com:8443:1.1.1.1',)
    assert target.addresses==('1.1.1.1',)


@pytest.mark.parametrize('host',['[fec0::1]','[64:ff9b::7f00:1]','[64:ff9b:1::1]','[2002:7f00:1::]','[::192.168.0.1]','[::ffff:169.254.169.254]'])
def test_transition_and_site_local_addresses_blocked(host):
    with pytest.raises(ssrf.BlockedTarget):ssrf.resolve_target('http://'+host+'/')


@pytest.mark.parametrize('url',['https://example.com:0/','http://example.com\\@localhost/','http://example%2ecom/','http://example.com/\r\nheader: injected'])
def test_parser_ambiguity_rejected(url):
    with pytest.raises(ssrf.UrlError):ssrf.resolve_target(url)


def test_nonstandard_numeric_loopback_blocked_after_resolution(monkeypatch):
    monkeypatch.setattr(socket,'getaddrinfo',lambda *a,**k:[(socket.AF_INET,1,6,'',('127.0.0.1',80))])
    with pytest.raises(ssrf.BlockedTarget):ssrf.resolve_target('http://2130706433/')
