# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

(Next release changes land here.)

## [1.0.0] — 2026-08-16 — Milestone 1 (first qualifying submission) + post-audit hardening

Post-release hardening, audit, and polish (no accuracy change — same shipped pipeline), folded
into the v1.0.0 submission.

### Added (compliance, security, CI)

- **NOTICE** file (REQ-21): licenses for every bundled third-party component — onnxruntime-web,
  exifr, fft.js (all MIT) and the haywoodsloan detection model (Apache-2.0). `LICENSE` + `NOTICE`
  now ship inside `dist/`.
- **CodeQL** workflow (security-and-quality, SHA-pinned, weekly + per-push/PR).
- **Release gates**: tag must be valid semver and match `package.json`/`manifest.json`; clean-tree
  check; `release/SHA256SUMS` generated for every published artifact and attached to the release.
- **Dependabot**: pip ecosystem for the model-conversion toolchain.
- New design tokens (`--focus-ring-contrast`, `--target-min`, `--control-size-checkbox`,
  `--z-badge-*`, named skeletons) and a shared test fixture (`tests/helpers/dom-stub.js`).

### Fixed (accessibility / UI)

- Badge detail panel now follows `prefers-color-scheme` (was hardcoded dark).
- `aria-describedby="null"` regression fixed (attribute now omitted when no hint exists).
- Touch targets raised to the 24px WCAG 2.5.8 minimum (badge, link buttons).
- High-contrast focus ring on saturated buttons; form controls get hover/disabled states.
- Popup shows a loading skeleton while the service worker responds.
- `manifest.json` gains `homepage_url`.

### Changed (code quality)

- `clamp01` deduplicated into `src/shared/math.js`; dead `aiProbability` export removed
  (softmax moved to `math.js`); all timeout/byte budgets centralized in `shared/constants.js`
  (`TIMEOUTS`, `MAX_IMAGE_BYTES`); model-variant selection shared via `shared/model-variant.js`.
- `getModelBlob` (IndexedDB) is now time-bounded like every other store op.
- **Model-download starts are deduplicated, abandonable, and supersession-safe.**
  `startModelDownload` shares one in-flight `ensureModel` promise (no duplicate ~311MB download)
  raced against a deadline (a stalled download times out so a retry starts fresh). Each attempt
  carries a generation token, so a superseded (timed-out) download's late settlement can no longer
  overwrite the retry's `ready` state or persist a stale blob.

### Fixed (PR #1 review — behavior)

- **User threshold now drives verdicts.** The popup/options threshold is threaded through
  `analyzeBytes` → `OFFSCREEN_ANALYZE` → `fuseSignals`, and the analysis cache key includes it, so
  changing the threshold actually re-classifies results (previously every verdict was computed at
  the 0.65 default and cached under a threshold-independent key).
- **Model reset is a real protocol request.** Options now sends `MODEL_RESET` via
  `makeRequest`/`sendRequest` and only announces success + opens onboarding on an `ok` response —
  previously a malformed (id-less) message was dropped by `isRequest` and the UI falsely announced
  success while the model stayed installed.
- **C2PA provenance requires a valid manifest UUID.** Claim markers are only scanned in
  UUID-validated JUMBF manifests, so a crafted `caBX`/APP11/`C2PA` chunk containing a bare AI
  marker can no longer force a definitive AI verdict on a real photo.
- **Image cache key is collision-resistant.** `imageContentKey` now hashes the full buffer
  (was head/middle/tail sampling), so two same-length images differing outside those windows no
  longer share a verdict.
- **`listModelKeys` (IndexedDB `getAllKeys`) is time-bounded** like every other store op, so a hung
  transaction can no longer stall `isModelReady()`/setup indefinitely.
- **Dependabot auto-merge workflow** now uses the GraphQL `enablePullRequestAutoMerge` mutation
  (`pulls.update` has no `auto_merge` param — the old step was a silent no-op).
