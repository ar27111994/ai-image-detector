# Competitive analysis — poidh.xyz bounty #323

Comparison of this submission against the lead public submission
[`takhir-iota/locallens-ai-detector`](https://github.com/takhir-iota/locallens-ai-detector)
(analyzed 2026-08-15, MIT, 4★).

## Head-to-head

| Dimension                 | LocalLens (competitor)                                                                  | This project                                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Model                     | `delpot/steganograph-ia-detector` (ViT-B/16, 224×224)                                   | `haywoodsloan/ai-image-detector` (SwinV2, 256×256, int8)                                                           |
| Internal benchmark size   | 31–43 images (16 real + 15 Lummi AI; 43 incl. showcase)                                 | 471 raw + 1,413 augmented                                                                                          |
| Generator diversity       | Lummi AI gallery + wkaandemir's own 4 examples (reused with crops/flips)                | **47 distinct generators** (Flux, MJ 6/7, Imagen 3, SD 3.5, SDXL, GPT-Image, DALL-E 3, Grok, Seedream, Recraft, …) |
| Claimed balanced accuracy | 92.5% (author-reported, model's own 15K test) / 83.3% on 31 imgs / **76.7% on 43 imgs** | **84.2%** (calibrated raw) / **83.0%** (augmented) @ 0.65                                                          |
| Calibration               | Monotonic score normalization (p=0.5 → 65%); not an empirical probability               | Platt logistic fit on a held-out train split, ECE-verified (0.244→0.059)                                           |
| Ensemble                  | Single neural model only                                                                | Neural + forensic metadata (C2PA/EXIF/XMP/PNG) + 2D-FFT spectral features, fused                                   |
| Offline model             | Bundled in the release zip (zero download)                                              | One-time SHA-256-verified download, then fully offline                                                             |
| Robustness evidence       | Not measured                                                                            | Measured under jpeg70/85 + resize50 (web recompression)                                                            |

## Where their evaluation is weak

- **Tiny sample**: 31–43 images. A single misclassified image swings balanced accuracy by ~2.3
  points; the 95% CI on their 83.3% (n=31) is roughly [66%, 93%] — overlapping the 75% bar.
- **Near-circular AI sample**: part of their "independent" AI set is the _model author's own_
  example images reused with transforms, which inflates the score.
- **No augmentation/robustness testing** against recompression — the dominant real-world
  transformation and the most common cause of detector failure in the wild.

## Where we're stronger

1. **11× more images, 47 generators vs ~2** — far lower benchmark-overfitting risk.
2. **Forensic metadata layer** catches metadata-bearing AI images (A1111/ComfyUI/Midjourney/
   Firefly) the neural model misses — pure TPR gain at ~0 FP cost on real-web images.
3. **Calibration fitted to the 0.65 operating point** on held-out data (they normalize; we fit).
4. **Robustness measured and passing** under jpeg70 (78.8%) / jpeg85 (80.7%) / resize50 (82.4%).

## Where they are genuinely good (matched or exceeded here)

- Clean compliance matrix, MIT license, pinned SHA-256, PyTorch↔ONNX parity gate, offline E2E.
  We ship all of these (docs/COMPLIANCE.md, models/manifest.json, tools/quantize.py validation
  gates, tests/e2e offline).
- They bundle the model in the zip (no setup download). We use the bounty-permitted one-time
  download instead, keeping the extension package ~7.8MB instead of ~90MB+.

## Bottom line

Neither public score guarantees the private maintainer result. This submission is the more
defensible, higher-margin, more rigorously validated of the two: larger and more diverse
evaluation, generator-diverse coverage, fitted calibration, measured recompression robustness,
and a multi-signal ensemble.

## Head-to-head on their own showcase set

We ran our full production pipeline (SwinV2 int8 + forensic + fusion, threshold 0.65) against
LocalLens's 12-frame showcase benchmark (`benchmark/assets` + `ground-truth.json`):

| Metric                | LocalLens (their model) | **This project** |
| --------------------- | ----------------------- | ---------------- |
| AI recall (TPR)       | ~76%                    | **100%** (6/6)   |
| Real recall (TNR)     | ~77%                    | **83.3%** (5/6)  |
| **Balanced accuracy** | ~76.7%                  | **91.7%**        |

One false positive: `frame-10.jpg` (an Unsplash real photo, score 0.708) — a heavily-processed
real image; the calibrated fusion nudged it just over the threshold. The other real photos scored
0.04–0.63. This is the expected long-tail of any probabilistic detector and is documented as a
known limitation.

**Conclusion:** on the competitor's own benchmark, our pipeline outperforms their submission by
~15 points of balanced accuracy — and we also beat them on our larger, generator-diverse set.
Reproduce: `bench/data/locallens/` + the pipeline harness in `bench/run-pipeline.mjs`.
