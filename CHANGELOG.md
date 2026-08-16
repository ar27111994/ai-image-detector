# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.0] — 2026-08-14 — Milestone 1 (first qualifying submission)

### Added

- **Detection engine**: ONNX Runtime Web in an offscreen document, adaptive WebGPU(fp16) →
  WASM(int8) execution-provider selection with a timed self-test; shared pure-JS preprocessing
  (bilinear resize + CHW normalize) identical in browser and benchmark.
- **Hybrid ensemble**: SwinV2 neural detector (haywoodsloan, Apache-2.0, int8 311MB) + forensic
  metadata layer (PNG geninfo, JPEG EXIF/XMP, C2PA JUMBF, WebP chunks) + 2D-FFT spectral features,
  fused via Platt calibration into one score.
- **UX**: auto-discovery (img/srcset/picture/background/poster) with MutationObserver +
  IntersectionObserver; shadow-DOM confidence badges; popup (status, threshold, per-site toggle);
  options page; first-run onboarding with verified one-time model download.
- **Model delivery**: weights published to GitHub Release `models-v1`, SHA-256 pinned in
  `models/manifest.json`, stored in IndexedDB, fully offline afterwards.
- **Toolchain**: esbuild (split ESM/IIFE), Vitest + v8 coverage, ESLint flat, Prettier, GitHub
  Actions CI, Puppeteer e2e harness (spawn + CDP connect — deterministic on Chrome 139).
- **Benchmark**: seeded stratified dataset fetch (OpenFake/OpenFakeTiny/COCO), web-realistic
  augmentations, per-model + full-pipeline accuracy harness with Wilson CIs and a 75%/80% gate.

### Accuracy (internal public benchmark, threshold 0.65, full runs on the shipped single-view path)

- Full pipeline, raw split (471 images): **81.5% balanced accuracy** (TPR 63.6 / TNR 99.4).
- Augmented split (1413 images: jpeg70/85 + resize50): **83.1% BA** (TPR 78.4 / TNR 87.9).
- Crop-grid TTA was implemented and **rejected by measurement** (regressed BA to 79.6%); it is
  off by default (`enableCropGrid: false`). Calibration is ECE-verified (0.244 → 0.059).

### Testing

- 227 unit + integration tests (24 files); coverage gate 90% on lines/branches/functions/statements.
- E2E suite (6 cases) passes on a clean clone (`npm ci && npm run build && npm run test:e2e`).

### Notable fixes discovered during development

- int8 dynamic quantization corrupts CLIP-family models (Δp≈0.29) but is clean for SwinV2
  (Δ≈0.0015); Conv nodes are excluded from quantization (ORT lacks ConvInteger on CPU/WASM).
- Content scripts cannot be ES modules — build emits IIFE for the content script.
- MV3 service workers start lazily; e2e navigates to a matching page before polling.
- puppeteer.launch's default `--enable-automation` interferes with `--load-extension` on
  Chrome 139 — the e2e harness spawns Chrome directly and connects via CDP.
