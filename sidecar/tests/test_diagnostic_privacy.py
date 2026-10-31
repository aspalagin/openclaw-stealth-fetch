"""Synthetic markers only; failed requests must not echo them anywhere diagnostic."""
import asyncio
import copy
import json
import logging
import time
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from stealth_fetch import diagnostics, layers, ssrf
from stealth_fetch.app import app
from stealth_fetch.config import DEFAULTS, load_config
from stealth_fetch.cascade import Cascade
from stealth_fetch.browsers import BrowserManager, _Instance
from stealth_fetch.transport import PinnedResponse

MARKER = "SYNTHETIC_DIAGNOSTIC_SENTINEL"
SENSITIVE = "https://user:" + MARKER + "@example.com/private?signature=" + MARKER + "#" + MARKER


def assert_private(value, caplog):
    assert MARKER not in str(value)
    assert MARKER not in caplog.text


def test_central_failure_minimization(caplog):
    body = diagnostics.failure_payload({"ok":False,"url":SENSITIVE,"finalUrl":SENSITIVE,"title":MARKER,
        "error":SENSITIVE,"protection":MARKER,"layers":[{"method":MARKER,"egress":MARKER,"result":MARKER,"error":SENSITIVE}]})
    assert_private(json.dumps(body),caplog)
    assert "url" not in body and "finalUrl" not in body and "title" not in body


def test_raw_transport_exception_never_leaks(tmp_path, monkeypatch, caplog):
    caplog.set_level(logging.DEBUG)
    cfg=copy.deepcopy(DEFAULTS);cfg['state_dir']=str(tmp_path);(tmp_path/'cookies').mkdir()
    async def fail(*a,**k): raise RuntimeError("proxy socks5h://user:" + MARKER + "@proxy.invalid:1080 " + SENSITIVE)
    monkeypatch.setattr(layers,'pinned_get',fail)
    result=asyncio.run(layers.HttpLayer(cfg).fetch('https://example.com/?signature='+MARKER,'direct',5))
    assert result.error == 'http_transport_failed'
    assert_private(result.summary(),caplog)


@pytest.mark.parametrize('failure',[True,False])
def test_jina_errors_are_codes_but_success_content_is_intact(monkeypatch,caplog,failure):
    cfg=copy.deepcopy(DEFAULTS);cfg['jina']['enabled']=True
    body={'message':SENSITIVE} if failure else {'data':{'content':('ordinary content '*50)+MARKER,'title':'Ordinary article','url':'https://example.com/'}}
    async def response(*a,**k): return PinnedResponse(500 if failure else 200,{},json.dumps(body).encode(),'utf-8','1.1.1.1')
    monkeypatch.setattr(layers,'pinned_get',response)
    monkeypatch.setenv('JINA_API_KEY',MARKER)
    result=asyncio.run(layers.JinaLayer(cfg).fetch('https://example.com/?signature='+MARKER,'direct',5,'markdown'))
    assert_private(result.summary(),caplog)
    if failure: assert result.error == 'jina_http_error'
    else: assert MARKER in result.text


def test_browser_raw_exception_is_not_a_diagnostic(monkeypatch,caplog):
    b=BrowserManager.__new__(BrowserManager);b.inst={'chrome':_Instance('chrome')}
    b.bcfg=DEFAULTS['browser'];b.pages_total={'chrome':0}
    def fail(*a,**k): raise RuntimeError(SENSITIVE)
    monkeypatch.setattr(b,'_get',fail);monkeypatch.setattr(b,'_close',lambda *a:None)
    result=b._fetch_sync('chrome','https://example.com/?signature='+MARKER,'direct',5)
    assert result.error == 'browser_launch_failed'
    assert_private(result.summary(),caplog)


def test_proxy_request_fails_closed_before_dns_and_without_direct_retry(caplog):
    c=Cascade.__new__(Cascade);c.cfg=DEFAULTS
    status,body=asyncio.run(c.run({'url':SENSITIVE,'egress':'ru'}))
    assert status==400 and body['error']=='proxy_route_unsupported'
    assert_private(body,caplog)


def test_proxy_config_rejected_without_echo(tmp_path,caplog):
    path=tmp_path/'config.json'
    path.write_text(json.dumps({'state_dir':str(tmp_path/'state'),'egress':{'ru':{'proxy':'socks5h://user:'+MARKER+'@proxy.invalid:1080'}}}))
    with pytest.raises(ValueError,match='proxy_route_unsupported') as e:load_config(str(path))
    assert_private(e.value,caplog);assert not (tmp_path/'state').exists()


def test_fastapi_exception_validation_and_health_payloads_are_safe(monkeypatch,caplog):
    class FakeCascade:
        async def run(self,*args):raise RuntimeError(SENSITIVE)
        async def ensure_egress(self):return {'up':False,'error':SENSITIVE}
    monkeypatch.setattr(app.state,'cascade',FakeCascade(),raising=False)
    monkeypatch.setattr(app.state,'browsers',SimpleNamespace(status=lambda:{},xvfb_state=lambda:'stopped',waiting=0),raising=False)
    monkeypatch.setattr(app.state,'started',time.time(),raising=False)
    # No context manager: intentionally do not enter real application lifespan.
    client=TestClient(app,raise_server_exceptions=False)
    failed=client.post('/fetch',json={'url':'https://example.com/?signature='+MARKER})
    invalid=client.post('/fetch',json={'url':SENSITIVE,'method':MARKER})
    health=client.get('/health')
    assert failed.status_code==500 and failed.json()['error']=='internal_error'
    assert invalid.status_code==422 and invalid.json()['error']=='invalid_request'
    assert_private(failed.text+invalid.text+health.text,caplog)
    async def fail_health(): raise RuntimeError(SENSITIVE)
    monkeypatch.setattr(app.state.cascade, "ensure_egress", fail_health)
    strict = TestClient(app, raise_server_exceptions=True)
    unhandled = strict.get("/health")
    assert unhandled.status_code == 500
    assert_private(unhandled.text, caplog)


@pytest.mark.parametrize('url',[SENSITIVE,'https://example.com:'+MARKER+'/','https://[invalid]/?key='+MARKER])
def test_url_errors_do_not_echo_inputs(url,caplog):
    with pytest.raises(ssrf.UrlError) as e:ssrf.validate_url(url)
    assert_private(e.value,caplog)
