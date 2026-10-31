# OpenClaw Stealth Fetch

An OpenClaw **stealth** web_fetch provider and **fetch_stealth** tool backed by a local HTTP fetch sidecar. Direct HTTP uses TLS impersonation, destination pinning and bounded extraction. Experimental Chrome/Camoufox layers and external Jina/Firecrawl readers are optional and **disabled by default**.

This is not a universal CAPTCHA bypass or a search API replacement. Challenge pages are rejected rather than passed off as articles. Respect permissions, terms, rate limits and applicable law; restricted pages may require an authorized interactive browser.

## Requirements and installation

- OpenClaw 2026.10.5 or later; the public npm package 2026.10.5 is the tested peer.
- Node 24.16+ on the 24 line, or 26.1+; development/CI use 26.12.1.
- Python 3.12+ and Linux for the sidecar; the pinned lock is tested on Python 3.12.3.

After publication:

~~~sh
openclaw plugins install @aspalagin/openclaw-stealth-fetch@0.1.2
~~~

Installation does not deploy a sidecar, install browser binaries, modify service configuration or restart OpenClaw. Follow [sidecar setup](sidecar/README.md) and [deployment](docs/deployment.md). Merge [example OpenClaw settings](examples/openclaw.json) into existing configuration; do not replace it wholesale. Apply changes through your normal operator-controlled workflow.

## Direct mode and routing

With the defaults, no SOCKS service or external egress infrastructure is required. Direct requests validate every DNS address and pin that decision into the actual libcurl connection while retaining the original HTTP Host and HTTPS SNI/certificate hostname. Redirects are checked and pinned separately. Environment proxy variables are explicitly disabled for this transport.

Use egress=auto or direct. The historical ru enum remains for API compatibility but **returns proxy_route_unsupported** before any sidecar or provider request, including when selected by defaultEgress and when Firecrawl fallback is enabled. It never silently retries direct or uses an external reader. Nonempty HTTP/browser proxy configuration is rejected at startup. SOCKS remote-DNS cannot be secured by pretending a local DNS precheck controls the proxy's connection, so those routes are intentionally unsupported in this release.

## Usage

Use web_fetch with provider stealth or invoke fetch_stealth with a URL. The dedicated tool accepts extractMode (markdown/text), maxChars, noCache, egress and method (auto/http/chrome/camoufox/jina). Methods that require optional capabilities remain unavailable until explicitly enabled. method selects the sidecar entry point; an independently enabled Firecrawl fallback can still run on supported sidecar failures.

Direct HTTP/Jina responses have an 8,000,000-byte hard decoded-body cap (the Python HTTP setting can lower it). Firecrawl JSON has the same decoded-byte cap. The plugin bounds the local sidecar JSON response at 32 MiB. Oversized bodies are cancelled during transfer rather than sliced after download. See [security details](docs/security.md).

## Optional capabilities and privacy

- Browser layers require browser.enabled=true, separately installed binaries/Xvfb, an unprivileged account and external network/display isolation. They are experimental: **the direct HTTP pinning guarantee does not cover browser redirects, subresources, service workers or WebSockets**. Chromium sandboxing remains enabled with no silent downgrade.
- Jina requires jina.enabled=true; Firecrawl requires plugin firecrawlFallback=true. Both receive the full requested URL. Firecrawl keyless access is best-effort, not a guaranteed free tier, and may stop working or require authentication upstream. This plugin reads no Firecrawl API key.
- noCache bypasses the local response cache and requests Firecrawl maxAge=0/storeInCache=false. Otherwise Firecrawl requests provider caching. This is not an end-to-end retention promise for Jina or target sites. Do not send confidential or credential-bearing URLs to external readers.
- Error/warning/log/summary fields use fixed diagnostic codes or known labels, not raw provider messages, URL fragments or challenge text. Successful article content, titles and source URL metadata are intentionally preserved. Treat them as untrusted and potentially sensitive content.

The sidecar has no authentication and enforces loopback bind. It persists fetched content, cookies and profiles; protect that state. HTTPS verification is not disabled. This package is not a complete sandbox for hostile browser workloads or a substitute for controlling local users and host networking.

## Development

~~~sh
npm ci --ignore-scripts
npm run build
npm run typecheck
npm test
npm run test:pack
python3.12 -m venv .venv
.venv/bin/python -m pip install -r sidecar/requirements.lock
cd sidecar
../.venv/bin/python -m pytest -q
~~~

Run stages sequentially. Tests use synthetic content, mocked providers and controlled loopback HTTP/HTTPS servers; no live third-party sites or SERPs are fetched. TLS integration tests use the openssl command to create an ephemeral test certificate. Browser binaries are not launched or installed by CI. The original captured-page corpus is not distributed; synthetic tests are not equivalent live-site coverage.

Only public OpenClaw SDK imports are used. No private hashed core imports, machine-specific SDK symlinks, third-party bundles, browser binaries, credentials or runtime state are shipped. See [MIT](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md); dependencies are not all MIT.
