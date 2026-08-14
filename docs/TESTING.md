# Testing

## Layers

| Layer                   | Command                                   | What it covers                                                                                                                              |
| ----------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit                    | `npm test`                                | Pure modules: preprocessing, metrics math, RNG, protocol, LRU cache, container/PNG/XMP/C2PA parsers, fusion, spectral features              |
| Integration (benchmark) | `node bench/run-pipeline.mjs --model <m>` | Full detection stack over the labeled public benchmark via onnxruntime-node — the same ONNX graph + shared preprocessing the extension runs |
| E2E                     | `npm run test:e2e`                        | Real extension loaded in headless Chrome-for-Testing: SW starts, content script injects, ping/pong, (Phase 5: badges, offline inference)    |
| Lint/format             | `npm run lint` / `npm run format:check`   | ESLint flat + Prettier                                                                                                                      |
| Coverage                | `npm run cover`                           | v8 coverage with thresholds (see vitest.config.mjs)                                                                                         |

## Coverage policy

Shared pure logic (`src/shared/**`) targets ~100% line coverage; the vitest config enforces an
85% floor on shared modules (raised as Phase 5 lands). Runtime glue (SW/offscreen/content) is
covered primarily by e2e.

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
