# Project Context & Decision Log (Imported)

> **What this file is:** a distilled, durable context document for the AI Image Detector
> project, reconstructed from the five VS Code Copilot agent-session chats (Aug 13–19, 2026)
> that built this repo. Future agents working on this project should read this first, then
> use `session_search` for full fidelity (see [Imported sessions](#imported-sessions)).
>
> **Authenticity note:** everything below came from the surviving chat records. 56 of 57
> assistant replies in the "comprehensive project quality review" side chat were lost in a
> VS Code data-loss incident and are NOT recoverable — no content was fabricated to fill
> that gap. Numbers marked with ✅ come from the final verified state; others are from the
> transcripts.

## Snapshot (2026-08-19)

- **Repo:** `github.com/ar27111994/ai-image-detector` · local `C:\Projects\AI Image Detector`
- **Branch:** `gsd/m1-ai-image-detector` · PR #1 open against `main`
- **Version:** v1.0.0 (2026-08-16) · MIT license · MV3 Chrome extension
- **Bounty:** poidh.xyz/arbitrum/bounty/323 — "local AI challenge" (winner-take-all)
- ✅ **Tests:** 227/227 unit+integration · e2e 6/6 · lint/prettier clean · build OK
- ✅ **Coverage:** ≥90% gate on every metric (96.9% lines / 91.0% branches / 93.1% functions)
- ✅ **Accuracy (final measured state @ 0.65, per repo docs):** raw (calibrated, shipped
  Platt) **84.2%** — TPR 82.6% / TNR 85.8%, CI [78.7, 88.4], ECE 0.047 on 471 images ·
  augmented **83.0%** · uncalibrated neural-only raw **81.5%** (documented as such —
  calibration is what lifts it past the gate). Bounty bar 75%, internal gate 80%.
- ✅ **Remaining manual step (owner):** submit the poidh.xyz #323 claim with the repo link.
  Everything else is done, measured, and pushed.

## Bounty requirements (the hard contract)

- Native Manifest V3 Chrome extension; ALL inference in-browser (WebGPU/WASM/WebGL).
- No cloud inference, no external APIs, no local server/Python/Node backend dependencies.
- One-time download of public model weights allowed during setup; then fully offline.
- ≥75.0% balanced accuracy at the 65% confidence threshold on a private held-out set
  (real + SDXL/Midjourney/DALL-E 3/Flux/Imagen + web-realistic JPEGs).
- Auto-scan webpage images, per-image confidence score, MIT license, reproducible from source.
- **Disqualified by:** cloud inference / uploads, post-setup downloads, hardcoded benchmark
  hashes/lookup tables, eval-circumvention, maintainer-judged spirit violations.
- Compliance was proven by direct code audit (source AND built dist): exactly 5 fetch sites,
  all inputs; only remote URL in dist = pinned model download.

## Architecture (as shipped)

- **Service worker** — orchestration only; never holds the ONNX session (killable).
  One-time model download (SHA-256 mandatory) → IndexedDB Blob store; content-hash LRU dedup.
- **Offscreen document** — owns ORT InferenceSessions (adaptive execution providers:
  WebGPU fp16 → WASM fp32). Patch aggregation = **single full-frame view by default
  (multi-crop grid exists but is opt-in OFF** — measured regression 79.6% vs 84.5%
  single-view on SwinV2; crops discard the global artifacts SwinV2 keys on), logit
  averaging (pre-softmax) retained.
- **Content script** — classic script (IIFE, NO top-level ESM — build-enforced); discovery
  (img/picture/srcset/CSS bg/input[type=image]/poster/preload; MutationObserver +
  IntersectionObserver; URL dedup); Shadow-DOM badges; concurrency cap MAX_CONCURRENT_ANALYSES=3;
  data:/blob: relayed as bytes.
- **Fusion** — forensic definitive hit (C2PA generative claim, PNG geninfo, XMP
  DigitalSourceType, EXIF generator tag) ⇒ score 0.99 and short-circuit (never waste
  inference on proven content); otherwise logistic fusion over neural + weak forensic
  features, then Platt calibration. Single-threaded ORT (no SharedArrayBuffer in extensions).
- **Verdicts:** AI / Real / Unclear / N/A (no model yet) / Skipped. N/A before model setup
  is designed graceful degradation, not a bug.
- **Design system:** `extension/pages/tokens.css` (indigo-600 #4f46e5, WCAG AA ≥4.5:1, dark
  mode, reduced-motion); popup/options/onboarding + badges consume tokens.
- Popup shows real per-page stats via GET_TAB_STATS; sender validation
  (`isExtensionContext` — reject foreign `sender.id`/origins); randomized message IDs.

## Model & weights

- **Shipped:** `haywoodsloan/ai-image-detector` SwinV2 195M, Apache-2.0 (license on the
  GitHub repo; HF card lacked one — verified before shipping), 256×256, ImageNet
  mean/std [0.485,0.456,0.406]/[0.229,0.224,0.225]. Variant `primary-int8`, sizeBytes
  326,220,562 (311 MB on disk), SHA-256 pinned (starts `4ac57050…`), released as GitHub
  Release `models-v1`, URL pinned in `models/manifest.json` (URL+size+SHA-256).
- **Quantization lessons (empirical, family-dependent):** int8 dynamic corrupts
  CLIP-family (wkaandemir Δp≈0.29; activations overflow) → CLIP ships fp16/fp32. SwinV2
  is inverse: fp16 breaks ORT CPU (Loop/SequenceInsert type inference), int8 quantizes
  cleanly (drift 0.0015). `VALIDATION_TOLERANCE_LOGITS` = 0.02. Quantize with Conv nodes
  excluded (ORT CPU/WASM lack ConvInteger kernels); validate max softmax drift before shipping.
- **Rejected candidates (why):** NPR (best cross-generator 91.7% on GenImage but no license
  = legal risk for a bounty), dima806 (0% TPR on modern generators), Ateeqq SigLIP2
  (98%+ but user-reported overfitting), Bombek1 2-GB ensemble (browser-hostile),
  Organika CC-BY-NC (non-commercial), onnx-community baseline (weaker on modern gens).
- **Score semantics per model differ** (wkaandemir's own fake bar is aiScore>0.09, not
  0.65). Shipped monotonic remap s'=s^k relocates the optimal operating point to 0.65 —
  legitimate: fitted on the project's OWN public benchmark, never the bounty set.

## Calibration

- Platt/logistic: `p = sigmoid(a·logit(s) + b)`. Earlier fit a=0.5204, b=2.9321; **final
  shipped fit a=0.5120, b=3.0046** — refit on the corrected single-view path (fitted on
  the project's train split n=235 ONLY, never the test/eval split; anti-benchmaxxing
  preserved). Refit results: held-out test BA 80.7% → 82.8%, ECE 0.244 → 0.059 (final
  doc ECE 0.047). The production number 84.2% raw calibrated (vs 81.5% uncalibrated
  neural) IS the shipped calibration's effect — calibration lifts the model past both gates.
- `bench/run-pipeline.mjs` imports `fuseSignals` → `calibration.js` as an ES module,
  evaluated ONCE per process — a single run NEVER mixes calibrations (the "mixed file"
  scare was two sequential runs using different committed coefficients; verified via
  the consistency side chat). Both headline numbers agreed to live under the same
  shipped calibration.
- **`fusion/calibration.json` is GENERATED — never hand-edit; refit via `bench/calibrate.mjs`.**
- ECE (expected calibration error) added to `metrics.js` + `calibrate.mjs` so calibration
  quality is verified, not assumed.
- "Re-run necessity" question (side chat d3d5c527): calibration fit is deterministic on a
  seeded split → re-runs only needed if data/model change. Consistency was reviewed in-session.

## Benchmark & data (reproducibility)

- 471 raw images (155 real / 316 fake across 47 generators: Flux, MJ 6/7, Imagen 3,
  SD 3.5, SDXL, GPT-Image, DALL-E 3, Grok, Seedream, Recraft, …) plus 1,413 augmented
  (jpeg70/85 + resize50 variants), seed 1337 for sampling.
- Sources: OpenFake validation (`ComplexDataLab/OpenFake`, CC-BY-NC-4.0 — internal bench
  only, NOT shipped/trained), COCO val (`sayakpaul/coco-30-val-2014`), LAION/Pexels reals.
  OpenFake real/fake share 43–59%; ids >58999 = test split (HF datasets-server `row_idx`
  is page-relative — known trap).
- Harness: `bench/fetch-dataset.mjs` (stratified, resumable), `augment.mjs`,
  `model-loader.mjs` (sha256 cache), `run.mjs` (onnxruntime-node), `metrics.mjs`
  (threshold sweep, Wilson CI, per-generator TPR), `calibrate.mjs`, `run-pipeline.mjs`
  (forensic→neural→fusion e2e; **exits 1 when BA < 0.75 — real CI gate**).
- Bench results summary: haywoodsloan fp32 81.16% / int8 81.48% on 471 (uncalibrated);
  augmented int8 ALL 80.85% (TPR 62.18 / TNR 99.52, CI [79.03,82.33]); pipeline raw
  calibrated 84.53% (CI [79.13,88.65]). **Final accepted numbers (repo docs, AUTO-synced):
  raw calibrated 84.2% (TPR 82.6/TNR 85.8, CI [78.7,88.4], ECE 0.047) · augmented 83.0% ·
  uncalibrated neural-only 81.5%.** Earlier runs under the previous calibration are
  historical context. Crop-grid TTA measured and reverted (79.58% vs 84.5% single-view) —
  the SOTA-paper "+1.5–2.5%" estimate was wrong for SwinV2 here. Ensembles never beat
  haywoodsloan alone (wkaandemir TNR≈29% drags any mix). Forensic on HF-served images =
  0/149 (metadata stripped in transit) → real-web signal only.

## Competitive standing (docs/COMPETITIVE-ANALYSIS.md)

- Measured head-to-head on the lead competitor's own 12-frame showcase: **91.7% BA**
  (TPR 6/6, TNR 5/6) vs their ~76.7% (43-image set). One FP: Unsplash frame scored 0.708.
- Competitor `delpot/steganograph-ia-detector`: author 92.5% BA on own 15K set; independent
  31-image check 83.3% — overlaps the 75% bar. No complacency warranted; v2 ideas exist.

## Key decisions (ADR-style, with rationale)

1. **Empirical harness before model choice** — model-card numbers lie on modern generators
   (dima806: 50% BA in smoke). Selection used threshold-free sweeps/ROC, never the bounty set.
2. **Ship haywoodsloan SwinV2 int8 as neural backbone** — best solo BA; ensemble mixing
   regressed. Forensic layer added for TPR uplift on real web images (definitive → 0.99).
3. **License gate for anything shipped** — NPR excluded (no license); OpenFake CC-BY-NC = bench only.
4. **No `web_accessible_resources`** — fingerprinting risk; loads originate from the
   extension origin. Blob/data relay implemented as real byte relay in content.js.
5. **SHA-256 mandatory** in variant specs (`MISSING_INTEGRITY` otherwise); stale downloads
   must rightfully fail.
6. **Sender validation + randomized message ids** — external pages/extensions cannot drive analysis.
7. **Generation guards** on model-manager commits (generation-advance race) — validate
   generation AFTER awaited persistence. XMP default-namespace law: elements only, never
   unprefixed attributes (3 regression tests).
8. **Short-circuit fusion** — definitive forensic hit skips inference (defended vs "why not
   always both" review comment; response shape stays compatible).
9. **Bundled variant** (`pack.mjs --bundled`, 179 MB zip) stages model in a throwaway dist
   copy — lean dist/ stays unpolluted; verified by zip path-matching test.
10. **tokens.css design system** over per-page CSS rewrites (reviewer proposals rejected
    in favor of token-driven single source).
11. **Accuracy gate in CI** (`run-pipeline.mjs` exit 1 + bench job) and dataset pinning —
    benchmark results must be reproducible.
12. **Dependabot auto-merge for ORT** is safe ONLY because `build.mjs` fails on
    npm/wasm version drift (checked vendored files) — the coupling assertion makes it safe.
13. **Coverage threshold never lowered** — 90% every metric (was 85%), lint `--max-warnings=0`.
14. **docs auto-sync** via `tools/sync-docs.mjs` `<!-- AUTO:KEY -->` markers + `--check` in CI
    (stale numbers like "81.5% on 103 images" were a real bug class; now machine-prevented).
15. **Spectral 2D-FFT features deliberately dormant** (TD-1): precision 65–80% lab,
    worse after recompression; kept tested, never a standalone verdict.
16. **Multi-crop TTA measured, then reverted** — 50%-crop grid regressed BA 79.58% vs
    84.5% single-view (22 images flipped wrong vs 10 helped of 471). Trusted measurement
    over the paper's generic +1.5–2.5% claim; kept as opt-in (`enableCropGrid`).
17. **Final Platt refit accepted for calibration quality** — recalibration (a=0.5120/b=3.0046)
    improved ECE (0.244 → 0.059/0.047 final) and held-out test BA (80.7 → 82.8); headline
    numbers recorded under ONE shipped calibration; the uncalibrated-vs-calibrated gap
    (81.5 → 84.2 raw) is documented in README as the calibration's contribution.
18. **v2 candidates ruled bounty-compliant** (compliance side chats): DINOv2+PatchHead
    (+4–7% BA, highest effort — PatchHead code unreleased), FAIR regularizer (+8% zero-shot,
    zero runtime cost), augmentation-heavy retraining (+3–6%, most tractable) — all legal
    (weights trained/exported offline → one-time download/bundle), each requiring own
    reproducible training + pinned SHA-256. NPR/LFM and DCT streams: rejected (GAN-era
    gains ~0 on Flux/SD3/Imagen; NPR unlicensed). llm-as-a-verifier.com: **rejected** —
    text-trajectory reward modeling, not image forensics.

## Rules / gotchas (for future work)

- **MV3 invariants:** no SharedArrayBuffer (single-thread ORT); content scripts classic
  only; SW orchestration-only; offscreen doc = only inference context; CSP
  `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'` (`'unsafe-eval'` is banned);
  bounds-checked parsers return partial results, never throw.
- **Pre-push checklist:** prettier → lint (0 warnings) → build (ORT coupling assert) →
  `npm run cover` (≥90 all) → docs:check → `npm run test:e2e` (6/6, uses spawn+CDP
  harness — `puppeteer.launch` + `--load-extension` is BROKEN on Chrome 139+ CfT).
  Clean-clone reproducibility was proven twice (`C:\tmp\clean-build`, `C:\tmp\clean-final`).
- Don't run heavy benchmarks concurrently with e2e (RAM 15.8 GB total; CPU saturation
  makes SW-start e2e flaky — kill orphan chrome/node first).
- `gh api` base64 JSON arrives line-wrapped — fetch raw.githubusercontent.com instead.
- Don't regex-edit workflow YAML in PowerShell (corrupted ci.yml once — rewritten from scratch).
- `npx` spawn needs `shell: true` on Windows; shields.io badges double-encode `%` → %25.
- fft.js does not FFT-shift (map index→signed frequency; include Nyquist ring).
- Bare JPEG (SOI+EOI) → `hasCameraExif: null` (indeterminate) — correct, not a bug.
- No innerHTML/eval anywhere; metadata → textContent/.title only; `credentials:'omit'`
  fetch (cookie-authed images may fail — privacy choice).
- IDB test stub must share one data map across `open()` calls; request `onsuccess` fires
  before transaction `oncomplete`.
- Literal NUL in regex trips `no-control-regex` — rewrite via charCodeAt loop.

## Open items & deferred work

- **Manual (owner):** submit poidh.xyz #323 claim.
- v2 backlog: REQ-30 Firefox port, REQ-31 video-frame sampling, REQ-32 local
  wrong-verdict feedback loop; SOTA research suggested DINOv2+PatchHead (+4–7% BA),
  FAIR (+8% zero-shot), aug-retraining (+3–6%) — all v2-scale; verdict was submit current
  build (top of the ~76–86% 2026 ceiling), retrain only if the bounty eval falls short.
- Small gaps: no e2e coverage of bundled/zero-download path (unit-covered only);
  `tools/publish_models.mjs` should update `models/manifest.json` directly;
  ~264 benchmark generator labels unrecovered; residual small branch-coverage gaps
  (96.4→96.9% lines chase after the 90% gate was met).
- TD-1 spectral fusion: revisit if a future model/dataset benefits.

## Imported sessions

The five source chats are imported into Hermes as searchable sessions (full fidelity:
user prompts, assistant prose, reasoning, tool calls + outputs; side chats sliced at
their fork anchor like the VS Code UI does — the parent holds the full history once):

| Hermes session                    | VS Code title                                  | Content                                     |
| --------------------------------- | ---------------------------------------------- | ------------------------------------------- |
| `vsc-ai-detect-parent`            | AI image detector Chrome extension development | 47 user / 1,375 assistant / 1,745 tool rows |
| `vsc-ai-detect-calibration-rerun` | Re-run necessity for calibration consistency   | own fork turns (1/13/12)                    |
| `vsc-ai-detect-bounty-check`      | bounty rules compliance check                  | own fork turns (1/2/1)                      |
| `vsc-ai-detect-quality-review`    | comprehensive project quality review           | 57 user / 1 assistant / 654 tool rows       |
| `vsc-ai-detect-bounty-v2`         | Bounty rule compliance for v2 candidates       | own fork turns (2/2/0)                      |

Searchable via `session_search` (e.g. "calibration balanced accuracy threshold"). Source
records: `~/.copilot/session-state/<sdkId>/events.jsonl` — see the Hermes skill
`vscode-copilot-chat-restore` for recovery forensics.
