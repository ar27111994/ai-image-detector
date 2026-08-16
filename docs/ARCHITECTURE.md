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
│  - EP selection: WebGPU (fp16) with timed self-test -> WASM (int8/fp32)   │
│  - decode (createImageBitmap) -> OffscreenCanvas RGBA -> preprocess       │
│  - forensic layer (PNG/JPEG/XMP/C2PA/WebP byte parsers)                   │
│  - spectral features (2D FFT) + calibrated fusion -> score + verdict      │
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

| EP              | Model variant         | Why                                   |
| --------------- | --------------------- | ------------------------------------- |
| WebGPU          | fp16                  | native half-precision on GPU; fastest |
| WASM (fallback) | int8 (Conv kept fp32) | ~4x smaller, SIMD; works everywhere   |

**Quantization findings (measured):** int8 dynamic quantization _corrupts_ CLIP-family models
(activation overflow; Δp≈0.29 on probes) but is clean for the shipped SwinV2 (Δp≈0.0015). The
`tools/quantize.py` pipeline gates each variant on a softmax-drift budget vs the fp32 reference
and excludes patch-embedding Conv nodes (ORT CPU/WASM lack ConvInteger kernels).

## Model delivery (one-time, verified)

`models/manifest.json` (bundled) pins each variant's URL + SHA-256 + input spec + label
semantics. At first-run onboarding the SW downloads the variant, verifies SHA-256, and stores the
bytes in IndexedDB. Thereafter the extension is fully offline; weights are never re-downloaded
(the bounty rule). Reproducible conversion is in `tools/` (see docs/MODEL.md).

## Robustness techniques

- **Single-view full-frame inference** (default): the SwinV2 model keys on global generation
  artifacts, so the image is resized to the model input and scored once. A multi-view crop-grid
  TTA path exists (`src/shared/tta.js`) but is **off by default** — it measurably _reduced_
  accuracy on this model (BA 81.5% → 79.6%); it can be enabled for architectures that benefit.
- **Spectral features**: 2D-FFT radial spectrum + high-frequency ratio feed the fusion layer as
  a weak, bounded nudge (never a standalone verdict).
- **Forensic fast path**: C2PA/PNG-geninfo/XMP-DigitalSourceType/EXIF-generator signatures are
  near-zero-FP and short-circuit to a definitive AI verdict.
- **Calibration**: Platt logistic fitted on the internal public benchmark train split (never the
  evaluation set) so the bounty's 0.65 operating point coincides with the balanced-accuracy
  optimum; calibration quality is ECE-verified each fit.

## Privacy & security posture

- Image bytes never leave the device. The only network call is the initial model download
  (and only if the user completes setup).
- All parsers are bounds-checked and non-throwing on malformed input.
- `host_permissions: <all_urls>` is required to fetch cross-origin image bytes for analysis;
  no data is sent anywhere.