- **Docs accuracy**: README/COMPETITIVE-ANALYSIS no longer claim the dormant 2D-FFT spectral module
  is in the shipped fusion; PRIVACY/SECURITY now accurately describe the cross-origin image fetch
  (bytes fetched from the image's own URL, never uploaded) instead of "no third-party requests";
  ARCHITECTURE reflects the single pinned int8 variant (no separate fp16 WebGPU variant shipped).
- **Failed WebGPU sessions are released.** When the WebGPU self-test probe rejects or times out,
  the created-but-rejected session is now `.release()`d before falling back to WASM, so a failed
  WebGPU context no longer leaks GPU/native resources.
- CodeQL hygiene: removed a dead assignment in the PNG iTXt parser; collapsed a stat-then-read
  TOCTOU window in `tools/pack.mjs` to a single read.

### Fixed (PR #1 review round 3 — input caps + hardening)

- **Superseded model commits fully gated.** Every model-state write now goes through a
  generation-aware compare-and-set (`setModelStateIfCurrent`) that re-checks the generation
  _immediately before_ the storage write — closing the residual race where a reset/replacement
  during the awaited blob write **or** the final state read let a superseded attempt publish
  `ready` over the newer state. The now-unused `setModelState` helper was removed; all writes are
  generation-gated.
- **Image fetch streams with a hard cap.** `fetchImageBytes` reads the response body in chunks and
  cancels the moment `MAX_IMAGE_BYTES` is exceeded — a chunked response without `Content-Length`
  can no longer be buffered unbounded before the size check.
- **Raw byte messages are size-checked before copying.** `normalizeBytes` rejects oversized
  ArrayBuffers and `{ data: number[] }` payloads by length _before_ `Uint8Array.from` copies them.
- **Model download enforces the pinned size.** `downloadVariant` cancels the stream when it exceeds
  the pinned `sizeBytes` (+1MB tolerance) and rejects a final size mismatch, so a false/missing
  `Content-Length` can no longer cause an unbounded allocation before SHA-256 rejection.
- **Build fails without the model manifest.** A missing/unreadable `models/manifest.json` now fails
  `npm run build` instead of silently shipping an extension that cannot install its model.
- **`npm run models:manifest` works.** Added the previously-missing `tools/verify-manifest.mjs`
  (structural + integrity-pin validation); the script no longer fails with module-not-found.

### Fixed (PR #1 review round 4/5 — lifecycle + manifest semantics)

- **Reset no longer reuses an invalidated download.** `resetModel` clears the in-flight dedup
  handle (`downloadingModel`) in addition to advancing the generation, so a post-reset
  `MODEL_DOWNLOAD_START` starts a fresh `ensureModel` instead of awaiting the superseded promise
  (which would reject SUPERSEDED and leave installation unavailable until the old op settled).
- **Model-state compare-and-set is airtight.** The generation is re-checked immediately before the
  synchronous storage write (no interleaving await in the single-threaded SW), and the supersession
  regression tests are now deterministic (latched, not `setTimeout`-based).
- **Manifest validator enforces output semantics.** `verify-manifest.mjs` now rejects an
  unrecognized `outputType` (only `logits`/`p_real`) and an out-of-range `aiLogitIndex` (must be
  0/1 for logits variants), so a malformed variant can't reach inference and produce a garbage
  calibrated verdict.

### Testing

- **458 tests / 35 files** (was 227/24 at v1.0.0). New unit suites for the previously untested
  popup/options/onboarding pages, the offscreen orchestrator, the service-worker router, and the
  manifest verifier (`tools/verify-manifest.mjs`). Concurrency/stress suites (50-unique and
  50-identical-image stampedes verifying exactly-once inference and cache-collapse, plus
  concurrent-download dedup, stalled-download-recovery, superseded-generation, and post-write
  supersession tests), input-cap suites (streamed image overflow cancel, oversized raw-byte
  rejection, model size-budget cancel + final-size mismatch), adversarial security suites
  (prototype-pollution, hostile message envelopes, full-pipeline XSS through a hostile A1111 PNG,
  C2PA UUID-validation), WebGPU session-leak release tests, and edge/corrupt-input parsers.
  Integration dispatch harness de-flaked (event-driven latch replaces fixed sleeps). Coverage gate
  ≥90% (98.4/91.1/98.0 measured).

### Fixed (accuracy documentation)

- **Accuracy figures corrected to the shipped numbers.** The README and some docs previously
  showed the _uncalibrated_ raw neural score (81.5%) while claiming it was the calibrated pipeline
  result. `tools/sync-docs.mjs` now sources the definitive shipped-calibration runs
  (`haywoodsloan-int8__single-full-final.jsonl`, `haywoodsloan-int8__single-aug-final.jsonl`):
  **84.2% raw** / **83.0% augmented (full 1,413-image set)** @ 0.65. The augmented figure replaces
  a non-representative 103-image subset (83.13%) with the full-set measurement. Both numbers were
  reproduced live by re-running the shipped pipeline (`bench/run-pipeline.mjs`).

### Added

- **Detection engine**: ONNX Runtime Web in an offscreen document, adaptive WebGPU(fp16) →
  WASM(int8) execution-provider selection with a timed self-test; shared pure-JS preprocessing
  (bilinear resize + CHW normalize) identical in browser and benchmark.
- **Hybrid ensemble**: SwinV2 neural detector (haywoodsloan, Apache-2.0, int8 311MB) + forensic
  metadata layer (PNG geninfo, JPEG EXIF/XMP, C2PA JUMBF, WebP chunks) + 2D-FFT spectral features,
  fused via Platt calibration into one score.
- **UX**: auto-discovery (img/srcset/picture/background/poster) with MutationObserver +
  IntersectionObserver; shadow-DOM confidence badges; popup (status, threshold, per-site toggle);
  options page; first-run onboarding with verified one-time model download.
- **Model delivery**: weights published to GitHub Release `models-v1`, SHA-256 pinned in
  `models/manifest.json`, stored in IndexedDB, fully offline afterwards.
- **Toolchain**: esbuild (split ESM/IIFE), Vitest + v8 coverage, ESLint flat, Prettier, GitHub
  Actions CI, Puppeteer e2e harness (spawn + CDP connect — deterministic on Chrome 139).
- **Benchmark**: seeded stratified dataset fetch (OpenFake/OpenFakeTiny/COCO), web-realistic
  augmentations, per-model + full-pipeline accuracy harness with Wilson CIs and a 75%/80% gate.

### Accuracy (internal public benchmark, threshold 0.65, full runs on the shipped single-view path)

- Full pipeline, raw split (471 images), shipped calibration: **84.2% balanced accuracy**
  (TPR 82.6 / TNR 85.8). The raw neural score before calibration was 81.5% (TPR 63.6 / TNR 99.4).
- Augmented split (1413 images: jpeg70/85 + resize50), shipped calibration: **83.0% BA**
  (TPR 81.0 / TNR 85.0). (Supersedes an earlier 83.1% figure from a 103-image subset.)
- Crop-grid TTA was implemented and **rejected by measurement** (regressed BA to 79.6%); it is
  off by default (`enableCropGrid: false`). Calibration is ECE-verified (0.244 → 0.059).

### Testing

- 227 unit + integration tests (24 files); coverage gate 90% on lines/branches/functions/statements.
- E2E suite (6 cases) passes on a clean clone (`npm ci && npm run build && npm run test:e2e`).

### Notable fixes discovered during development

- int8 dynamic quantization corrupts CLIP-family models (Δp≈0.29) but is clean for SwinV2
  (Δ≈0.0015); Conv nodes are excluded from quantization (ORT lacks ConvInteger on CPU/WASM).
- Content scripts cannot be ES modules — build emits IIFE for the content script.
- MV3 service workers start lazily; e2e navigates to a matching page before polling.
- puppeteer.launch's default `--enable-automation` interferes with `--load-extension` on
  Chrome 139 — the e2e harness spawns Chrome directly and connects via CDP.
