# Security model and limits

## Direct HTTP connect policy

The direct sidecar transport canonicalizes the HTTP(S) authority before passing the same URL to libcurl. Userinfo, invalid ports, control characters, backslash ambiguity and IPv6 zone IDs are rejected. Every DNS address is checked; a mixed public/private answer is rejected in full. Private, loopback, link-local, metadata/CGNAT, reserved, multicast, mapped-private, site-local and specified IPv6 transition/NAT64 ranges are denied.

Validated numeric addresses are installed using CURLOPT_RESOLVE without the expiring '+' prefix. Each hop uses a fresh AsyncSession/easy handle; proxy environment settings are overridden with CURLOPT_PROXY="" and CURLOPT_NOPROXY="*". libcurl does not follow redirects. Each redirect target is validated and pinned before its connection. URL hostname/Host, TLS SNI and certificate hostname checks are preserved; HTTPS peer and hostname verification stay enabled. The observed peer is also checked against the pinned set as defense in depth, not as a substitute for pre-connect enforcement.

This is actual connect pinning, not a second DNS precheck. It does not require enterprise egress infrastructure for basic direct mode. It does not control transparent OS/network routing rewrites, a compromised TLS/DNS/kernel stack, or the internal networks of optional hosted readers.

## Unsupported proxy routing

SOCKS/HTTP proxy routing is fail-closed: populated proxy settings reject startup, and egress=ru rejects the request before DNS/cache/network work. The shared plugin path rejects both explicit ru and defaultEgress=ru before contacting the sidecar, even when the sidecar is unavailable and Firecrawl fallback is enabled. There is no silent ru-to-direct or provider fallback for that unsupported request. A local DNS precheck cannot establish what a remote-DNS proxy will actually connect to. Future proxy support would require its own tested enforcement design.

## Bounded response handling

Python HTTP and Jina are capped at 8,000,000 decoded bytes, or a lower configured limit. A synchronous libcurl content_callback checks every decompressed chunk before copying it and returns CURL_WRITEFUNC_ERROR on excess. It does not enqueue an unbounded async stream. CURLOPT_MAXFILESIZE_LARGE additionally stops oversized native transfers, including chunked responses. The tested libcurl 8.15 does not have the later 8.20 decompression-size behavior, so the separate decoded-byte callback is essential.

Firecrawl JSON is read incrementally through a bounded WHATWG stream reader, capped at 8,000,000 decoded bytes; the sidecar JSON client uses 32 MiB. Limits apply before JSON parsing or extraction, without response.text()/arrayBuffer() buffering. Oversize cancels the reader and aborts the request. Deadlines cover body consumption, not only response headers. Transport/decoder buffers and JSON/text object overhead still exist; these are body budgets, not a promise of an exact process-RSS or all-protocol wire-byte cap.

## Diagnostic minimization

Owned diagnostics use allowlisted method/egress/protection/result labels, fixed error codes and numeric statuses. Raw curl/browser/provider exception text, provider response snippets, arbitrary abort reasons, URL query/fragment/userinfo and challenge title/body fragments do not enter error/warning/logger/summary fields. Failure responses omit URL/title/body input values. FastAPI validation and HTTP exceptions have minimal handlers; an outer middleware prevents raw unhandled exceptions from reaching server traceback logging. Unknown diagnostic data is dropped rather than heuristically redacted.

Successful article text, title and source URL metadata remain intentional read results and are not redacted. The cache stores them; protect it. Do not enable external browser/library verbose debugging around confidential URLs; operator-added instrumentation is outside this diagnostic policy.

## Experimental browsers and external readers

Browsers remain default-off and require explicit experimental opt-in plus external isolation for redirects, JavaScript navigation, subresources, service workers, WebSockets and local X11. Direct HTTP pinning does not extend to those browser paths. Chromium sandboxing is enabled by default and never silently downgraded. Xvfb's local display must not be shared with untrusted users.

Jina/Firecrawl are default-off external processors. Their own fetching policy, TLS, retention, terms and availability are outside this package's control. Enabling them sends the full target URL. Firecrawl keyless behavior is best-effort. noCache asks Firecrawl not to reuse/store its response cache; it is not an end-to-end retention guarantee. Challenges/login walls may remain inaccessible, and detection is heuristic.

The API has no authentication and permits only loopback bind. Use a dedicated unprivileged account and private state directories. Neither synthetic regressions nor static package validation constitute a complete penetration test.

## Transport references

- https://curl.se/libcurl/c/CURLOPT_RESOLVE.html — permanent per-host/port DNS entries and numeric addresses.
- https://curl.se/libcurl/c/CURLOPT_CONNECT_TO.html — compared alternative; changes connection destination, not TLS/app hostname semantics. This implementation uses RESOLVE and no proxy.
- https://curl.se/libcurl/c/CURLOPT_PROXY.html — an empty proxy disables environment proxies; remote-DNS SOCKS semantics.
- https://curl.se/libcurl/c/CURLOPT_WRITEFUNCTION.html — chunk callbacks and CURL_WRITEFUNC_ERROR abort.
- https://curl.se/libcurl/c/CURLOPT_ACCEPT_ENCODING.html — callbacks see decompressed content.
- https://curl.se/libcurl/c/CURLOPT_MAXFILESIZE_LARGE.html — ongoing transfer limit; decompression behavior is version-dependent.

The pinned curl_cffi 0.15.0 source was checked: requests/utils.py installs content_callback instead of the full body buffer and applies curl_options last; curl.py preserves CURL_WRITEFUNC_ERROR (returning a short integer alone is not a reliable abort in that wrapper).
