# Research: state-of-the-art AI-image detection & what applies here

Survey of 2024–2026 techniques for cross-generator AI-image detection, evaluated against this
project's constraints (in-browser ONNX Runtime Web, one-time model download, no benchmark
overfitting). Sources: CVPR/ICCV/ECCV/NeurIPS/BMVC/IEEE-TAI/arXiv 2024–2026. Full findings and
citations were gathered from primary sources; this file records the actionable conclusions.

## Where we already are (honest baseline)

- Our pipeline: **84.5% balanced accuracy** (clean) / **80.6%** (web-augmented) @ 0.65 on a
  471-image, 47-generator modern set.
- 2026 reference points: DailyBench shows methods reporting 91–96% on GenImage drop to **60–76%**
  on modern web-realistic generators (FakeBench) and **54–66%** on manipulation/inpainting.
  **Our numbers are within ~4–6 points of practical SOTA on web-realistic data.**

## What's genuinely actionable (ranked by value/cost)

### Do now (no retraining)

1. **Multi-crop TTA at inference** — average logits over the full frame + 2 corner crops.
   Est. **+1.5–2.5% BA** (more under augmentation) for ~3× latency. Cheap; uses the existing
   pipeline. (Patch aggregation already ships; extending it to logit-averaging TTA is the win.)
2. **Temperature scaling for calibration** — replace/verify Platt with temperature scaling fitted
   on a held-out _training_ split (never the eval set) to minimize ECE; threshold at 0.5 of the
   calibrated probability. Est. **+1–3%** at the operating point and _removes_ eval-set tuning
   (the benchmaxxing risk).

### High value, requires a model change (v2 candidate)

3. **DINOv2-ViT-B/14 + PatchHead + LoRA** (replace SwinV2 backbone). PatchHead (arXiv Aug 2026)
   aggregates **spatial patch tokens** instead of the CLS token and is the current best
   cross-generator architecture: **94.6% avg / 89.4% worst-case** on 9 cross-dataset benchmarks,
   +3.0% avg / +6.9% worst-case over prior DINO approaches, ~0% extra FLOPs. DINOv2 is Apache-2.0
   and ONNX/WebGPU-exportable (~344MB). Estimated gain over our SwinV2: **+4–7% BA**. PatchHead
   code was pending release at research time — monitor before adopting.
4. **FAIR (feature-augmented implicit regularization)** — training-time-only technique that adds
   scene-structure features to kill texture-shortcut learning; **+8%** zero-shot cross-generator,
   **zero inference cost**. Applies to any backbone retrain.

### Training-data improvements (if we ever retrain)

5. **Augmentation-heavy training** (JPEG q60–95, resize 0.5–1.5×, WebP, mild blur) — standard in
   all 2024–2026 SOTA pipelines; expected **+3–6% under augmentation** (our clean→aug gap is 3.9
   points).

### Lower value / conditional

6. **NPR or LFM as a second lightweight detector** (ResNet-50, ~100MB int8, MIT/Apache) —
   **+2–4% on GAN-era generators only**; weak on modern flow/diffusion (Flux/SD3/Imagen use
   transformer decoders, not CNN upsampling). Only worth it if GAN false-negatives dominate.
7. **Quality-weighted score aggregation (QuAD)** — when a page shows multiple quality versions of
   the same image, weight by an estimated quality score. **+3–8%** but only for social-media
   multi-resolution cases; conditional, not general.
8. **DCT high-frequency second stream** — **+2–5% on JPEG/GAN images, negligible on modern
   diffusion.** Low cost but low value for the modern-generator-heavy eval.

## What to NOT invest in (evidence)

- **Pure FFT peak detection / high-frequency residual analysis** — works for GAN-era upsampling
  artifacts but largely absent in modern transformer-decoded generators. (Cozzolino et al. 2026:
  the discriminative signal for diffusion is in **low-to-mid frequency** distributions, which
  foundation models capture — not the high-frequency peaks FFT detectors chase.)
- **DIRE / diffusion-reconstruction-error methods** — require running a diffusion model at
  inference; infeasible in-browser.
- **Large ensembles (CLIP-L + DINOv2-L)** — ~2.5GB, not browser-feasible, marginal gains over a
  single good backbone.

## Realistic ceiling

> 90% cross-generator balanced accuracy on **web-realistic post-processed** images is not
> currently achievable. Best 2026 methods reach ~94–96% on clean controlled sets, ~76–86% on
> web-realistic. \*\*Achievable near-term ceiling for this extension with TTA + temperature scaling

- (optional) DINOv2/PatchHead swap: ~92–94% clean, ~88–90% augmented.\*\*

## Anti-benchmaxxing note

The 471-image internal set is a development set; the threshold and model choice were informed by
it. To avoid overfitting the benchmark: fit calibration on a held-out _training_ split, freeze
the operating threshold at 0.5 of calibrated probability, and never re-tune against the
evaluation set.
