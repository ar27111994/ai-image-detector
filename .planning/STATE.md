# Project State — AI Image Detector

## Current Position

- Milestone: 1 — COMPLETE (v1.0.0). Post-release review, polish, and research passes COMPLETE.
- Last action: full benchmarks re-run on the shipped single-view path (raw 81.5% BA / augmented
  83.1% BA @ 0.65 — clears the 75% bar and 80% internal gate). Crop-grid TTA was implemented,
  measured (regressed to 79.6%), and reverted to default-off. Calibration is ECE-verified.
- Clean-clone reproducibility verified: npm ci && npm run build && npm test (227) &&
  npm run test:e2e (6/6) && npm run docs:check all pass. Coverage 96.9% lines / 91.0% branches /
  93.1% functions (90% gate). Docs auto-synced via tools/sync-docs.mjs; CI enforces freshness.
- Git hooks: pre-commit (lint-staged + docs:check), pre-push (full tests + e2e).
- Next (manual, owner): submit claim on poidh.xyz bounty #323 linking the repo.

## Environment gotchas (Chrome 139 / puppeteer 24) — see 01-1-SUMMARY.md

- MV3 SW starts lazily; navigate to a matching page before polling targets.
- Content-script console.\* does NOT reach puppeteer; verify via DOM markers.
- `--load-extension` needs `ignoreDefaultArgs: ['--disable-extensions']`.

## Active Decisions

- Stack: vanilla JS ES2022 + esbuild; Vitest unit; Puppeteer e2e; onnxruntime-node for bench
- Inference: ONNX Runtime Web vendored; offscreen document holds sessions; SW orchestrates only
- **Model — RESOLVED & SHIPPED:** haywoodsloan/ai-image-detector (SwinV2, 195M). License confirmed
  **Apache-2.0** via its code repo (github.com/haywoodsloan/ai-image-detector LICENSE.md). Shipped
  as int8 (Conv excluded), 311MB, published to GitHub Release `models-v1` with pinned SHA-256.
  Selection results: dima806 50.0%, capcheck 53.3%, wkaandemir 61.8%, ateeqq 71.7%, haywoodsloan
  81.2% raw; **full calibrated pipeline 84.5% BA @ 0.65 raw / 80.6% augmented**. Ensembles did not
  beat it. All in docs/BENCHMARK.md + docs/MODEL.md.
- Quantization finding: int8 dynamic CORRUPTS CLIP models (Δp≈0.29) but is CLEAN for SwinV2
  (Δ=0.0015). Ship fp16 for WebGPU; int8 or fp32 for WASM depending on final model.
- Score calibration targets the 0.65 operating point (fit on internal public data only)
- Branching: single milestone branch `gsd/m1-ai-image-detector` off `main`; one commit per plan

## Blockers

- None

## Session Notes

2026-08-13: GSD init; bounty requirements transcribed; parallel research (models / ORT-MV3 /
forensics) completed; GitHub CLI authenticated as ar27111994 (push + repo creation possible).
2026-08-13: GitHub repo created (github.com/ar27111994/ai-image-detector), main pushed, milestone
branch gsd/m1-ai-image-detector created. Phase 1 planned (4 tasks: scaffold, bench harness,
model conversion, evaluation/selection).
