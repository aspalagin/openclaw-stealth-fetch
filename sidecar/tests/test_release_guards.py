"""Synthetic regression gates for safer public defaults."""
import asyncio
import copy
import json
from types import SimpleNamespace
import pytest
from stealth_fetch.config import DEFAULTS, load_config
from stealth_fetch.browsers import BrowserManager, _Instance
from stealth_fetch.ssrf import check_url, UrlError

@pytest.mark.parametrize("url", ["https://user:placeholder@example.com/", "https://user@example.com/", "https://example.com:99999/", "https://example.com:bad/"])
def test_reject_credentials_or_bad_port(url):
    with pytest.raises(UrlError): check_url(url, resolve=False)

@pytest.mark.parametrize("host", ["0.0.0.0", "::", "192.168.0.1", "host.example"])
def test_reject_nonloopback_bind(tmp_path, host):
    path=tmp_path/'config.json'
    path.write_text(json.dumps({'listen':{'host':host},'state_dir':str(tmp_path/'state')}))
    with pytest.raises(ValueError, match='loopback'): load_config(str(path))
    assert not (tmp_path/'state').exists()

def test_browser_default_disabled_without_starting_display(monkeypatch):
    b=BrowserManager.__new__(BrowserManager); b.bcfg=DEFAULTS['browser']
    assert b.ensure_xvfb() is False
    result=asyncio.run(b.fetch('chrome','https://example.com/','direct',10))
    assert 'disabled' in result.error
    assert DEFAULTS['jina']['enabled'] is False

def test_chrome_sandbox_failure_never_downgrades(monkeypatch, tmp_path):
    import patchright.sync_api
    calls=[]
    def launch(**kw):
        calls.append(kw['chromium_sandbox'])
        raise RuntimeError('synthetic sandbox error')
    pw=SimpleNamespace(chromium=SimpleNamespace(launch_persistent_context=launch),stop=lambda:None)
    monkeypatch.setattr(patchright.sync_api,'sync_playwright',lambda:SimpleNamespace(start=lambda:pw))
    b=BrowserManager.__new__(BrowserManager)
    b.cfg=copy.deepcopy(DEFAULTS); b.bcfg=b.cfg['browser']; b.display=':99';b.state_dir=tmp_path
    monkeypatch.setattr(b,'ensure_xvfb',lambda:True)
    with pytest.raises(RuntimeError,match='browser_launch_failed'): b._launch_chrome(_Instance('chrome'),'direct')
    assert calls == [True]
