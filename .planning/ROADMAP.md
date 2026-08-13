# Roadmap — Milestone 1: v1.0 Qualifying Extension

Ship a Chrome MV3 extension that passes the poidh.xyz #323 bar (>=75% balanced accuracy @ 65%
threshold) with a fully offline, in-browser detection ensemble.

## Research basis (completed during new-project)

- `research/models.md` — model survey. Top candidates: onnx-community/deepfake_vs_real_image_detection-ONNX
  (ViT-B, Apache-2.0, pre-quantized int8), wkaandemir/ai-image-detector (CLIP ViT-B LoRA, MIT,
  trained on Flux/MJ/DALL-E/GPT-Image), Ateeqq/ai-vs-human-image-detector (SigLIP2, Apache-2.0).
  NPR (CVPR'24) has best cross-gen numbers but no license => evaluation-only.
- `research/architecture.md` — ORT-web in MV3: CSP needs 'wasm-unsafe-eval'; offscreen document
  holds InferenceSession; SW orchestrates; IndexedDB for weights; no SAB => single-threaded WASM;
  WebGPU-in-offscreen unverified => spike + mandatory WASM fallback.
- `research/forensics.md` — metadata/forensic signal catalog: PNG tEXt (A1111 "parameters",
  ComfyUI "prompt"/"workflow", NovelAI, InvokeAI), JPEG EXIF UserComment/Software, XMP
  DigitalSourceType trainedAlgorithmicMedia, C2PA JUMBF byte-scan, DQT fingerprints, FFT features.

## Phase 1: Foundation + empirical model selection
Goal: repo scaffolded (MIT, npm, esbuild, vitest, CI) and the detection model chosen by *measured*
balanced accuracy on a self-assembled public benchmark (OpenFake/Tiny + DiffusionDB + COCO),
with conversion/quantization/hosting pipeline reproducible.
Requirements: REQ-01, REQ-02, REQ-03. Dependencies: none.

## Phase 2: Inference engine + extension core
Goal: loadable MV3 extension that downloads/verifies/caches model weights once, runs ORT inference
in an offscreen document (WebGPU with WASM fallback, adaptive self-test), fetches images
cross-origin via SW, and exposes a robust request/response protocol with LRU caching.
Requirements: REQ-04..REQ-08. Dependencies: Phase 1.

## Phase 3: Detection UX
Goal: content script auto-discovers images (img/srcset/background/lazy/MutationObserver), overlays
confidence badges (shadow DOM, scroll/resize tracking), popup with page stats, options page,
first-run onboarding with model download progress.
Requirements: REQ-09..REQ-12. Dependencies: Phase 2.

## Phase 4: Forensics + fusion ensemble
Goal: metadata parsers (PNG/JPEG/WebP/GIF/AVIF, EXIF/XMP/C2PA byte-scan), forensic rules engine,
FFT spectral features, calibrated fusion (logistic model fit on internal benchmark, serialized),
definitive-metadata fast path.
Requirements: REQ-13..REQ-15. Dependencies: Phases 2-3.

## Phase 5: Testing + accuracy gate
Goal: unit tests (coverage gate), Node integration benchmark (balanced accuracy + confusion
matrix, augmented variants), Puppeteer e2e (install -> setup -> badges), performance hardening.
Internal gate: >=80% balanced accuracy @ 0.65 threshold.
Requirements: REQ-16..REQ-19. Dependencies: Phases 2-4.

## Phase 6: Docs + release
Goal: README (build/install/reproduce), ARCHITECTURE, MODEL provenance, BENCHMARK methodology,
CHANGELOG, LICENSE/NOTICE, packaging script, rule-compliance audit doc, final verification.
Requirements: REQ-20..REQ-23. Dependencies: Phase 5.
