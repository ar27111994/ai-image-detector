# tools/ — model conversion & release pipeline

These scripts convert candidate HuggingFace checkpoints to ONNX, quantize them, validate the
outputs against the PyTorch reference, and publish the artifacts as GitHub Release assets with a
pinned `models/manifest.json` (URL + SHA-256). **They are NOT part of the extension build** —
the extension downloads the published weights at first-run setup, which the bounty rules
explicitly allow. Maintainers building from source never need Python.

## Reproduce (one-time, ~30 min)

```bash
python -m venv .venv
.venv/Scripts/pip install -r tools/requirements-convert.txt    # Windows
# pip install torch --index-url https://download.pytorch.org/whl/cpu  (if the +cpu pin fails)

python tools/convert_wkaandemir.py        # CLIP ViT-B/16 LoRA -> fp32 ONNX (+validation)
python tools/convert_ateeqq.py            # SigLIP2-512 -> fp32 ONNX (+validation)
python tools/quantize.py --in models-cache/wkaandemir-fp32.onnx
python tools/publish_models.mjs           # gh release upload + models/manifest.json emission
```

All artifacts land in `models-cache/` (gitignored). The committed, pinned result is
`models/manifest.json` in the repo root.
