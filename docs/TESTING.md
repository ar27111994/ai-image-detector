# Testing

## Layers

| Layer       | Command                                                 | What it covers                                                                                                                                                                            |
| ----------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit        | `npm test`                                              | Pure modules (preprocessing, metrics, RNG, protocol, LRU cache, hashing, settings, container/PNG/XMP/C2PA/EXIF parsers, fusion, spectral) + malformed-input, security, concurrency/stress |
| Integration | `npm test` (tests/integration)                          | Service-worker message router with a mock chrome runtime: protocol round-trip, sender validation (FORBIDDEN), bad-input and site-disabled paths                                           |
| Benchmark   | `node bench/run-pipeline.mjs --model haywoodsloan-int8` | Full detection stack over the labeled public benchmark via onnxruntime-node; **exits non-zero below the 75% bar**                                                                         |
| E2E         | `npm run test:e2e`                                      | Real extension in headless Chrome-for-Testing: SW start, content-script inject, discovery + lazy-load, SPA navigation, graceful degradation pre-setup, options-page render                |
| Lint/format | `npm run lint` / `npm run format:check`                 | ESLint flat + Prettier (both block CI on failure)                                                                                                                                         |
| Coverage    | `npm run cover`                                         | v8 coverage on `src/shared/**`, 85% floor (currently ~96% lines)                                                                                                                          |

## Test counts

157 tests across 18 files (unit + integration), plus 6 e2e cases in real Chrome.

## Coverage policy

Shared pure logic (`src/shared/**`) targets ~100% line coverage; the vitest config enforces an
85% floor. Runtime glue (SW/offscreen/content/popup/options/onboarding) is covered by the
integration router tests and the e2e suite — the only faithful environments for those APIs.

## CI gates

`.github/workflows/ci.yml`: `quality` (lint + format) → `test` (coverage gate + artifact) →
`security` (npm audit high+ + remote-URL scan of the shipped runtime) → `build` (dist layout
assert + artifact) → `e2e` (real Chrome). Releases (`.github/workflows/release.yml`) run the full
suite + `npm run pack` + publish the zip on `v*` tags. Dependabot keeps npm + GitHub Actions
current (`onnxruntime-*` is pinned for manual review because the vendored wasm must match).

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
