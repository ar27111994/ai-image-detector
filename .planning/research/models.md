# Model Research — AI-vs-Real Image Classifiers (verified 2026-08-13)

## Verified candidates (HF API checked)

### A. onnx-community/deepfake_vs_real_image_detection-ONNX [benchmark priority 1]

- ViT-B/16-224, 85.8M params, Apache-2.0 (backed by prithivMLmods/Deep-Fake-Detector-v2-Model)
- Files: onnx/model.onnx (fp32), model_fp16.onnx, model_int8.onnx (~86MB), + others;
  config.json + preprocessor_config.json present. sha 27f622aab35163c439f6b93722e6bba0711fd6ad
- Zero conversion work. Cross-generator generalization unknown => must measure.

### B. wkaandemir/ai-image-detector [benchmark priority 1]

- CLIP ViT-B/16 + LoRA(16) merged via timm, 85.8M params, **MIT**
- Trained ~20K balanced images from MODERN generators: SD, MJ, Flux, DALL-E, GPT-Image
- Claimed acc 0.959 / ROC-AUC 0.994; ships model.safetensors + metrics.json + example images
- Needs ONNX conversion (timm vit_base_patch16_clip_224.openai). sha fefa013737a0c3477961d36ee8dbbdc751352366

### C. Ateeqq/ai-vs-human-image-detector [benchmark priority 2]

- SigLIP2-base-patch16-512, 92.9M params, Apache-2.0; 120K train images
- Claimed 99.2% test acc (overfitting suspected); 512x512 input heavy for browser
- Needs ONNX conversion (optimum or torch.onnx).

### D. NPR (CVPR 2024, chuangchuangtan/NPR-DeepfakeDetection) [evaluation-only]

- ResNet-50 (~100MB fp32 / ~25MB int8); GenImage 16-generator avg acc 91.7% (MJ 92.6, SD1.4/1.5
  ~97.4, DALL-E2 99.6) — best published cross-generator numbers
- **NO LICENSE declared** => excluded from shipping; may serve as an accuracy reference only.

### E. Bombek1/ai-image-detector-siglip-dinov2 [rejected: size]

- SigLIP2-SO400M + DINOv2-L + LoRA, ~2GB; trained on OpenFake (25+ generators incl. Flux/MJ6/
  DALL-E3/Imagen/GPT-Image-1), cross-dataset avg 97.15% — best numbers, but undeployable in browser.

### Rejected: umm-maybe/AI-image-detector (CC-BY-ND, 2022, obsolete), dima806 (CIFAKE, concept

drift), Organika/sdxl-detector (CC-BY-NC + SDXL-only), haywoodsloan (no license, 780MB),
prithivMLmods "QualityAssess" ONNX variants (face-quality labels, not real-vs-AI),
UniversalFakeDetect (CLIP ViT-L 1.2GB, 78.4% GenImage avg), AIDE (research-only license),
FatFormer (no public weights), DIRE (needs diffusion step at inference).

## Datasets for the internal benchmark (all public)

- **ComplexDataLab/OpenFake** (CC-BY-NC-4.0; benchmark-only use): ~6M? images; modern generators
  (Flux, SD3.5, SDXL, MJ, DALL-E3, Imagen, GPT-Image, Firefly...); real photos included.
  Known issue: prompt misalignment for 5 generators (irrelevant — we only need pixels+label).
- **ComplexDataLab/OpenFakeTiny**: 1K-10K subset, parquet — primary internal benchmark source.
- **poloclub/diffusiondb** (2m_first_5k config): SD 1.x outputs via datasets-server rows API.
- **COCO val2017** (detection-datasets/coco rows API or direct URLs): real photos.
- Augmentations: JPEG q70/q85 re-encode, downscale 50%, to mimic web-realistic degradation.

## Selection method

Phase 1 benchmarks every candidate on the same assembled set with identical preprocessing;
pick best balanced accuracy @ 0.65; consider 2-model ensemble (diversity: CLIP vs plain ViT vs
SigLIP) if it beats the best single model by >=1.5 points. Then fit fusion calibration on a train
split and freeze.
