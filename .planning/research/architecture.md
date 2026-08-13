# Architecture Research — ORT-web inside MV3 (verified against official docs 2026-08-13)

## Hard constraints (confirmed)

1. **CSP**: MV3 default CSP disables WASM. Manifest must set
   `content_security_policy.extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"`
   (this is also the enforced minimum; `'unsafe-eval'` is banned). Applies to SW + all extension pages.
2. **No SharedArrayBuffer** (no COOP/COEP possible for chrome-extension:// pages) =>
   `crossOriginIsolated === false` => ORT WASM runs single-threaded (auto-fallback; set
   `ort.env.wasm.numThreads = 1` explicitly).
3. **ORT proxy worker unusable** (spawns workers from Blob URLs -> CSP blocked). Run ORT on the
   offscreen document's main thread, or a dedicated Worker created from a same-origin extension URL.
4. **SW has no DOM/canvas**, but `createImageBitmap` + `OffscreenCanvas` exist in workers/SW.
   Still: keep inference out of the SW (30s idle kill; 5min max per task). Offscreen documents with
   reasons BLOBS/WORKERS have **no automatic lifetime limit** => the InferenceSession lives there.
5. **WebGPU**: unavailable in SW; available in dedicated workers spawned from a GPU-capable page;
   **offscreen-document WebGPU is undocumented/unverified** => Phase 2 spike test via Puppeteer;
   adaptive EP selection (try webgpu with timeout+1-inference self-test, else wasm).
6. **Version lock**: vendored ort .mjs and .wasm files must come from the same ort-web release
   (build script copies from node_modules; pins version).
7. **Model loading**: `InferenceSession.create()` accepts Blob/ArrayBuffer/Uint8Array; IndexedDB is
   the store (chrome.storage.local 10MB cap is too small). 2GB ArrayBuffer ceiling irrelevant at
   our sizes (<400MB). External data (model.onnx + model.onnx_data) supported if ever needed.
8. **Cross-origin images**: SW `fetch(url)` with `host_permissions: ["<all_urls>"]` bypasses page
   CORS; bytes -> Blob -> offscreen doc -> createImageBitmap (no canvas taint issues).
9. **Messaging**: long-lived `chrome.runtime.connect` ports keep SW alive during inference bursts;
   offscreen docs only have chrome.runtime messaging APIs.
10. **Quantization**: WASM SIMD => int8 dynamic (QDQ S8S8) ~4x smaller, fast; WebGPU => fp16 (int8
    QDQ ops poorly supported on JSEP). Ship two variants; pick at setup.

## Target architecture

```
Content script (per page)          Service worker (orchestrator)        Offscreen document
- discover <img>/srcset/bg   -->   - route messages (ports)      -->    - holds ORT sessions
- IntersectionObserver             - fetch image bytes (CORS-)          - preprocess (bitmap->
- MutationObserver                   bypass w/ host_permissions)          224 canvas -> CHW float)
- badge overlays (shadow DOM)      - LRU result cache (content-hash)    - metadata parsers + FFT
- relays data:/blob: URLs          - model download + SHA-256 + IDB     - fusion -> calibrated p
```

## SessionOptions baseline

`{ executionProviders: ['webgpu','wasm'] (adaptive), graphOptimizationLevel: 'all',
intraOpNumThreads: 1, freeDimensionOverrides for static 224x224 if dynamic }`

## Preprocessing (shared JS module, mirrored in Node bench)

decode -> resize to model input (224/256/384/512 per model config) -> RGB float CHW normalized with
per-model mean/std (from preprocessor_config.json; ImageNet defaults otherwise).

## Risks

- WebGPU absent in offscreen doc -> WASM int8 ViT-B ~0.3-1s/image single-thread: acceptable async,
  mitigated by queue + viewport prioritization + caching.
- Page CSP does NOT affect content-script isolated world code, but page-CSP CAN block
  `WebAssembly.instantiate` in the MAIN world; we never run WASM in page context (only offscreen).
