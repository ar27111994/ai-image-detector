# Bounty rule compliance (poidh.xyz #323)

Every rule mapped to evidence in this repository.

## Hard requirements

| Rule                                            | Status | Evidence                                                                                                                                                    |
| ----------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fully open source under MIT                     | ✅     | [LICENSE](../LICENSE) (MIT). Bundled model is Apache-2.0 (compatible); see docs/MODEL.md.                                                                   |
| Native Manifest V3 extension                    | ✅     | [extension/manifest.json](../extension/manifest.json) — `manifest_version: 3`, service worker, offscreen document.                                          |
| All inference local (WebGPU/WASM/WebGL)         | ✅     | `src/offscreen/inference-engine.js` — ONNX Runtime Web, vendored. No remote inference anywhere.                                                             |
| One-time weight download at setup, then offline | ✅     | `src/background/model-manager.js` downloads once, SHA-256 verifies, stores in IndexedDB; `ensureModel` short-circuits when ready. No other model downloads. |
| Automatically analyze images on ordinary pages  | ✅     | `src/content/discovery.js` + MutationObserver/IntersectionObserver.                                                                                         |
| Confidence score for every analyzed image       | ✅     | `src/content/badges.js` renders a per-image score badge.                                                                                                    |
| Complete build & installation instructions      | ✅     | [README.md](../README.md) — `npm ci && npm run build`, Load unpacked.                                                                                       |
| Fully reproducible from source                  | ✅     | Pinned `package-lock.json`; model conversion in `tools/` (tools/README.md, docs/MODEL.md); benchmark in docs/BENCHMARK.md.                                  |

## Prohibited behaviors

| Rule                                          | Status | Evidence                                                                                                                                     |
| --------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| No cloud inference                            | ✅     | No inference network calls; grep for `fetch(` shows only the model manifest + one-time weight download in `src/background/model-manager.js`. |
| No image data to external services            | ✅     | Image bytes are fetched by the SW and analyzed in the offscreen doc; nothing is uploaded.                                                    |
| No local backend (Python/Node/Flask)          | ✅     | Runtime is pure extension. Python in `tools/` is a one-time, optional model-conversion aid — never required at build or runtime.             |
| No additional model downloads after setup     | ✅     | Single variant downloaded once; `models/manifest.json` is the only source of weight URLs.                                                    |
| No hardcoded benchmark hashes / lookup tables | ✅     | Detection is a real model + forensic heuristics; `bench/` is for evaluation only and is not shipped in the extension bundle.                 |
| No circumventing the evaluation               | ✅     | No eval-time detection tricks; the extension behaves identically for maintainers and users.                                                  |

## Notes for evaluators

- The forensic metadata layer shows ~0% on Hugging Face–served benchmark images because those are
  re-encoded (metadata stripped). Its value is on real-web images (A1111/ComfyUI/Midjourney/
  Firefly outputs retain signatures). The neural model alone clears the bar on the internal set.
- The evaluation's "65% confidence threshold" is the extension's default decision threshold and
  the calibrated operating point.
