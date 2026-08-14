# AI Image Detector — Local & Private

A Chrome extension (Manifest V3) that detects AI-generated images on any webpage with **100%
in-browser inference**. No cloud. No uploads. No tracking. Every image is analyzed entirely on
your device.

Built for the [poidh.xyz bounty #323](https://poidh.xyz/arbitrum/bounty/323).

## Why

Most "AI-powered" browser tools upload images to a remote server. This extension proves accurate
AI-image detection can run fully client-side using WebGPU/WebAssembly — your images never leave
your machine.

## Features

- 🔍 **Automatic detection** — images on any page are analyzed as you browse (including
  lazy-loaded and dynamically inserted images).
- 🏷️ **Confidence badges** — every analyzed image gets a color-coded score (red = AI, green =
  real, amber = uncertain).
- 🔒 **Private by design** — after a one-time model download at setup, the extension works
  entirely offline and makes no network requests for inference.
- ⚡ **Local inference** — ONNX Runtime Web with WebGPU acceleration and a WASM fallback.
- 🧠 **Hybrid detection** — a neural model plus forensic metadata signals (C2PA provenance,
  generator EXIF/XMP/PNG signatures) and frequency-domain analysis, fused into one calibrated
  confidence score.

## Install

### From source (recommended)

Requirements: **Node.js ≥ 20** and **Chrome ≥ 116** (or Chrome for Testing).

```bash
git clone https://github.com/ar27111994/ai-image-detector.git
cd ai-image-detector
npm ci
npm run build
```

Then load the extension:

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select the `dist/` folder
4. The setup page opens automatically and downloads the detection model (one time)

> **Note:** Branded Chrome ≥137 removed `--load-extension` for _automated_ loading; manual
> "Load unpacked" via `chrome://extensions` is unaffected and is the intended install path.

### From a release zip

Download the latest `ai-image-detector-*.zip` from
[Releases](https://github.com/ar27111994/ai-image-detector/releases), unzip, and load it as
above (choose the unzipped folder).

## Usage

1. Complete the one-time model setup (first run only).
2. Browse normally. Images on each page are analyzed in the background and badged with a
   confidence score.
3. Click the toolbar icon for status, to adjust the AI-confidence threshold, or to disable
   detection on the current site.
4. Full settings are under **Extension → Options** (badge position, minimum image size, per-site
   rules, model reset).

## How it works

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). In short:

- A **service worker** orchestrates and fetches cross-origin image bytes (never sending them
  anywhere).
- An **offscreen document** runs ONNX Runtime Web (WebGPU → WASM fallback) on a SwinV2 detector
  downloaded once and verified by SHA-256.
- A **content script** discovers images and renders badges.
- Detection = neural score + forensic metadata + spectral features, fused into a calibrated
  probability (threshold 0.65 by default).

## Accuracy

Internal public benchmark (471 images: OpenFake modern generators + COCO/OpenFakeTiny reals, with
JPEG-recompress/resize augmentations), threshold 0.65:

- **Balanced accuracy: 84.5%** (TPR 82.0%, TNR 87.1%) on the raw split with the full calibrated
  pipeline; **80.6%** on the web-augmented split (uncalibrated). See
  [docs/BENCHMARK.md](docs/BENCHMARK.md) for the full methodology, per-generator breakdown, and
  reproduction steps.

## Development

```bash
npm run dev        # watch-mode build
npm test           # unit tests
npm run cover      # coverage (v8)
npm run test:e2e   # end-to-end in headless Chrome-for-Testing
npm run lint       # eslint
node bench/run-pipeline.mjs --model haywoodsloan-int8   # accuracy benchmark
```

Docs: [Architecture](docs/ARCHITECTURE.md) · [Model provenance](docs/MODEL.md) ·
[Benchmark](docs/BENCHMARK.md) · [Testing](docs/TESTING.md) · [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE). The bundled detection model is Apache-2.0 (see [docs/MODEL.md](docs/MODEL.md)).
