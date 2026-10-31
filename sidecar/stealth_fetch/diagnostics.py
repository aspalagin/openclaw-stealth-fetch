"""Diagnostic data minimization: allowlisted local codes, never raw remote text."""
from __future__ import annotations

PROTECTIONS = {"cloudflare", "ddos-guard", "qrator", "servicepipe", "smartcaptcha",
               "google", "perimeterx", "datadome", "variti", "reddit", "ddg",
               "js-shell", "login-redirect", "unknown", ""}
METHODS = {"http", "chrome", "camoufox", "jina", "routing", "auto"}
EGRESS = {"direct", "ru", "auto"}
CODES = {"operation_failed", "http_transport_failed", "response_body_too_large",
         "proxy_route_unsupported", "browser_disabled", "browser_launch_failed",
         "browser_fetch_failed", "browser_content_failed", "browser_close_failed",
         "budget_exhausted", "unsupported_content_type", "too_many_redirects",
         "blocked_target", "invalid_target", "jina_disabled", "jina_rate_limited",
         "jina_request_failed", "jina_http_error", "jina_invalid_response",
         "internal_error", "invalid_request", "busy", "cascade_exhausted",
         "destination_pin_mismatch", "request_failed"}


def code(value: object, fallback: str = "operation_failed") -> str:
    return value if isinstance(value, str) and value in CODES else fallback


def label(value: object, allowed: set[str], fallback: str = "unknown") -> str:
    return value if isinstance(value, str) and value in allowed else fallback


def result_label(value: object) -> str:
    if value in ("ok", "error", "unknown", "blocked-target", "empty", "egress-down", "skipped:recent-block"):
        return str(value)
    if isinstance(value, str) and ":" in value:
        prefix, detail = value.split(":", 1)
        if prefix in ("blocked", "empty") and detail in PROTECTIONS:
            return prefix + ":" + detail
        if prefix == "prefer" and detail in METHODS:
            return value
    return "unknown"


def layer_summary(value: dict) -> dict:
    out = {"method": label(value.get("method"), METHODS),
           "egress": label(value.get("egress"), EGRESS),
           "result": result_label(value.get("result")),
           "tookMs": value.get("tookMs") if type(value.get("tookMs")) in (int, float) else 0}
    if type(value.get("status")) is int:
        out["status"] = value["status"]
    if value.get("error"):
        out["error"] = code(value["error"])
    return out


def failure_payload(value: dict) -> dict:
    """The failed HTTP response never echoes URL/title/body or provider exceptions."""
    out = {"ok": False, "error": code(value.get("error"), "request_failed")}
    for key in ("status", "tookMs"):
        if type(value.get(key)) in (int, float): out[key] = value[key]
    if value.get("protection"):
        out["protection"] = label(value.get("protection"), PROTECTIONS)
    if isinstance(value.get("layers"), list):
        out["layers"] = [layer_summary(x) for x in value["layers"] if isinstance(x, dict)]
    return out
