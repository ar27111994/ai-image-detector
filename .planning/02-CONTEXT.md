# Phase 2 — CONTEXT: Inference engine + extension core

## Vision

Build the runtime spine of the extension: a service worker that orchestrates, an offscreen
document that owns the ONNX Runtime session(s) and all analysis, and a model manager that
performs the one-time verified download. The content-script UX (badges) is Phase 3; this phase
ends with a loadable extension whose offscreen document can analyze an image end-to-end via
`chrome.runtime` messaging (proven by e2e).

## Locked decisions

- **ORT vendored**: onnxruntime-web bundled into `offscreen.js` by esbuild; wasm assets copied to
  `dist/vendor/`; `ort.env.wasm.wasmPaths` pointed at `chrome.runtime.getURL('vendor/')`.
- **Execution providers**: adaptive. At setup, offscreen doc tries `webgpu` (fp16 model) with a
  5s init timeout + one timed self-test inference; on failure/slowness falls back to `wasm`
  (fp32 model, single thread — no SAB in extensions). The chosen EP + timings are persisted to
  chrome.storage.local for diagnostics.
- **Model delivery**: `models/manifest.json` (repo + copied into dist) lists variants
  (`webgpu`: fp16 url, `wasm`: fp32 url) with SHA-256 + input spec + label semantics
  (`outputType: p_real | logits`, `aiLogitIndex`). One-time download at onboarding; bytes
  verified against SHA-256; stored as Blob in IndexedDB (`ai-image-detector-models` DB).
- **Messaging**: `src/shared/protocol.js` defines typed envelopes
  `{ id, type, target, payload }`, request/response correlation by id, 120s inference timeout,
  and an `AbortController`-style cancel token via id. Long-lived port per tab for keep-alive.
- **Image transport**: SW fetches cross-origin bytes (host_permissions), converts Blob ->
  ArrayBuffer, passes bytes to offscreen doc (structured clone). data:/blob: URLs are read by the
  content script and relayed as bytes. All analysis inputs are: { contentHash, mime, bytes }.
- **Analysis pipeline (offscreen)**: bytes -> metadata/forensic parse (Phase 4 module, stub now)
  -> decode via createImageBitmap -> OffscreenCanvas RGBA -> shared preprocessRgba -> ORT
  session(s) -> score -> (Phase 4 fusion) -> result { score, verdict, reasons[], latencyMs }.
- **Caching**: two layers — in-memory LRU in SW (512 entries by content hash) and persistent
  `chrome.storage.local` settings only (results are NOT persisted across sessions in v1).

## Security/privacy

- No remote code: everything bundled; CSP `script-src 'self' 'wasm-unsafe-eval'`.
- Image bytes never leave the device; the only network call is the model download at setup.
- All parsers bounds-checked; malformed inputs -> structured error, never throw across contexts.
