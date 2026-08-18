# AI Image Detector (Chrome Extension)

## Vision

A privacy-preserving Google Chrome extension (Manifest V3) that automatically detects AI-generated
images on any webpage, entirely in-browser. No cloud inference, no external APIs, no local server.
Every analyzed image gets a confidence score badge overlaid on the page.

Built to compete for poidh.xyz bounty #323 (arbitrum): first submission reaching **>= 75.0%
balanced accuracy at a 65% confidence threshold** on the maintainers' held-out benchmark wins.
Bounty text: https://poidh.xyz/arbitrum/bounty/323

## Problem Statement

Most "AI-powered" browser tools upload images to remote servers for inference. Users who want to
check whether an image is AI-generated must share that image with a third party. This project proves
that accurate AI-image detection can run fully client-side using WebGPU/WASM, keeping every image
on the user's device.

## Success Criteria

- **Primary metric**: >= 75.0% balanced accuracy on the maintainers' private benchmark (65%
  confidence threshold). Internal proxy: self-assembled public benchmark (real: COCO/Unsplash-style
  photos; AI: SDXL/Flux/MJ/DALL-E-like outputs) measured via the `bench/` harness, with a safety
  margin (target >= 80% internally to buffer benchmark-distribution shift).
- **Rule compliance**: MIT license, MV3, all inference local (WebGPU/WASM/WebGL), one-time model
  weight download at setup only, zero image data leaves the device, builds reproducibly from source,
  complete build/install docs.
- **Usability**: install -> visit any page -> images automatically badged with confidence score.

## Stakeholders

- Primary owner: ar27111994 (repo owner)
- Users / audience: everyday Chrome users, journalists, researchers; bounty maintainers (evaluators)
- Reviewers / approvers: poidh.xyz bounty maintainers

## Constraints

- No cloud inference, no external API calls after setup, no local backend processes (Python/Node/Flask).
- One-time download of publicly available model weights during initial setup is allowed; afterwards
  fully offline (evaluation disables internet after model download; localhost APIs blocked).
- No hardcoding benchmark hashes or lookup tables; no circumventing evaluation.
- Must build reproducibly from source on a maintainer machine; evaluated on clean Chrome + fresh profile.
- Must be fully open source under MIT.

## Assumptions (autopilot mode - documented, not asked)

- The repo will be public on GitHub under the owner's account; name: `ai-image-detector`.
- Vanilla JS (ES2022, ES modules) + esbuild bundling; no UI framework (small popup/options UIs).
- ONNX Runtime Web vendored at build time (npm, pinned version) is the inference runtime.
- The primary detector is a pre-trained image classifier converted to ONNX; conversion script lives
  in-repo (Python optional, only for reproducibility audits). The extension downloads the published
  ONNX weights once at first-run setup from Hugging Face (pinned URL + SHA-256 verified).
- Detection is an ensemble: primary neural classifier + metadata/forensic signals fused into a
  calibrated probability; per-image score shown as percentage. (A spectral/FFT feature module was
  built and tested but is dormant in the shipped fusion — measured not to improve accuracy; see
  TECH-DEBT.md TD-1.)
- "Balanced accuracy at 65% threshold" => treat score >= 0.65 as "AI", else "real"; balanced
  accuracy = (TPR + TNR) / 2 must be >= 0.75.

## Key Decisions

(Updated as phases complete; see STATE.md and [NN]-CONTEXT.md files.)

- GSD mode: autonomous; one milestone branch `gsd/m1-ai-image-detector` from `main`; one atomic
  commit per plan, pushed incrementally.

## Current Status

Milestone 1 **COMPLETE** (v1.0.0 shipped) + post-release audit/hardening pass complete. See
STATE.md for the current verified position (<!-- AUTO:TEST_COUNT -->476<!-- /AUTO:TEST_COUNT --> tests, e2e 7/7, 84.2%/83.0% accuracy).
