# Phase 1 — Task 2: Benchmark harness (data acquisition + runner)

## Objective

`bench/` harness that (a) downloads a fixed-seed, balanced, labeled image set from public sources
(OpenFakeTiny / diffusiondb rows API / COCO), (b) applies deterministic augmentations for a
web-realistic split, (c) runs any ONNX model via onnxruntime-node using the SHARED preprocessing
module (`src/shared/preprocess.js`), and (d) emits per-image scores JSON + balanced accuracy,
TPR/TNR, confusion matrix at the 0.65 threshold, with 95% Wilson CIs.

## Steps

1. `bench/fetch-dataset.mjs`: HF datasets-server rows API client (offset/length paging, image
   bytes from returned asset URLs) for OpenFakeTiny (real+fake labels, generator field) and
   diffusiondb `2m_first_5k`; COCO val2017 direct URL sampler (fixed seed shuffle).
   Persistent disk cache under `bench/data/` (gitignored); manifest JSONL with
   {id, source, label, generator, path, width, height}.
2. `bench/augment.mjs`: sharp-based JPEG q70/q85 re-encode + 50% resize variants (augmented copies
   keep the same label; marked `augmented: true`).
3. `src/shared/image-decode.js` + `src/shared/preprocess.js`: pure functions —
   decode->RGB->resize(bilinear)->CHW float32 normalize(mean/std from model config). Node impl
   uses sharp for decode/resize; browser impl uses createImageBitmap+OffscreenCanvas. Shared
   normalization math in one module, per-model config injected.
4. `bench/run.mjs`: loads ONNX model + config (input size, mean/std, label map), iterates manifest,
   scores via onnxruntime-node (int8 model, CPU), concurrency-limited, writes
   `bench/results/<model>-<date>.jsonl`.
5. `bench/metrics.mjs`: balanced accuracy @ threshold, TPR/TNR, per-generator breakdown, Wilson CI,
   threshold sweep (0.3..0.9) printed as table; exit code fails below configurable gate.
6. Unit tests for metrics math + preprocessing tensor shapes/stats (tests/unit).

## Verification

- `node bench/run.mjs --model <path> --limit 40` on a small sample produces scores JSONL and a
  metrics table; unit tests pass.

## Done When

- Harness runs end-to-end on a real model with >=100 images/class and outputs balanced accuracy.
- Dataset fetch is resumable (re-run continues from cache).

## Parallel: no (depends on 01-1 scaffold)

## Estimated Complexity: large
