# Model provenance & reproduction

## Production model

| Property                 | Value                                                                               |
| ------------------------ | ----------------------------------------------------------------------------------- |
| Source                   | `haywoodsloan/ai-image-detector-dev-deploy` (Hugging Face)                          |
| Code repo (license)      | `github.com/haywoodsloan/ai-image-detector` — **Apache-2.0**                        |
| Architecture             | SwinV2 (`Swinv2ForImageClassification`), 195M params                                |
| Training                 | AutoTrain; AI-vs-real image classification (continuously updated)                   |
| Input                    | 256×256 RGB, ImageNet normalization (mean 0.485/0.456/0.406, std 0.229/0.224/0.225) |
| Labels                   | `id2label {0: artificial, 1: real}`                                                 |
| Internal benchmark (raw) | **81.2% balanced accuracy** (TPR 63.0 / TNR 99.4) @ 0.65 (uncalibrated)             |
| Shipped variant          | int8 (Conv excluded) — 311MB — **84.2% BA** after shipped calibration + fusion      |

## Why this model

We benchmarked five candidates on a public, modern-generator set (Flux, Midjourney 6/7,
Imagen 3, SD 3.5, SDXL, GPT-Image, DALL-E 3, Grok, Seedream + laion/pexels/imagenet/COCO reals)
— see docs/BENCHMARK.md for the full table. haywoodsloan is the only candidate above the 75%
bounty bar (81.2%), driven by very high precision (99.4% TNR). Alternatives:

- `wkaandemir/ai-image-detector` (MIT, CLIP-LoRA): 61.8% BA — high recall (94.6%) but low
  precision (29.0% TNR); too many false positives on real photos.
- `Ateeqq/ai-vs-human-image-detector` (Apache-2.0, SigLIP): 71.7% BA.
- `onnx-community/deepfake_vs_real...` (Apache-2.0, ViT): 50.0% BA — 2023-era, fails modern gens.
- Ensembles (mean/max/OR) did not beat haywoodsloan alone.

## Reproduction (conversion + quantization)

Requires Python (one-time; NOT needed to build the extension):

```bash
python -m venv .venv
.venv/Scripts/pip install -r tools/requirements-convert.txt   # pinned, CPU-only torch
python tools/convert_hf_classifier.py --model haywoodsloan/ai-image-detector-dev-deploy --size 256 --tag haywoodsloan
python tools/quantize.py --in models-cache/haywoodsloan-fp32-slim.onnx --tag haywoodsloan
```

Each step validates against the PyTorch reference (max |Δlogit| < 1e-3 fp32; softmax drift
budget for quantized variants).

## Publishing / updating the model

`tools/publish_models.mjs` uploads weight artifacts to a GitHub Release and **merges the pinned
URL + SHA-256 + size into `models/manifest.json`** automatically (no manual hash copying):

```bash
node tools/publish_models.mjs --tag models-v1 --asset primary-int8=models-cache/haywoodsloan-int8.onnx
```

To change or add a model: convert + quantize it, add/update its entry in `models/manifest.json`
(key, inputSize, mean/std, outputType, aiLogitIndex, labels, license), run publish, commit the
updated manifest. The extension reads only the bundled manifest, and the mandatory SHA-256 check
guarantees the downloaded/bundled bytes match the committed pin.

## Distribution (release workflow)

Every `v*` tag builds, tests, and publishes three artifacts (`.github/workflows/release.yml`):

- `ai-image-detector-<v>.zip` — lean; model downloads once at first-run setup.
- `ai-image-detector-<v>-bundled.zip` — self-contained; the pinned model is embedded and the
  extension loads it with zero download (`model-manager.loadBundledVariant`).
- `<model-key>.onnx` — the raw weight file for that release.

All three verify the model's SHA-256 against `models/manifest.json` before use.

## What we did NOT ship and why

- **fp16 SwinV2** — ORT CPU EP fails SwinV2's `Loop`/`SequenceInsert` type inference after fp16
  conversion (fp16 is still generated for WebGPU, but int8 is the validated shipping variant).
- **int8 CLIP/ViT (wkaandemir, dima806)** — int8 dynamic quantization corrupts these models
  (activation overflow); only SwinV2 quantized cleanly.
