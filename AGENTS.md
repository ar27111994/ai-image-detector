# AGENTS.md — AI Image Detector

Project rules for AI agents (and humans) working in this repo.

## What this project is

Chrome Manifest V3 extension that detects AI-generated images **fully in-browser**
(ONNX Runtime Web, WebGPU fp16 → WASM fp32 fallback, no cloud, no backend). Built for
poidh.xyz bounty #323 — winner-take-all, maintainer-audited.

**Read `docs/PROJECT-CONTEXT.md` first** — it is the distilled decision log, benchmark
numbers, gotchas, and open items reconstructed from the five VS Code Copilot sessions
that built this repo. The full chat history is searchable in Hermes via `session_search`
(sessions `vsc-ai-detect-*`).

## Hard bars

- Bounty bar: **≥75% balanced accuracy @ 0.65 confidence threshold** (bounty-held set).
- Internal gate: **≥80% BA** on the project's own benchmark (final measured: **84.2% raw
  calibrated / 83.0% augmented** @0.65, TPR 82.6/TNR 85.8; uncalibrated neural-only raw
  81.5% — calibration is what clears the gate). Final shipped coefficients a=0.5120/b=3.0046,
  ECE 0.047. `bench/run-pipeline.mjs` exits 1 below 0.75 — that is a CI gate.
- Multi-crop TTA is **opt-in OFF** (`enableCropGrid=false`): measured regression on SwinV2
  (79.58% vs 84.5% single-view). Do not re-enable without measuring.
- Coverage gate: **≥90% on every metric**, never lowered. Lint: `--max-warnings=0`.
- Doc numbers must match reality: run `tools/sync-docs.mjs` after any test/coverage change
  (CI enforces with `--check` via `<!-- AUTO:KEY -->` markers).

## Pre-push checklist (non-negotiable)

1. `npm run lint` (0 warnings)
2. `npm run format-check` (prettier)
3. `npm run build` (also asserts ORT npm↔vendored-wasm version coupling)
4. `npm run cover` (≥90/90/90/90)
5. `npm run docs:check`
6. `npm run test:e2e` (6/6; spawn+CDP harness — do NOT use puppeteer.launch with --load-extension)
7. Commit per ticket, conventional messages; never reduce the coverage threshold.

## Architecture invariants (do not break)

- **Service worker = orchestration only**; it may never hold the ONNX session (killable).
- **Offscreen document = the only inference context**; owns ORT sessions, canvas, wasm init.
- **Content scripts = classic scripts only** (IIFE); top-level ESM fails the build.
- **No SharedArrayBuffer** (extensions are not cross-origin-isolated) → ORT single-threaded.
- **One-time model download at setup, then fully offline**: `models/manifest.json` pins
  URL+size+SHA-256; SHA-256 is mandatory (missing integrity = `MISSING_INTEGRITY` abort).
- **No innerHTML / eval anywhere**; untrusted metadata goes to `textContent`/`.title` only.
- Sender validation: reject `chrome.runtime.onMessage` from foreign `sender.id`/origins.
- Bounty legality: exactly the pinned model download as the only remote fetch; no
  hardcoded benchmark hashes/lookup tables; no uploads; no post-setup downloads — audited
  in source AND built dist.

## Calibration & benchmarks

- `fusion/calibration.json` is **generated** — never hand-edit. Refit with
  `bench/calibrate.mjs` on the **train split only**, never the test/eval split.
- Bench data is fixed-seed (1337), reproducibly fetched (see PROJECT-CONTEXT). Don't
  "improve" metrics by touching the eval set — that is benchmaxxing and disqualifying.
- Heavy benchmarks and e2e must not run concurrently (CPU saturation makes SW-start e2e flaky).
- Quantization rule (empirical): CLIP-family → fp16/fp32 (int8 corrupts); SwinV2 → int8
  (fp16 breaks ORT CPU). Exclude Conv nodes; validate max softmax drift ≤ 0.02.

## Workflow conventions

- Branch from `main` per milestone: `gsd/m1-ai-image-detector` is the active milestone.
- GitHub MCP for PR lifecycle (this repo's convention); `gh` API base64 JSON is
  line-wrapped — fetch raw.githubusercontent.com instead.
- Do not regex-edit workflow YAML in PowerShell (corrupted ci.yml once).
- JSDoc on the public surface (eslint-plugin-jsdoc in CI).
- v2 deferred items (do not start unless asked): REQ-30 Firefox port, REQ-31 video
  sampling, REQ-32 feedback loop; TD-1 spectral fusion is dormant by design.

## Status

Current milestone complete (v1.0.0, PR #1 merged). Remaining manual step (owner):
submit the poidh.xyz #323 claim.
