"""
Convert wkaandemir/ai-image-detector (CLIP ViT-B/16 + merged LoRA, timm) to ONNX.

The checkpoint is a timm `vit_base_patch16_clip_224.openai` state dict (LoRA already merged),
published as model.safetensors under the MIT license.

Validation gate: max |onnx_logits - torch_logits| on fixed probe inputs must be < 1e-3.

Usage:
  python tools/convert_wkaandemir.py [--revision fefa013737a0c3477961d36ee8dbbdc751352366]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parent.parent
CACHE = REPO_ROOT / "models-cache"
MODEL_ID = "wkaandemir/ai-image-detector"
DEFAULT_REVISION = "fefa013737a0c3477961d36ee8dbbdc751352366"
INPUT_SIZE = 256  # per config.json image_size (timm default 224 is overridden)
NUM_CLASSES = 1  # single-logit sigmoid head: p(real)
TEMPERATURE = 0.594889223575592  # per config.json (calibration_method: temperature_nll)
VALIDATION_TOLERANCE = 1e-3


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--revision", default=DEFAULT_REVISION)
    args = parser.parse_args()

    CACHE.mkdir(exist_ok=True)

    import torch
    import timm
    from huggingface_hub import hf_hub_download

    print(f"[convert] downloading {MODEL_ID}@{args.revision[:8]} weights…")
    weights_path = hf_hub_download(
        repo_id=MODEL_ID,
        filename="model.safetensors",
        revision=args.revision,
    )
    config_path = hf_hub_download(
        repo_id=MODEL_ID, filename="config.json", revision=args.revision
    )
    config = json.loads(Path(config_path).read_text())
    print(f"[convert] config: {config.get('architecture', config)}")

    # timm CLIP ViT-B/16 with the checkpoint's single-logit head at 256x256.
    model = timm.create_model(
        "vit_base_patch16_clip_224.openai",
        pretrained=False,
        num_classes=NUM_CLASSES,
        img_size=INPUT_SIZE,
    )
    from safetensors.torch import load_file

    state = load_file(weights_path)
    # The checkpoint may prefix keys; normalize common prefixes.
    normalized = {}
    for key, value in state.items():
        new_key = key
        for prefix in ("module.", "model.", "visual.", "vit."):
            if new_key.startswith(prefix):
                new_key = new_key[len(prefix):]
        normalized[new_key] = value

    missing, unexpected = model.load_state_dict(normalized, strict=False)
    if missing:
        print(f"[convert] WARNING missing keys: {missing[:10]}{'…' if len(missing) > 10 else ''}")
    if unexpected:
        print(f"[convert] WARNING unexpected keys: {unexpected[:10]}{'…' if len(unexpected) > 10 else ''}")
    model.eval()

    # Wrap with temperature scaling + sigmoid so the ONNX output is directly p(real).
    # (The reference app.py applies these post-inference; baking them in keeps JS simple.)
    class CalibratedModel(torch.nn.Module):
        def __init__(self, inner: torch.nn.Module, temperature: float) -> None:
            super().__init__()
            self.inner = inner
            self.temperature = temperature

        def forward(self, pixel_values: torch.Tensor) -> torch.Tensor:
            logit = self.inner(pixel_values).reshape(-1, 1)
            return torch.sigmoid(logit / self.temperature)

    export_model = CalibratedModel(model, TEMPERATURE)
    export_model.eval()

    out_path = CACHE / "wkaandemir-fp32.onnx"
    dummy = torch.randn(1, 3, INPUT_SIZE, INPUT_SIZE)

    print("[convert] exporting ONNX (opset 17, calibrated p(real) output)…")
    torch.onnx.export(
        export_model,
        dummy,
        str(out_path),
        input_names=["pixel_values"],
        output_names=["p_real"],
        opset_version=17,
        dynamic_axes=None,  # fixed 1x3x256x256 — smallest/fastest graph
        do_constant_folding=True,
    )

    # Slim (constant folding, dead node elimination, shape inference).
    try:
        import onnxslim

        slimmed = onnxslim.slim(str(out_path))
        slimmed_path = CACHE / "wkaandemir-fp32-slim.onnx"
        import onnx

        onnx.save(slimmed, str(slimmed_path))
        out_path = slimmed_path
        print("[convert] onnxslim applied")
    except Exception as exc:  # pragma: no cover - optional optimization
        print(f"[convert] onnxslim skipped: {exc}")

    # Validate: torch vs onnxruntime logits on fixed probes.
    import onnxruntime as ort

    rng = np.random.default_rng(1337)
    probes = [
        rng.random((1, 3, INPUT_SIZE, INPUT_SIZE), dtype=np.float32) * 2 - 1,
        np.zeros((1, 3, INPUT_SIZE, INPUT_SIZE), dtype=np.float32),
        np.ones((1, 3, INPUT_SIZE, INPUT_SIZE), dtype=np.float32) * 0.5,
    ]
    sess = ort.InferenceSession(str(out_path), providers=["CPUExecutionProvider"])

    worst = 0.0
    with torch.no_grad():
        for i, probe in enumerate(probes):
            ref = export_model(torch.from_numpy(probe)).numpy()
            got = sess.run(None, {"pixel_values": probe})[0]
            diff = float(np.max(np.abs(ref - got)))
            worst = max(worst, diff)
            print(f"[convert] probe {i}: max|Δp| = {diff:.2e}")
            if diff > VALIDATION_TOLERANCE:
                print(f"[convert] FAIL: validation tolerance {VALIDATION_TOLERANCE} exceeded")
                return 1

    size_mb = out_path.stat().st_size / 1e6
    print(f"[convert] OK: {out_path.name} ({size_mb:.1f} MB), worst Δ={worst:.2e}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
