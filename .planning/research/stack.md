# Stack Research — AI Image Detector (Chrome MV3)

## User-stated preferences

None beyond bounty constraints: native MV3 Chrome extension, local inference via WebGPU/WASM/WebGL,
MIT license, reproducible build.

## Recommended stack

| Layer                  | Choice                                        | Why                                                        |
| ---------------------- | --------------------------------------------- | ---------------------------------------------------------- |
| Language               | JavaScript ES2022 (ESM)                       | Native to extensions; no transpile-only complexity         |
| Bundler                | esbuild (pinned)                              | Fast, single dep, copies ORT wasm assets, trivial repro    |
| Inference              | onnxruntime-web (vendored via npm, pinned)    | WebGPU + WASM EPs, Blob model input, external data support |
| Bench/inference (Node) | onnxruntime-node (same major version)         | Same ONNX graph + preprocessing parity for accuracy gate   |
| Unit tests             | Vitest (+ @vitest/coverage-v8)                | ESM-native, fast, coverage built-in                        |
| E2E tests              | Puppeteer (headless=new, --load-extension)    | Real MV3 loading, offscreen doc support                    |
| Metadata               | hand-rolled container parsers + exifr (MIT)   | exifr covers EXIF/XMP/IPTC; byte-scan for C2PA/PNG         |
| FFT                    | fft.js (MIT)                                  | Spectral features (weak learner)                           |
| CI                     | GitHub Actions (lint, unit, integration, e2e) | Free for public repos                                      |

## Alternatives considered

- **Transformers.js v3**: higher-level, but its official extension example runs WASM in the SW and
  local-model-from-IndexedDB is awkward; we keep direct ort-web control (EP choice, quantization
  variants, memory). Rejected as primary; may inspire preprocessing code (Apache-2.0).
- **TensorFlow.js**: viable but ONNX ecosystem (HF exports, quantization tooling) is stronger.
- **WebNN**: too immature/hardware-variable; skip for v1.

## Key constraints discovered (see architecture.md)

- MV3 CSP must be `script-src 'self' 'wasm-unsafe-eval'` or WASM is disabled entirely.
- No SharedArrayBuffer in extension pages => single-threaded WASM only.
- ORT proxy worker unusable (Blob-URL workers blocked by CSP); run ORT in offscreen doc main thread
  or a dedicated worker spawned from the offscreen doc.
- WebGPU availability in offscreen documents is NOT officially documented => spike in Phase 2 with
  mandatory WASM fallback and adaptive EP self-test at setup.

## Lock-in / migration concerns

- ORT version lock between .mjs and .wasm files (must vendor matching set — enforced by build script).
- Model manifest (URL + SHA-256) is the single source of truth for weights; swapping models is a
  manifest change + re-calibration.
