# Local sidecar

Python 3.12+ on Linux. requirements.lock is a fully pinned runtime/test snapshot validated on Python 3.12.3; pyproject.toml declares direct dependencies. No browser binaries are included.

~~~sh
python3.12 -m venv .venv
.venv/bin/python -m pip install -r requirements.lock
.venv/bin/python -m stealth_fetch
~~~

Before running, adapt ../examples/sidecar.json and give a dedicated unprivileged user a private writable state_dir. STEALTH_FETCH_CONFIG selects the JSON file; defaults are /etc/stealth-fetch/config.json and /var/lib/stealth-fetch. JSON is deep-merged; environment values are not interpolated. The .env.example documents optional service variables, not a dotenv loader.

Only loopback listen.host values are accepted. Nonempty egress.ru.proxy/browser_proxy settings are rejected. Requests explicitly selecting ru fail closed with proxy_route_unsupported; they do not silently fall back to direct. Direct HTTP ignores proxy environment variables and pins validated DNS destinations into fresh libcurl handles for every hop. It does not need an external policy-enforcing proxy.

POST /fetch accepts url, extractMode, maxChars, egress, method, timeoutSeconds and noCache. GET /health and /metrics expose minimal local status. Errors use fixed codes; failed response bodies do not echo URLs, provider errors or input validation values. Successful read content and source metadata remain intact.

http.max_body_bytes can lower the 8,000,000-byte hard response cap. A libcurl write callback counts decompressed bytes and aborts before copying an oversized chunk; CURLOPT_MAXFILESIZE_LARGE provides an additional native transfer-size limit. Jina uses the same transport and bound. Cancellation/deadline closes the per-hop session.

Browser layers are disabled by default. Experimental opt-in requires browser.enabled=true, separately installed Chrome/Chromium and Xvfb paths, and optional Camoufox installation following upstream instructions. Provide external browser network and display isolation; application-level initial URL checks do not confine all browser traffic. Do not run as root or disable the sandbox to force startup. Sandbox launch errors fail the browser layer instead of retrying unsandboxed.

Jina is separately opt-in through jina.enabled=true and receives the full target URL; JINA_API_KEY is optional, private runtime input. Readers are not a search API or guaranteed CAPTCHA solver. Review the root README and security/privacy limits before enabling them.

Run python -m pytest -q here using the locked environment. Unit tests deny network access; controlled libcurl integration tests connect only to local synthetic servers. They use a test-only loopback admission fixture, never a production allow-private flag. TLS tests require openssl and never set verify=False. Test certificates remain in temporary directories, not source artifacts.
