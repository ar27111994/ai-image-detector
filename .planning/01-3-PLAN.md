# Phase 1 — Task 3: Model conversion pipeline (candidates B & C)

## Objective

Reproducible Python tooling (`tools/`) that converts `wkaandemir/ai-image-detector` (safetensors,
timm CLIP ViT-B/16) and `Ateeqq/ai-vs-human-image-detector` (SigLIP2) to ONNX, quantizes
(int8 dynamic QDQ + fp16), validates outputs against PyTorch reference logits (max-abs-diff gate),
and publishes artifacts as GitHub Release assets with a generated `models/manifest.json`
(URL pinned to tag, SHA-256, input spec, label map, license, provenance).

## Steps

1. `tools/requirements-convert.txt` (pinned: torch, timm, onnx, onnxruntime, safetensors,
   huggingface_hub, transformers) + `tools/README.md` (one-command repro).
2. `tools/convert_wkaandemir.py`: load via timm (`vit_base_patch16_clip_224.openai`, merged LoRA
   state dict), export opset 17, dynamic batch off (fixed 1x3x224x224), simplify (onnxsim),
   verify vs PyTorch (max|Δlogit| < 1e-3 fp32).
3. `tools/convert_ateeqq.py`: HF SiglipForImageClassification export via torch.onnx at 512x512
   (fallback 384), same validation gate.
4. `tools/quantize.py`: int8 dynamic (QDQ, S8S8, per-channel) + fp16 variants; re-validate each
   variant vs fp32 ONNX logits (tolerance documented).
5. `tools/publish_models.py` (or .mjs via gh): create release `models-v1`, upload assets, emit
   `models/manifest.json` with sha256 + URLs + input/normalization/labels.
6. Cache all downloads under `models-cache/` (gitignored).

## Verification

- Scripts run clean on this machine; produced ONNX files load in onnxruntime-node and produce
  sane scores on 4 fixture images (2 real COCO + 2 AI from the model repos' own examples).

## Done When

- Both candidates have fp32+int8+fp16 ONNX artifacts; manifest.json committed; release assets
  uploaded and URL+hash verified by re-download.

## Parallel: no (01-2 runner consumes outputs; but conversion can start while 01-2 is built)

## Estimated Complexity: large
