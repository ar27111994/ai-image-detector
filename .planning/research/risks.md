# Risk Research — AI Image Detector

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Single model fails 75% bar on unseen modern generators (Flux/MJ6/Imagen3) | Medium | Fatal | Empirical model selection (Phase 1) + ensemble + forensic layer; internal gate at 80% |
| R2 | WebGPU unavailable/broken in offscreen document | Medium | Medium | WASM int8 fallback is the baseline design; WebGPU is a bonus. Phase 2 spike decides |
| R3 | WASM single-threaded inference too slow (ViT-B int8) | Low-Med | Medium | Async queue, viewport priority, content-hash cache, skip small images; fp16 WebGPU path |
| R4 | Benchmark distribution shift (maintainers' set != internal set) | Medium | High | Over-sample web-realistic augmentations (JPEG re-encode, resize); target 80% internal |
| R5 | Maintainer build fails (env differences) | Low | Fatal | `npm ci && npm run build` only; pinned lockfile; no Python required at build; CI reproduces |
| R6 | Model license issues (NPR) | — | — | NPR excluded from shipping; only MIT/Apache models shipped |
| R7 | SW lifecycle kills long downloads/inference | Medium | Low | Offscreen doc owns session; ports keep SW alive; resumable download w/ IDB persistence |
| R8 | Content-script perf on image-heavy pages (100s of imgs) | Medium | Medium | Size threshold, IntersectionObserver, debounce, max concurrency, LRU by content hash |
| R9 | ORT wasm/CSP misconfiguration breaks WASM at eval time | Low | Fatal | e2e test loads the real extension in headless Chrome and asserts a real inference result |
| R10 | Cross-origin fetch failures (hotlink protection, signed URLs) | Medium | Low | Fallback: content-script canvas readback when CORS-clean; badge "unavailable" state |
| R11 | int8 quantization accuracy drop vs fp32 | Low-Med | Medium | Benchmark compares fp32 vs int8; if drop >1pt, ship fp16-webgpu + fp32-wasm instead |
| R12 | One-time download UX failure (offline at install, corrupt bytes) | Low | Medium | SHA-256 verify, resume, clear error state + retry in onboarding |

## Security/privacy posture
- Zero network egress after setup except user-triggered model re-download; no telemetry; no image
  bytes leave the device (rule). Permissions: offscreen, storage, unlimitedStorage?, host <all_urls>
  (required for cross-origin image fetch — documented in README/privacy note).
- No remote code: all JS bundled; CSP locks script-src to 'self'; no eval.
- Input hardening: image byte parsing bounds-checked; parser fuzz fixtures in tests.
