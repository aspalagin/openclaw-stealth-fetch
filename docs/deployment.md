# Deployment checklist

1. Install the plugin with OpenClaw's supported plugin installer; merge existing configuration rather than replacing it.
2. Install the sidecar source and locked Python environment under a dedicated unprivileged account. Use a private state directory and restrictive umask. Defaults do not need browsers, SOCKS or external reader accounts.
3. Customize the generic JSON/systemd examples. They are templates, not installers; package installation writes nothing under /etc and starts no services.
4. Keep loopback binding. Proxy settings are unsupported and fail closed; use auto/direct. Direct HTTP performs its own validated connect pinning and disables environment proxies.
5. Enable optional browsers/readers only after reviewing security.md. Browser isolation is an operator responsibility; the HTTP pinning policy does not cover browser traffic. Browser binaries/Xvfb must be installed separately under their upstream licenses.
6. Start/reload through your operational process. Check local health, then fetch an authorized test URL. A health response does not prove optional browsers are installed or isolated.

The service sample uses UMask=0077 and a 0700 StateDirectory. Existing directory ownership/modes remain your responsibility. Protect caches, cookies and browser profiles; never publish them. Default error diagnostics do not echo full URLs, but successful content and source metadata are stored as private runtime state.

Jina and Firecrawl require separate opt-in and receive URLs when used. noCache is not a retention guarantee. Do not expose the unauthenticated sidecar to untrusted users or networks.
