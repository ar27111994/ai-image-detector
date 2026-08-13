# Project State — AI Image Detector

## Current Position

- Milestone: 1
- Phase: 1 (Foundation + empirical model selection)
- Last action: new-project init complete (PROJECT/REQUIREMENTS/ROADMAP written; 3 research agents done)
- Next: write research/\*.md consolidations, git init, Phase 1 plans, execute Phase 1

## Active Decisions

- Stack: vanilla JS ES2022 + esbuild; Vitest unit; Puppeteer e2e; onnxruntime-node for bench
- Inference: ONNX Runtime Web vendored; offscreen document holds sessions; SW orchestrates only
- Models: benchmark-first selection among onnx-community ViT-B (Apache-2.0), wkaandemir CLIP-LoRA
  (MIT), Ateeqq SigLIP2 (Apache-2.0); ensemble if data supports it; NPR excluded from shipping
  (no license)
- Weights hosting: HF resolve URLs for pre-built ONNX; GitHub Releases for self-converted models;
  pinned URL + SHA-256 in repo manifest
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
