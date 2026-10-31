"""All fixtures are synthetic. Tests must never reach public sites or live config."""
import socket
import pytest

@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def blocked(*args, **kwargs):
        raise AssertionError("Network access is forbidden in unit tests")
    monkeypatch.setattr(socket.socket, "connect", blocked)
    monkeypatch.setattr(socket, "getaddrinfo", blocked)
    monkeypatch.delenv("JINA_API_KEY", raising=False)
    monkeypatch.delenv("STEALTH_FETCH_CONFIG", raising=False)
