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
- CI runs `npm audit --audit-level=high` and a scan that fails on unexpected remote URLs in the
  shipped runtime.
- GitHub Actions are pinned to full commit SHAs; Dependabot keeps dependencies current.
- Python is used only for offline model conversion (never at build or runtime).
