"""
Convert Ateeqq/ai-vs-human-image-detector (SigLIP2-base-patch16-512) to ONNX.

Apache-2.0. SigLIP classification models export cleanly via torch.onnx. Input is 512x512 by
default; we also try 384 for a lighter graph (SigLIP handles arbitrary multiples of patch=16).

Usage: python tools/convert_ateeqq.py [--size 512|384]
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parent.parent
CACHE = REPO_ROOT / "models-cache"
MODEL_ID = "Ateeqq/ai-vs-human-image-detector"
VALIDATION_TOLERANCE = 1e-3


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--size", type=int, default=384, choices=[224, 384, 512])
    parser.add_argument("--revision", default="main")
    args = parser.parse_args()

    CACHE.mkdir(exist_ok=True)

    import torch
    from transformers import SiglipForImageClassification

    print(f"[convert] loading {MODEL_ID} (transformers)…")
    model = SiglipForImageClassification.from_pretrained(MODEL_ID, revision=args.revision)
    model.eval()

    out_path = CACHE / f"ateeqq-siglip2-{args.size}-fp32.onnx"
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
        slimmed_path = out_path.with_name(out_path.stem + "-slim.onnx")
        onnx.save(slimmed, str(slimmed_path))
        out_path = slimmed_path
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
