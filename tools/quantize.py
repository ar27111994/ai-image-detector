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

# Raw-logit drift tolerance. Measured on the shipped SwinV2 int8: max |Δlogit| ≈ 0.02 on the
# probe set (equivalent to the Δp≈0.0015 softmax drift we validated); the corrupt CLIP-family
# case showed Δp≈0.29 which corresponds to multi-unit logit shifts — far above this bound. The
# gate compares raw logits (not softmax) so a single-output (p_real) model can't report zero
# drift when quantization corrupts it.
VALIDATION_TOLERANCE_LOGITS = 0.5  # max acceptable raw-logit drift vs fp32 ONNX.
# NOTE: int8 dynamic quantization CORRUPTS CLIP-family models (observed Δp≈0.29 on random
# probes — activations overflow int8 range). fp16 preserves them (Δ≈0). For ViT/CLIP/SigLIP
# we therefore ship fp16 (WebGPU) + fp32 (WASM fallback), not int8.


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
            # Compare raw logits — softmax over a SINGLE-output (p_real) model is always 1.0 and
            # would report zero drift even if quantization corrupted every prediction. Logit drift
            # is the honest signal for both multi-class and single-output heads.
            worst = max(worst, float(np.max(np.abs(np.asarray(ref) - np.asarray(got)))))
        return worst

    rc = 0

    int8_path = src.with_name(f"{tag}-int8.onnx")
    print(f"[quantize] int8 dynamic -> {int8_path.name}")
    # Exclude Conv nodes: ORT's CPU/WASM EPs lack ConvInteger kernels, so the patch-embedding
    # conv must stay fp32 (QDQ around it would emit ConvInteger and fail at session creation).
    import onnx

    model = onnx.load(str(src))
    conv_names = [
        n.name for n in model.graph.node if n.op_type in ("Conv", "ConvInteger") and n.name
    ]
    print(f"[quantize] leaving {len(conv_names)} Conv nodes in fp32")
    quantize_dynamic(
        str(src),
        str(int8_path),
        weight_type=QuantType.QInt8,
        per_channel=True,
        reduce_range=False,
        nodes_to_exclude=conv_names,
    )
    drift = validate(int8_path)
    size_mb = int8_path.stat().st_size / 1e6
    print(f"[quantize] int8: {size_mb:.1f} MB, max logit drift {drift:.4f}")
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
        print(f"[quantize] fp16: {size_mb:.1f} MB, max logit drift {drift:.4f}")
        if drift > VALIDATION_TOLERANCE_LOGITS:
            print("[quantize] FAIL: fp16 drift too large")
            rc = 1
    except ImportError:
        print("[quantize] onnxconverter-common not installed; skipping fp16")

    return rc


if __name__ == "__main__":
    sys.exit(main())
