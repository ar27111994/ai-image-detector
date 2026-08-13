# Requirements — AI Image Detector v1

## Core Goal

A Manifest V3 Chrome extension that, after a one-time model download at setup, automatically
analyzes images on any webpage fully offline and displays a per-image AI-confidence score,
achieving >= 75.0% balanced accuracy (65% threshold) on the maintainers' benchmark.

## Must-Have (v1)

### Phase 1: Research validation + scaffold

- REQ-01: Candidate detection models surveyed, downloaded, and empirically compared on a
  self-assembled public benchmark (balanced accuracy reported per model) — Phase 1
- REQ-02: Repo initialized with MIT LICENSE, package manifest, pinned dependencies, bundler
  config, MV3 manifest scaffold, CI workflow, lint/format config — Phase 1
- REQ-03: Reproducible model pipeline script (fetch/convert/quantize/verify ONNX with pinned
  SHA-256) runnable from source — Phase 1

### Phase 2: Inference engine

- REQ-04: ONNX Runtime Web vendored locally (no CDN at runtime) — Phase 2
- REQ-05: Inference runs in an offscreen document with WebGPU EP and WASM fallback — Phase 2
- REQ-06: Model weights downloaded once at first-run setup, SHA-256 verified, cached in
  IndexedDB; never re-downloaded; fully offline afterwards — Phase 2
- REQ-07: Image bytes fetched cross-origin via the service worker (host permissions), decoded
  and preprocessed (resize/normalize) without page-CORS taint — Phase 2
- REQ-08: Message protocol (content script <-> service worker <-> offscreen doc) with request
  IDs, timeouts, cancellation, and LRU result cache keyed by content hash — Phase 2

### Phase 3: Detection UX

- REQ-09: Content script auto-discovers images (`<img>`, `<picture>/srcset`, `background-image`,
  lazy-loaded, dynamically inserted via MutationObserver) — Phase 3
- REQ-10: Every analyzed image gets a non-destructive overlay badge with confidence score
  (color-coded: red=AI, green=real, amber=uncertain); badge follows scroll/resize — Phase 3
- REQ-11: Popup shows page stats + per-image score list; options page controls threshold,
  badge visibility, min image size, per-site disable — Phase 3
- REQ-12: First-run onboarding flow triggers the one-time model download with progress — Phase 3

### Phase 4: Ensemble & calibration

- REQ-13: Metadata/forensic module parses PNG text chunks, JPEG EXIF/XMP, C2PA/JUMBF presence,
  WebP XMP/EXIF for AI-generator signatures — Phase 4
- REQ-14: Spectral-feature module (FFT-based features) as secondary signal — Phase 4
- REQ-15: Fusion layer combines neural score + forensic signals into a calibrated probability;
  calibration (e.g. Platt/isotonic parameters) fitted on held-out public data, serialized in-repo
  — Phase 4

### Phase 5: Testing & accuracy gate

- REQ-16: Unit tests for all pure modules (preprocessing, fusion, metadata parsers, cache,
  protocol) with coverage reporting — Phase 5
- REQ-17: Integration tests: full pipeline in Node (onnxruntime-node) over the self-benchmark;
  balanced accuracy + confusion matrix emitted — Phase 5
- REQ-18: E2E tests (Puppeteer, headless Chrome with extension loaded): install -> setup ->
  synthetic page with labeled images -> badges appear with scores — Phase 5
- REQ-19: Accuracy gate: internal balanced accuracy >= 80% on assembled benchmark at 65%
  threshold (buffer above the 75% bar) — Phase 5

### Phase 6: Docs & release

- REQ-20: README with complete build + installation instructions, architecture overview,
  model provenance (source, license, conversion steps), and reproduction steps — Phase 6
- REQ-21: MIT LICENSE at repo root; all third-party licenses bundled (NOTICE) — Phase 6
- REQ-22: Release packaging script producing the loadable/unpacked `dist/` and a zipped build —
  Phase 6
- REQ-23: Rule-compliance audit doc mapping every bounty rule to evidence — Phase 6

## Should-Have (v2)

- REQ-30: Firefox (MV2/MV3) port
- REQ-31: Video frame sampling detection
- REQ-32: User feedback loop ("wrong verdict" reporting stored locally)

## Out of Scope (v1)

- Deepfake face-swap-specific detection (faces are a subset of images; general detector only)
- Video/audio detection
- Any server-side component
- Automatic submission/claim on poidh.xyz (manual step by owner)

## Constraints (from bounty rules)

- No cloud inference; no image data to external services; no local backend processes.
- No additional model downloads after initial setup.
- No hardcoded benchmark hashes/lookup tables; no evaluation circumvention.
- MIT license; reproducible from source; native MV3.

## Acceptance Criteria (maps to evaluation)

- Clean build from source: `npm ci && npm run build` produces loadable extension.
- Fresh Chrome profile: install -> onboarding downloads model once -> offline -> badges with
  scores on arbitrary pages.
- Internal benchmark harness reports balanced accuracy with 95% CI; result >= 0.80 at 0.65
  threshold.

## Open Questions

- Final model choice (pending Phase 1 research; candidates: umm-maybe/AI-image-detector,
  SigLIP/ConvNeXt community detectors, NPR/FatFormer/AIDE research weights).
- Whether WebGPU EP is stable enough in offscreen docs on maintainer hardware -> WASM fallback
  mandatory either way.

## Assumptions

- Maintainers allow one-time weight download from Hugging Face (explicitly permitted by rules).
- Benchmark images are ordinary web images (JPEG/PNG/WebP), not adversarially crafted to break
  parsing.
