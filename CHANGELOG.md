# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased] — Milestone 1 (v1.0.0)

### Added

- Project scaffold: esbuild bundler (split ESM/IIFE configs for pages vs content script),
  Vitest + v8 coverage, ESLint flat config, Prettier, GitHub Actions CI.
- MV3 manifest with `wasm-unsafe-eval` CSP, offscreen document wiring, `<all_urls>` host
  permissions for cross-origin image fetch.
- Service worker / offscreen document / content script / popup / options / onboarding skeletons
  with a working ping/pong health check.
- Puppeteer e2e smoke test (real extension load in headless Chrome 139): verifies service worker
  start and content-script ↔ SW connectivity. Works around Chrome's lazy MV3 worker start and
  headless content-script console silence by navigating first and asserting a DOM marker.
- Extension icons generated from inline SVG via `tools/generate-icons.mjs`.
