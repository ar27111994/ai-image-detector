"""
Generic converter for HuggingFace image-classification checkpoints (ViT, SwinV2, SigLIP, ...)
to ONNX with validation against the PyTorch reference.

Usage:
  python tools/convert_hf_classifier.py --model capcheck/ai-human-generated-image-detection --size 224
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parent.parent
CACHE = REPO_ROOT / "models-cache"
VALIDATION_TOLERANCE = 1e-3


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True, help="HF model id")
    parser.add_argument("--size", type=int, required=True, help="input resolution")
    parser.add_argument("--tag", required=True, help="output file tag")
    parser.add_argument("--revision", default="main")
    args = parser.parse_args()

    CACHE.mkdir(exist_ok=True)

    import torch
    from transformers import AutoModelForImageClassification

    print(f"[convert] loading {args.model}…")
    model = AutoModelForImageClassification.from_pretrained(args.model, revision=args.revision)
    model.eval()
    cfg = model.config
    print(f"[convert] architectures={cfg.architectures} id2label={cfg.id2label}")

    out_path = CACHE / f"{args.tag}-fp32.onnx"
    dummy = torch.randn(1, 3, args.size, args.size)
    print(f"[convert] exporting ONNX at {args.size}x{args.size} (opset 17)…")
    torch.onnx.export(
        model,
        dummy,
        str(out_path),
        input_names=["pixel_values"],
        output_names=["logits"],
        opset_version=17,
        dynamic_axes=None,
        do_constant_folding=True,
    )

    try:
        import onnxslim
        import onnx

        slimmed = onnxslim.slim(str(out_path))
        slim_path = out_path.with_name(out_path.stem + "-slim.onnx")
        onnx.save(slimmed, str(slim_path))
        out_path = slim_path
        print("[convert] onnxslim applied")
    except Exception as exc:
        print(f"[convert] onnxslim skipped: {exc}")

    import onnxruntime as ort

    rng = np.random.default_rng(1337)
    probes = [
        rng.random((1, 3, args.size, args.size), dtype=np.float32) * 2 - 1,
        np.zeros((1, 3, args.size, args.size), dtype=np.float32),
    ]
    sess = ort.InferenceSession(str(out_path), providers=["CPUExecutionProvider"])
    worst = 0.0
    with torch.no_grad():
        for i, probe in enumerate(probes):
            ref = model(torch.from_numpy(probe)).logits.numpy()
            got = sess.run(None, {"pixel_values": probe})[0]
            diff = float(np.max(np.abs(ref - got)))
            worst = max(worst, diff)
            print(f"[convert] probe {i}: max|Δlogit| = {diff:.2e}")
            if diff > VALIDATION_TOLERANCE:
                print("[convert] FAIL: validation tolerance exceeded")
                return 1

    size_mb = out_path.stat().st_size / 1e6
    print(f"[convert] OK: {out_path.name} ({size_mb:.1f} MB), worst Δ={worst:.2e}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
