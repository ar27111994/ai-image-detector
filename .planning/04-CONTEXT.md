# Phase 4 — CONTEXT: Forensics + fusion ensemble hardening

## Vision

Complete the detection ensemble beyond the raw neural score so the extension is robust to
generator diversity and web post-processing. All layers are local and offline.

## Components (build order)

1. **Forensic metadata layer** (DONE — Phase 2/3): PNG tEXt/iTXt/zTXt geninfo, JPEG EXIF
   UserComment/Software, XMP DigitalSourceType, C2PA JUMBF scan, WebP chunks. Definitive hits
   => score 0.99 (near-zero false positives). Benchmark note: HF-served benchmark images are
   metadata-stripped, so this layer shows 0% on the internal set — its value is on real-web
   images (A1111/ComfyUI/MJ/Discord/Firefly outputs). Measured separately.
2. **Spectral features** (DONE — src/shared/metadata/spectral.js): 2D-FFT radial spectrum +
   high-frequency ratio + peak ratio. Weak learner feeding fusion as a bounded nudge.
3. **Calibration** (DONE — bench/calibrate.mjs): Platt logistic on train split; fitted a=0.5204,
   b=2.9321 lifted test BA 80.69% -> 83.78% on the internal benchmark. Threshold 0.65 honored.
4. **Patch aggregation** (this phase): score the model on the full image + a grid of crops and
   average — improves robustness to downscaling/compression per feedback + literature.
5. **Fusion**: fuseSignals combines neural + spectral nudge + camera-EXIF prior. Serialized
   calibration in src/shared/fusion/calibration.js with provenance.

## Verification

- bench/run-pipeline.mjs (full stack) BA @ 0.65 >= 0.80 internal gate on raw AND augmented splits.
- Unit tests for spectral features, calibration determinism, fusion band edges.

## Out of scope

- Noiseprint/PRNU sensor-noise modeling (compute-heavy, marginal gain vs cost) — recorded as v2.
- Watermark (StegaStamp/SynthID) decoding — no public decoders; recorded as v2 if APIs emerge.
