# Architecture

AI Image Detector is a Manifest V3 Chrome extension that detects AI-generated images entirely
on-device. No cloud inference, no external APIs, no local server. After a one-time model
download at first-run setup, all inference is offline.

## Process model

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Web page (any site)                                                       │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ Content script (isolated world, plain script — no WASM here)       │  │
│  │  - discover <img>/srcset/picture/background/poster                 │  │
│  │  - MutationObserver (SPA/infinite scroll) + IntersectionObserver    │  │
│  │  - shadow-DOM confidence badges                                    │  │
│  └───────────────────────────────┬────────────────────────────────────┘  │
└──────────────────────────────────┼────────────────────────────────────────┘
                                   │ chrome.runtime messages (typed envelopes)
┌──────────────────────────────────▼────────────────────────────────────────┐
│ Service worker (orchestrator — killed when idle, so it holds no model)     │
│  - fetch cross-origin image bytes (host_permissions bypass page CORS)     │
│  - one-time model download, SHA-256 verify, persist to IndexedDB          │
│  - LRU result cache (keyed by content hash)                               │
│  - routes analysis requests to the offscreen document                     │
└──────────────────────────────────┬────────────────────────────────────────┘
                                   │ chrome.runtime messages
┌──────────────────────────────────▼────────────────────────────────────────┐
│ Offscreen document (long-lived, owns the ONNX Runtime session)            │
│  - ONNX Runtime Web (vendored, version-locked)                            │
│  - EP selection: WebGPU (timed self-test) -> WASM fallback (int8 model)   │
│  - decode (createImageBitmap) -> OffscreenCanvas RGBA -> preprocess       │
│  - forensic layer (PNG/JPEG/XMP/C2PA/WebP byte parsers)                   │
│  - calibrated fusion (neural + forensic) -> score + verdict               │
└───────────────────────────────────────────────────────────────────────────┘
```

## Why this split

- **Service workers cannot hold long-lived state** (30s idle kill) and have no DOM — so the ONNX
  session lives in the **offscreen document**, which has no automatic lifetime limit for our
  reasons (`BLOBS`, `WORKERS`). The SW only orchestrates.
- **Content scripts run in the page's isolated world** where the page's CSP can block
  `WebAssembly.instantiate`. We therefore run no inference in the content script; the offscreen
  document (extension origin, our CSP) is the only place WASM/WebGPU runs.
- **MV3 CSP**: the manifest sets `script-src 'self' 'wasm-unsafe-eval'` — the minimum that
  enables WebAssembly. No `'unsafe-eval'`, no remote code.

## Execution providers & quantization

| EP              | Model variant         | Why                                                  |
| --------------- | --------------------- | ---------------------------------------------------- |
| WebGPU          | int8 (Conv kept fp32) | GPU-accelerated; runs the single pinned int8 variant |
| WASM (fallback) | int8 (Conv kept fp32) | ~4x smaller, SIMD; works everywhere                  |

> The shipped manifest declares **one** variant (`wasm`/int8), which both EPs load — `pickVariantForEp`
> prefers a `webgpu`-kind variant when present and otherwise falls back to the shared int8 bytes. An
> fp16 WebGPU variant was evaluated but is **not shipped**: ORT's CPU EP fails SwinV2's
> `Loop`/`SequenceInsert` type inference after fp16 conversion, so int8 is the single validated
> variant (see docs/MODEL.md). The manifest schema supports adding an fp16 variant later without code
> changes.

**Quantization findings (measured):** int8 dynamic quantization _corrupts_ CLIP-family models
(activation overflow; Δp≈0.29 on probes) but is clean for the shipped SwinV2 (Δp≈0.0015). The
`tools/quantize.py` pipeline gates each variant on a softmax-drift budget vs the fp32 reference
and excludes patch-embedding Conv nodes (ORT CPU/WASM lack ConvInteger kernels).

## Model delivery (one-time, verified)

`models/manifest.json` (bundled) pins each variant's URL + SHA-256 + input spec + label
semantics. At first-run onboarding the SW downloads the variant, verifies SHA-256, and stores the
bytes in IndexedDB. Thereafter the extension is fully offline; weights are never re-downloaded
(the bounty rule). Reproducible conversion is in `tools/` (see docs/MODEL.md). Concurrent
download starts share a single in-flight `ensureModel` promise, so a retry after a timed-out
onboarding request waits for the same operation instead of fetching and hashing twice. The shared
entry is abandonable: it is raced against `TIMEOUTS.MODEL_DOWNLOAD_MS`, so a stalled download
rejects and clears, letting a later retry start a fresh download rather than block until the
service worker restarts.

## Robustness techniques

- **Single-view full-frame inference** (default): the SwinV2 model keys on global generation
  artifacts, so the image is resized to the model input and scored once. A multi-view crop-grid
  TTA path exists (`src/shared/tta.js`) but is **off by default** — it measurably _reduced_
  accuracy on this model (BA 81.5% → 79.6%); it can be enabled for architectures that benefit.
- **Forensic fast path**: C2PA/PNG-geninfo/XMP-DigitalSourceType/EXIF-generator signatures are
  near-zero-FP and short-circuit to a definitive AI verdict.
- **Calibration**: Platt logistic fitted on the internal public benchmark train split (never the
  evaluation set) so the bounty's 0.65 operating point coincides with the balanced-accuracy
  optimum; calibration quality is ECE-verified each fit.

> **Spectral (2D-FFT) module — status.** `src/shared/metadata/spectral.js` implements the
> FFT-based radial-spectrum / high-frequency-ratio features and is fully unit-tested
> (`tests/unit/spectral.test.js`). It is **not currently wired into the shipped fusion layer**:
> under the shipped int8 model + Platt calibration, the neural + forensic fusion already clears
> the accuracy gates, and adding the spectral term did not improve the measured result on the
> internal benchmark. The module is retained (and exercised by tests) as a research artifact so it
> can be re-enabled behind a calibration refit if a future model/dataset benefits. See
> `docs/RESEARCH.md` and `.planning/TECH-DEBT.md`.

## MV3 service-worker lifecycle

The service worker is killed after ~30s idle and restarted on demand. Design consequences:

- **No model/state is held in the SW.** The ONNX session lives in the offscreen document; the
  model bytes live in IndexedDB. A SW restart therefore loses nothing essential.
- **In-memory dedup/cache is best-effort.** The analysis LRU cache and the concurrent-identical
  inflight map are in-memory and reset on restart. This is a deliberate tradeoff: a restart only
  means a repeated image is re-analyzed once (never a correctness bug, just a cache miss). The
  offscreen document holds the warm session, so the cost of a restart is small.
- **Offscreen recovery.** If the offscreen document is killed or unresponsive, the SW detects the
  failed warm-up, closes the stale document, recreates it, and retries once before surfacing an
  error (see `ensureInferenceReady` / `recreateOffscreenDocument` in `service-worker.js`).
- **EP fallback releases failed sessions.** During adaptive EP selection, a WebGPU session whose
  self-test probe rejects or times out is `.release()`d before the engine falls through to WASM
  (`createSessionForEp` in `inference-engine.js`), so a failed GPU context never leaks.

## Privacy & security posture

- Image bytes never leave the device. The only network call is the initial model download
  (and only if the user completes setup).
- All parsers are bounds-checked and non-throwing on malformed input.
- `host_permissions: <all_urls>` is required to fetch cross-origin image bytes for analysis;
  no data is sent anywhere.
