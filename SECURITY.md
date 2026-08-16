# Security Policy

## Supported versions

Security fixes are applied to the latest release. We do not maintain backports for older
versions.

## Reporting a vulnerability

If you discover a security issue — especially anything that could cause image data to leave the
device, bypass model integrity checks, or execute untrusted code — please report it privately.

- **Email:** open a private report via [GitHub Security Advisories](https://github.com/ar27111994/ai-image-detector/security/advisories/new) (preferred), or contact the maintainer via the repository.
- **Please do not** open a public issue for a vulnerability.

Include: a description, reproduction steps, affected version, and any proof-of-concept. We aim to
acknowledge within 72 hours.

## Security model (what we protect)

This extension is designed around a strict local-only guarantee:

- **No image data leaves the device.** All inference runs in an offscreen document via ONNX
  Runtime Web (WASM/WebGPU). The only network call is the one-time model download at setup.
- **Model integrity is mandatory.** Every weight download (and every bundled copy) is verified
  against a SHA-256 hash pinned in the committed `models/manifest.json`. A spec or download
  without a valid hash is rejected before use.
- **No remote code.** The extension's CSP is `script-src 'self' 'wasm-unsafe-eval'` — no remote
  scripts, no `'unsafe-eval'`. All JS is bundled at build time.
- **No fingerprinting surface.** No `web_accessible_resources` are exposed to web pages.
- **Message sender validation.** The service worker rejects messages from non-extension contexts.
- **Input hardening.** All image/metadata parsers are bounds-checked and non-throwing on
  malformed input; adversarial cases are covered by the security + malformed-input test suites.

## Build & dependency security

- Locked dependencies (`package-lock.json`), `npm ci` for reproducible installs.
- **The CI security gate audits the shipped production runtime** (`npm audit --omit=dev
--audit-level=high`) — the packages actually bundled into the extension (exifr, fft.js,
  onnxruntime-web). A high/critical vulnerability there fails the build. A full-tree audit
  (including dev-only tooling) also runs as a non-blocking advisory.
- **Dev-only transitive vulnerabilities** (vitest, sharp, puppeteer) are patched to their fixed
  versions. Two remain without an upstream fix and are **accepted, documented risks** because they
  are not in the shipped surface and are not exploitable in our usage:
  - `extract-zip` (GHSA-jmr9-qjv8-65gv, symlink path traversal) — only reachable via
    puppeteer/`@puppeteer/browsers` unzipping a browser archive downloaded from a trusted Google
    URL; we never unzip untrusted archives.
  - `adm-zip` (GHSA-xcpc-8h2w-3j85, crafted-zip memory blow-up) — bundled inside
    `onnxruntime-node`, whose adm-zip code path we never exercise (no unzip). It exists only on
    the maintainers' benchmark machine, not in the extension.
    Both are devDependencies, excluded from `dist/`, and re-checked on every CI run; they will be
    bumped as soon as upstream ships a fix.
- CodeQL static analysis runs on every push/PR and weekly (`.github/workflows/codeql.yml`).
- GitHub Actions are pinned to full commit SHAs; Dependabot keeps dependencies current.
- Python is used only for offline model conversion (never at build or runtime).

## Threat model (attack surface)

Trust boundary: untrusted input is any **image byte stream** and any **web-page DOM** the content
script touches; the extension's own contexts (service worker, offscreen document, extension pages)
are trusted only after sender validation.

| Threat                        | Vector                                                               | Mitigation                                                                                                                               |
| ----------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Image data exfiltration       | Malicious/compromised extension code path                            | No network egress for image bytes; inference is local; CI fails on unexpected remote URLs in `src/`.                                     |
| Supply-chain / tampered model | MITM or poisoned download of ONNX weights                            | SHA-256 pin in committed `models/manifest.json`, verified before persist **and** before load; unsigned specs rejected.                   |
| Stored-XSS via image metadata | Crafted EXIF/XMP/PNG text rendered into the badge detail panel       | All forensic strings pass through HTML-escaping before `innerHTML`; covered by `tests/unit/security.test.js`.                            |
| Malicious message sender      | A web page or another extension driving analysis / mutating settings | Service worker rejects senders whose id/origin isn't this extension (`isExtensionContext`); protocol envelopes validated by `isRequest`. |
| Malformed-input crash / DoS   | Truncated or hostile JPEG/PNG/WebP containers                        | Parsers are bounds-checked and non-throwing; `tests/unit/malformed-inputs.test.js` fuzzes adversarial buffers.                           |
| Dependency vulnerability      | A CVE in a bundled npm dep                                           | `npm audit` (high+ fails CI), Dependabot weekly updates, CodeQL.                                                                         |
| Settings injection            | Hostile values in `chrome.storage`                                   | `sanitizeSettings` clamps/coerces all values to safe ranges on read.                                                                     |

Out of scope (by design): a fully compromised browser, physical access, or a malicious page
_reading its own_ images (it already has them).
