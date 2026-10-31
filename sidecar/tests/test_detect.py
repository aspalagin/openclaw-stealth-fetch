"""Synthetic challenge regressions; no captured HTML, cookies or response tokens."""
import pytest
from stealth_fetch.detect import classify, strip_text, title_of, challenge_in_progress

TITLES = [
    ("Just a moment", "cloudflare"), ("Attention Required!", "cloudflare"),
    ("DDOS-GUARD", "ddos-guard"), ("Are you not a robot?", "smartcaptcha"),
    ("Unusual traffic", "google"), ("Are you a robot?", "perimeterx"),
    ("Press & Hold", "perimeterx"), ("Prove your humanity", "reddit"),
    ("Bots use DuckDuckGo too", "ddg"), ("Access denied", "unknown"),
    ("Вы не робот?", "smartcaptcha"), ("Похоже, вы робот", "unknown"),
    ("Всё в порядке, но", "cloudflare"),
]
@pytest.mark.parametrize("status", [200, 403, 503])
@pytest.mark.parametrize("title,protection", TITLES)
def test_title_signature(title, protection, status):
    v = classify(status, f"<title>{title}</title><p>Synthetic challenge</p>", "https://example.com/")
    assert (v.kind, v.protection) == ("block", protection)

BODIES = [("cf-chl", "cloudflare"), ("ddg-captcha", "ddos-guard"),
          ("qrator", "qrator"), ("smartcaptcha", "smartcaptcha"),
          ("enablejs", "google"), ("bots use duckduckgo too", "ddg"),
          ("variti", "variti"), ("servicepipe", "servicepipe"),
          ("px-captcha", "perimeterx"), ("prove your humanity", "reddit"),
          ("datadome", "datadome"), ("access denied", "unknown")]
@pytest.mark.parametrize("status", [200, 403, 429])
@pytest.mark.parametrize("body,protection", BODIES)
def test_body_signature(body, protection, status):
    v = classify(status, f"<title>Example</title><p>{body}</p>", "https://example.com/")
    assert (v.kind, v.protection) == ("block", protection)

@pytest.mark.parametrize("status", [401,403,405,406,407,409,412,418,421,429,451,500,502,503,999])
@pytest.mark.parametrize("body", ["", "<p>Try later</p>"])
def test_short_error_page(status, body):
    assert classify(status, body, "https://example.com/").kind == "block"

@pytest.mark.parametrize("url,kind,protection", [
    ("https://example.com/showcaptcha?cc=example", "block", "smartcaptcha"),
    ("https://example.com/xpvnsulc/?hcheck=example", "block", "servicepipe"),
    ("https://example.com/sorry/index", "block", "google"),
    ("https://consent.google.com/", "empty", "login-redirect"),
    ("https://passport.yandex.ru/auth", "empty", "login-redirect"),
])
def test_url_signatures(url, kind, protection):
    v = classify(200, "<title>Example</title>" + "ordinary " * 500, url)
    assert (v.kind, v.protection) == (kind, protection)

@pytest.mark.parametrize("word", ["captcha", "robot check", "not a robot", "akamai"])
def test_login_forms_not_challenges(word):
    html = "<title>Article</title><p>" + "Ordinary article text. " * 40 + word + "</p>"
    assert classify(200, html, "https://example.com/").kind == "ok"

def test_long_article_mention_not_challenge():
    html = "<title>Article</title><p>" + "Ordinary article text. " * 250 + "smartcaptcha</p>"
    assert classify(200, html, "https://example.com/").kind == "ok"

def test_js_shell_and_small_static_page():
    html = "<title>Example</title><p>This is an illustrative document with enough visible text for a small page.</p>"
    assert classify(200, html, "https://example.com/").kind == "ok"
    assert classify(200, html + "<script>" + "x" * 5000 + "</script>", "https://example.com/").kind == "empty"
    assert classify(200, "<p>JavaScript is not available.</p>", "https://example.com/").protection == "js-shell"

def test_helpers():
    assert title_of("<title> A &amp; B </title>") == "A & B"
    assert strip_text("<p>x<script>secret()</script> z</p>") == "x z"
    assert challenge_in_progress("<title>Just a moment</title>")
    assert not challenge_in_progress("<title>Ordinary article</title>")
