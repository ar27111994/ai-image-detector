# Project State — AI Image Detector

## Current Position

- Milestone: 1
- Phase: 3 (Detection UX) — content script + badges in progress
- Last action: Phase 1 model evaluation COMPLETE (docs/BENCHMARK.md); Phase 2 core committed
- Next: finish Phase 3 (popup/options/onboarding), Phase 4 (FFT + calibration fit),
  Phase 5 (e2e + accuracy gate), Phase 6 (docs/release)

## Environment gotchas (Chrome 139 / puppeteer 24) — see 01-1-SUMMARY.md

- MV3 SW starts lazily; navigate to a matching page before polling targets.
- Content-script console.\* does NOT reach puppeteer; verify via DOM markers.
- `--load-extension` needs `ignoreDefaultArgs: ['--disable-extensions']`.

## Active Decisions

- Stack: vanilla JS ES2022 + esbuild; Vitest unit; Puppeteer e2e; onnxruntime-node for bench
- Inference: ONNX Runtime Web vendored; offscreen document holds sessions; SW orchestrates only
- **Model (measured on 471-image internal benchmark, raw split, threshold 0.65):**
  - haywoodsloan/ai-image-detector-dev-deploy (SwinV2, 195M): **BA 81.2%** (TPR 63.0/TNR 99.4) —
    BEST, but 909MB fp32 (int8 326MB clean, drift 0.0015). **No license declared.**
  - wkaandemir (CLIP-LoRA, MIT): BA 61.8% (TPR 94.6/TNR 29.0) — good recall, poor precision.
  - ateeqq SigLIP (Apache-2.0): BA 71.7% (TPR 61.4/TNR 81.9).
  - capcheck ViT (Apache-2.0): BA 53.3%. dima806 ViT (Apache-2.0): BA 50.0% (fails modern gens).
  - Ensembles (mean/max/OR) do NOT beat haywoodsloan alone.
  - **Strategy: haywoodsloan as neural backbone + forensic metadata layer to lift TPR. MUST
    resolve its license or replace before shipping.** Contact author / find licensed equivalent.
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
