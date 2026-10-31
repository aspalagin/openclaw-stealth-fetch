# Third-party notices

The MIT license at the repository root covers original project code and documentation only. It does not relicense dependencies, browser software, data sets or external services. No third-party library sources, browser binaries, captured pages or bundled SDK implementation are shipped in this artifact.

## OpenClaw integration

This plugin uses the public OpenClaw plugin SDK (OpenClaw contributors; MIT). The Firecrawl request adapter follows the publicly documented/observable OpenClaw Firecrawl plugin request contract; its request keys and endpoint are interoperability details. No private hashed core modules are imported or copied into this package. The pinned OpenClaw development/peer package and its license are obtained independently from npm.

## Direct Python dependencies

| Dependency | Pinned version | Upstream license |
| --- | --- | --- |
| curl_cffi | 0.15.0 | MIT; native components have their own notices |
| patchright | 1.63.0 | Apache-2.0 |
| camoufox (Python package) | 0.5.8 | MIT; browser distribution has separate terms |
| trafilatura | 2.0.0 | Apache-2.0 |
| readability-lxml | 0.8.4.1 | Apache-2.0 |
| lxml | 6.0.2 | BSD-3-Clause; libxml2/libxslt components have separate notices |
| lxml_html_clean | 0.4.4 | BSD-3-Clause |
| markdownify | 1.2.2 | MIT |
| fastapi | 0.135.1 | MIT |
| uvicorn | 0.42.0 | BSD-3-Clause |
| psutil | 7.2.2 | BSD-3-Clause |
| pytest (tests only) | 8.4.2 | MIT |

The previous internal converter html2text was actively used in readability/raw fallbacks and is GPL-licensed. It has been replaced with markdownify in this public source; it is neither required nor copied. This is not a claim that all remaining dependencies are MIT: see the full [dependency-license inventory](docs/dependency-licenses.md) for direct and transitive metadata, including MPL and multi-license components. The dependency lock retains tld's upstream alternative-license expression rather than claiming it is MIT.

## Browsers and native distributions

Chrome/Chromium, Firefox/Camoufox, Xvfb, Playwright/Patchright driver components, curl, TLS libraries, certificate stores, GeoIP data and native wheels are installed separately. Their respective licenses and embedded notices apply (including Mozilla Public License terms for Firefox-derived components and Chrome's distribution terms). This repository does not redistribute them. If you build a container or other combined distribution, independently review and include all required notices/source-offer obligations for exactly the components you ship.

## External services

Firecrawl and Jina Reader are external services, not bundled software. Their service terms, privacy policies, quotas and caching behavior apply. Keyless access does not waive those terms or guarantee continued availability.

This inventory is a technical disclosure, not legal advice; upstream license texts are authoritative.

## OpenClaw adapted portions: retained MIT notice

Source: https://github.com/openclaw/openclaw/blob/v2026.10.5/extensions/firecrawl/src/firecrawl-client.ts

MIT License

Copyright (c) 2026 OpenClaw Foundation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
