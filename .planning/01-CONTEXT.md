# Phase 1 — CONTEXT: Foundation + Empirical Model Selection

## Implementation vision (autopilot: derived from bounty text + research)

Phase 1 must de-risk the two things everything else depends on:

1. **The model**. We do NOT guess. We build a benchmark harness first, then measure every candidate
   on the same public, web-realistic data and let numbers decide. Candidates (verified available
   2026-08-13):
   - A: `onnx-community/deepfake_vs_real_image_detection-ONNX` (ViT-B/16-224, Apache-2.0,
     pre-built int8/fp16/fp32 ONNX) — zero conversion.
   - B: `wkaandemir/ai-image-detector` (CLIP ViT-B/16 merged LoRA, MIT, trained on Flux/MJ/DALL-E/
     GPT-Image) — convert safetensors -> ONNX ourselves via Python script (reproducible, pinned).
   - C: `Ateeqq/ai-vs-human-image-detector` (SigLIP2-512, Apache-2.0) — convert; heavy input size.
     Selection metric: balanced accuracy @ 0.65 threshold on the internal benchmark, then robustness
     on augmented (JPEG q70/q85, 50% resize) splits. If best two models are complementary, evaluate
     mean-of-scores ensemble.

2. **The scaffold**. Everything builds with `npm ci && npm run build` on a clean machine. No Python
   at build time (Python only in `tools/` for model conversion, run once by us, outputs published).
   Toolchain: esbuild, Vitest, ESLint (flat), Prettier, GitHub Actions CI, Puppeteer (dev).

## Data plan (internal benchmark, all public sources)

- `ComplexDataLab/OpenFake` (or OpenFakeTiny): modern-generator AI images + real photos (CC-BY-NC,
  benchmarking only — never shipped).
- `poloclub/diffusiondb` config `2m_first_5k` via datasets-server rows API: SD1.x images.
- COCO val2017 (direct image URLs): real photos.
- Target: ~400 real + ~400 AI (balanced), stratified by generator where labels exist; fixed seed;
  50/50 train/test split for calibration fit vs reported metric. Augmented copies double the set.

## Decisions locked here

- Model hosting: pre-built ONNX pulled from HF (candidate A). Self-converted models (B, C) are
  published as GitHub Release assets on this repo (scripted via `gh`), pinned URL + SHA-256 in
  `models/manifest.json`. The extension consumes the same manifest at setup.
- The bench harness and the extension share `src/shared/` preprocessing + fusion code verbatim
  (same module imported by both) so internal numbers transfer to the shipped product.
- Score calibration: Platt-style logistic mapping fitted so the balanced-accuracy-optimal threshold
  lands at 0.65 (documented in docs/BENCHMARK.md; fitted on public data only — no benchmark
  overfitting).

## Out of scope for Phase 1

- Any extension runtime code beyond a loadable manifest skeleton (Phase 2+).
- Forensic/fusion implementation (Phase 4) — but bench harness emits per-image feature hooks so
  Phase 4 calibration reuses the same cached scores.
