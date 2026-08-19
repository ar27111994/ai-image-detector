# Project State — AI Image Detector

## Current Position

- Milestone: 1 — COMPLETE (v1.0.0). Post-release review, polish, research, AND a full
  audit-and-hardening pass COMPLETE.
- Accuracy (re-measured this cycle under the exact shipped calibration): **84.2% raw** /
  **83.0% augmented (full 1,413-image set)** @ 0.65 — clears the 75% bounty bar and the 80%
  internal gate. The README previously understated this as 81.5% (the uncalibrated raw score) and
  cited a 103-image augmented subset; both corrected and sourced from the canonical result files
  (`haywoodsloan-int8__single-full-final.jsonl`, `haywoodsloan-int8__single-aug-final.jsonl`).
- Hardening pass (post-v1.0.0 audit): 32 findings triaged and resolved — third-party NOTICE added
  (REQ-21, shipped in dist/), CodeQL + release tag/version/clean-tree gates + SHA256SUMS, WCAG
  fixes (theme-aware badge panel, aria-describedby fix, 24px touch targets, contrast focus ring),
  design-token expansion, DRY refactors (shared math.js, model-variant.js, centralized TIMEOUTS),
  bounded IDB get, offscreen crash recovery, and unit suites for the five previously-untested
  UI/content modules. See CHANGELOG [Unreleased] and .planning/TECH-DEBT.md.
- Verified gates: npm ci && npm run build && npm test (<!-- AUTO:TEST_COUNT -->494<!-- /AUTO:TEST_COUNT --> tests / <!-- AUTO:TEST_FILES -->35<!-- /AUTO:TEST_FILES --> files) && npm run test:e2e
  (7/7) && npm run lint && npm run format:check && npm run docs:check all pass. Coverage 98.4%
  lines / 91.1% branches / 98.0% functions (90% gate). Docs auto-synced via tools/sync-docs.mjs.
- PR #1 review round 3 (6 threads): fixed post-write supersession gap, streamed image-fetch cap,
  raw-byte pre-copy size check, model size-budget cancel + final-size check, build fails without
  the manifest, and added the missing tools/verify-manifest.mjs behind `npm run models:manifest`.
- PR #1 review round 2 (14 unresolved threads): fixed threshold-not-applied (now threaded + cache
  key includes it), options MODEL_RESET protocol bug, C2PA UUID-validation (anti-forgery), full-
  buffer image hash, bounded getAllKeys, superseded-download generation token, dependabot auto-
  merge (GraphQL), and doc accuracy (spectral dormant / privacy image-fetch / single int8 variant).
  CodeQL bench/model-loader alert re-confirmed false positive (SHA-256-pinned URL).
- PR #1 open → main; all CI + CodeQL + dependency-review gates green. CodeQL: 4 download-related
  alerts verified false positives (SHA-256-pinned) and dismissed; 2 real findings fixed (PNG iTXt
  dead store, pack.mjs TOCTOU). Conversion-toolchain pins bumped (onnx 1.21.0, pillow 12.3.0,
  transformers 5.5.0) to clear the dependency-review gate.
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
  81.2% raw; **full calibrated pipeline 84.2% BA @ 0.65 raw / 83.0% augmented** (canonical shipped
  numbers). Ensembles did not beat it. All in docs/BENCHMARK.md + docs/MODEL.md.
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
