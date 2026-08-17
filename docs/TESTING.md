# Testing

## Layers

| Layer       | Command                                                 | What it covers                                                                                                                                                                                                                                                                                                                                                                                |
| ----------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit        | `npm test`                                              | Pure modules (preprocessing, metrics, RNG, protocol, LRU cache, hashing, settings, math, model-variant, container/PNG/XMP/C2PA/EXIF parsers, fusion, spectral, discovery, badges, model-manager, inference score) + the runtime modules (offscreen orchestrator, service-worker router, content-script queue, popup/options/onboarding pages) + malformed-input, security, concurrency/stress |
| Integration | `npm test` (tests/integration)                          | Service-worker message router with a mock chrome runtime: protocol round-trip, sender validation (FORBIDDEN), bad-input and site-disabled paths (event-driven response latch, no fixed sleeps)                                                                                                                                                                                                |
| Benchmark   | `node bench/run-pipeline.mjs --model haywoodsloan-int8` | Full detection stack over the labeled public benchmark via onnxruntime-node; **exits non-zero below the 75% bar**                                                                                                                                                                                                                                                                             |
| E2E         | `npm run test:e2e`                                      | Real extension in headless Chrome-for-Testing: SW start, content-script inject, discovery + lazy-load, SPA navigation, graceful degradation pre-setup, options-page render                                                                                                                                                                                                                    |
| Lint/format | `npm run lint` / `npm run format:check`                 | ESLint flat + Prettier (both block CI on failure)                                                                                                                                                                                                                                                                                                                                             |
| Coverage    | `npm run cover`                                         | v8 coverage on `src/shared/**` + `src/background/model-manager.js`, 90% floor on lines/branches/functions/statements                                                                                                                                                                                                                                                                          |

## Test counts

<!-- AUTO:TEST_COUNT -->427<!-- /AUTO:TEST_COUNT --> tests across <!-- AUTO:TEST_FILES -->34<!-- /AUTO:TEST_FILES --> files (unit + integration), plus 6 e2e cases in real Chrome.

> Test counts, coverage %, and benchmark accuracy in the docs are auto-synced from the source of
> truth via `npm run docs:sync` (see CONTRIBUTING.md). The `test` CI job fails if they drift
> (`npm run docs:check`).

## Coverage policy

The enforced **80% floor** (lines/branches/functions/statements) spans **all of `src/`** —
currently

<!-- AUTO:COV_LINES -->98.5<!-- /AUTO:COV_LINES --> lines /
<!-- AUTO:COV_BRANCHES -->91.3<!-- /AUTO:COV_BRANCHES --> branches /
<!-- AUTO:COV_FUNCS -->98.0<!-- /AUTO:COV_FUNCS --> functions.

Breakdown: the pure, platform-independent logic (`src/shared/**`, `src/background/model-manager.js`)
sits at 90–100% per file. The runtime/UI modules (service-worker router, offscreen orchestrator,
content script, popup/options/onboarding pages) have dedicated unit suites built on a shared
DOM/chrome stub (`tests/helpers/dom-stub.js`), plus the integration (mock-chrome) and e2e suites.
The one deliberately-lower file is `src/offscreen/inference-engine.js` — its ORT session lifecycle
(WebGPU probe, WASM fallback, live inference) genuinely requires a browser and is covered by the e2e
suite instead, so the 80% floor keeps the gate honest without gaming it.

## CI gates

`.github/workflows/ci.yml`: `quality` (lint + format) → `test` (coverage gate + docs:check +
artifact) → `security` (npm audit high+ + remote-URL scan of the shipped runtime) → `build`
(dist layout + **manifest/MV3 schema + model-manifest SHA-256 pin** asserts + artifact) → `e2e`
(real Chrome). `.github/workflows/codeql.yml` runs CodeQL (security-and-quality) on every push/PR
plus a weekly sweep. Releases (`.github/workflows/release.yml`) validate the semver tag against
`package.json`/`manifest.json`, run the full suite + e2e, `npm run pack -- --bundled`, generate
`release/SHA256SUMS`, and publish the zips + raw model + checksums on `v*` tags. Dependabot keeps
npm + GitHub Actions + the Python conversion toolchain current (`onnxruntime-*` is grouped for
manual review because the vendored wasm must match).

## Benchmark reproduction

```bash
node bench/fetch-dataset.mjs --real 400 --fake 400 --seed 1337   # one-time; cached
node bench/augment.mjs                                           # web-realistic variants
node bench/run-pipeline.mjs --model haywoodsloan-int8            # full-stack BA + CI
```

The accuracy gate (`bench/run-pipeline.mjs`) exits non-zero below the 75% bounty bar and reports
the internal 80% gate separately.

## Chrome-for-Testing note (e2e)

Branded Chrome ≥137 removed `--load-extension`; the e2e harness uses Chrome for Testing (bundled
by puppeteer) and spawns Chrome directly + `puppeteer.connect()` because `puppeteer.launch()`'s
default `--enable-automation` interferes with extension loading on Chrome 139. See
tests/e2e/run-e2e.mjs header.
