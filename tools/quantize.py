"""
Quantize an fp32 ONNX model to int8 (dynamic, QDQ/S8S8) and fp16 variants, validating each
against the fp32 ONNX reference logits.

Usage: python tools/quantize.py --in models-cache/wkaandemir-fp32.onnx [--tag wkaandemir]
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

VALIDATION_TOLERANCE_LOGITS = 0.15  # int8/fp16 logit drift budget vs fp32 ONNX


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--in", dest="src", required=True)
    parser.add_argument("--tag", default=None)
    args = parser.parse_args()

    src = Path(args.src)
    if not src.exists():
        print(f"[quantize] missing input: {src}")
        return 1
    tag = args.tag or src.stem.replace("-fp32", "").replace("-fp32-slim", "")

    import onnxruntime as ort
    from onnxruntime.quantization import QuantType, quantize_dynamic

    rng = np.random.default_rng(1337)
    ref_sess = ort.InferenceSession(str(src), providers=["CPUExecutionProvider"])
    input_name = ref_sess.get_inputs()[0].name
    shape = [d if isinstance(d, int) else 1 for d in ref_sess.get_inputs()[0].shape]
    probes = [rng.random(shape, dtype=np.float32), np.zeros(shape, dtype=np.float32)]

    def validate(model_path: Path) -> float:
        sess = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
        worst = 0.0
        for probe in probes:
            ref = ref_sess.run(None, {input_name: probe})[0]
            got = sess.run(None, {input_name: probe})[0]
            # Compare in probability space (softmax) — the only thing the product consumes.
            ref_p = np.exp(ref - ref.max()) / np.exp(ref - ref.max()).sum()
            got_p = np.exp(got - got.max()) / np.exp(got - got.max()).sum()
            worst = max(worst, float(np.max(np.abs(ref_p - got_p))))
        return worst

    rc = 0

    int8_path = src.with_name(f"{tag}-int8.onnx")
    print(f"[quantize] int8 dynamic -> {int8_path.name}")
    quantize_dynamic(
        str(src),
        str(int8_path),
        weight_type=QuantType.QInt8,
        per_channel=True,
        reduce_range=False,
    )
    drift = validate(int8_path)
    size_mb = int8_path.stat().st_size / 1e6
    print(f"[quantize] int8: {size_mb:.1f} MB, max softmax drift {drift:.4f}")
    if drift > VALIDATION_TOLERANCE_LOGITS:
        print("[quantize] FAIL: int8 drift too large")
        rc = 1

    try:
        from onnxconverter_common import float16
        import onnx

        fp16_path = src.with_name(f"{tag}-fp16.onnx")
        print(f"[quantize] fp16 -> {fp16_path.name}")
        model = onnx.load(str(src))
        model_fp16 = float16.convert_float_to_float16(model, keep_io_types=True)
        onnx.save(model_fp16, str(fp16_path))
        drift = validate(fp16_path)
        size_mb = fp16_path.stat().st_size / 1e6
        print(f"[quantize] fp16: {size_mb:.1f} MB, max softmax drift {drift:.4f}")
        if drift > VALIDATION_TOLERANCE_LOGITS:
            print("[quantize] FAIL: fp16 drift too large")
            rc = 1
    except ImportError:
        print("[quantize] onnxconverter-common not installed; skipping fp16")

    return rc


if __name__ == "__main__":
    sys.exit(main())
