# Phase 1 — Task 1 SUMMARY: Repository scaffold & toolchain

## What was built

- `package.json` with pinned deps (esbuild 0.25.8, vitest 3.2.4, eslint 9.33, prettier,
  puppeteer 24.16.2, onnxruntime-node/-web 1.22.0, sharp 0.34.3, exifr 7.1.3, fft.js 4.0.4)
  and scripts: build/dev/test/cover/lint/format/bench/pack/test:e2e.
- `build.mjs`: esbuild with two configs — ESM (+splitting) for SW/pages, IIFE for the content
  script (content scripts cannot be ESM). Copies manifest/icons/pages, vendors pinned ORT wasm
  assets (`ort-wasm-simd-threaded.jsep.wasm` 20.9MB + `ort-wasm-simd-threaded.wasm` 10.7MB +
  jsep glue .mjs) into `dist/vendor/`.
- `extension/manifest.json`: MV3, CSP `script-src 'self' 'wasm-unsafe-eval'`, permissions
  storage/offscreen/unlimitedStorage/contextMenus, host_permissions `<all_urls>`, SW module.
- Skeleton entry points (background/offscreen/content/popup/options/onboarding) + HTML/CSS pages.
- `tests/e2e/run-e2e.mjs`: real extension load in headless Chrome-for-Testing 139.
- `tests/unit/constants.test.js`, `tools/generate-icons.mjs` (sharp SVG→PNG), CI workflow
  (lint → format → cover → build → dist layout assert → e2e), CHANGELOG.md.

## Verification evidence

- `npm run build` → dist/ with all bundles + vendored wasm (passes).
- `npm test` → 4/4 unit tests pass.
- `npm run lint` / `format:check` → clean.
- `npm run test:e2e` → PASS: SW target found + content-script DOM marker observed.

## Hard-won environment findings (recorded for posterity — Chrome 139 / puppeteer 24)

1. Puppeteer `--enable-automation` (default arg) does not reliably prevent `--load-extension`;
   the true blockers of my first attempts were (a) `--disable-extensions` default arg (vetoed
   `--load-extension`) and (b) **lazy MV3 service-worker start**: the SW only appears in
   `browser.targets()` after a page matching the extension's content_scripts is navigated to.
2. Content-script `console.*` output does NOT reliably reach puppeteer `page.on('console')` in
   headless Chrome — verify CS behavior via DOM markers (`page.evaluate`) instead.
3. `ignoreDefaultArgs: ['--disable-extensions']` is required for `--load-extension` to work.
4. Chrome 139 `--load-extension` still works on Chrome for Testing (branded Chrome removed it
   in M137; evaluation harness must use CfT or Load unpacked manually).
5. Low-memory conditions (<2GB free) make extension load flaky — close zombie chrome processes.

## Deviations from plan

- e2e smoke test was pulled INTO this plan (was Phase 5) because CI references it — good,
  it caught the ESM-content-script bug and the lazy-SW issue early.
- `testTimeout` bumped to 30s in vitest config for future model-adjacent tests.

## Next

- 01-2: benchmark harness (dataset fetch + runner + metrics).
- 01-3: model conversion (needs Python venv with torch/timm/onnx).
