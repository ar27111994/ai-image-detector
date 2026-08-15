# AI Image Detector — Local & Private

[![CI](https://github.com/ar27111994/ai-image-detector/actions/workflows/ci.yml/badge.svg?branch=gsd%2Fm1-ai-image-detector)](https://github.com/ar27111994/ai-image-detector/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/ar27111994/ai-image-detector?include_prereleases)](https://github.com/ar27111994/ai-image-detector/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Model: Apache-2.0](https://img.shields.io/badge/model%20license-Apache--2.0-green)](docs/MODEL.md)
[![Chrome MV3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![ONNX Runtime Web](https://img.shields.io/badge/inference-ONNX%20Runtime%20Web-005CED)](https://onnxruntime.ai/docs/tutorials/web/)

<!-- AUTO:BA_BADGE -->[![Balanced accuracy: 84.5%](https://img.shields.io/badge/balanced%20accuracy-84.5%25-success)](docs/BENCHMARK.md)<!-- /AUTO:BA_BADGE -->

[![100% offline inference](https://img.shields.io/badge/inference-100%25%20offline-brightgreen)](docs/ARCHITECTURE.md)
[![Hugging Face](https://img.shields.io/badge/%F0%9F%A4%97%20Hugging%20Face-model%20sources-yellow)](https://huggingface.co/haywoodsloan/ai-image-detector-dev-deploy)

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
  lazy-loaded, dynamically inserted, and `blob:`/`data:` images).
- 🏷️ **Confidence badges** — every analyzed image gets an accessible, color-coded score badge
  (red = AI, green = real, amber = uncertain). Click or press Enter/Space for a detail breakdown
  (score, engine, latency, signals).
- 📊 **Popup stats** — per-page counts (analyzed / AI / real / unclear), a live threshold slider,
  and a per-site toggle.
- 🎨 **Shared design system** — one token stylesheet (colors, type, spacing, motion, dark theme)
  drives every surface; WCAG AA contrast, visible focus, reduced-motion support.
- 🔒 **Private by design** — after a one-time SHA-256-verified model download at setup, the
  extension works entirely offline and never uploads image data.
- ⚡ **Local inference** — ONNX Runtime Web with WebGPU acceleration and a WASM fallback.
- 🧠 **Hybrid detection** — a neural model plus forensic metadata (C2PA provenance, generator
  EXIF/XMP/PNG signatures) and frequency-domain analysis, fused into one calibrated score.

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

Download from [Releases](https://github.com/ar27111994/ai-image-detector/releases), unzip, and
load it as above (choose the unzipped folder). Two variants are published per release:

- **`ai-image-detector-<v>.zip`** (lean, ~8MB) — downloads the model once at setup.
- **`ai-image-detector-<v>-bundled.zip`** (self-contained) — model embedded, installs with **zero
  download** and works offline immediately.

The raw model (`.onnx`) is also attached to every release, so each release is fully
self-contained. All variants verify the model's SHA-256 against the bundled manifest before use.

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

- **Balanced accuracy: <!-- AUTO:BA_RAW -->84.5%<!-- /AUTO:BA_RAW -->** (TPR 82.0%, TNR 87.1%) on
  the raw split with the full calibrated pipeline; **<!-- AUTO:BA_AUGMENTED -->80.6%<!-- /AUTO:BA_AUGMENTED -->**
  on the web-augmented split (uncalibrated). See [docs/BENCHMARK.md](docs/BENCHMARK.md) for the
  full methodology, per-generator breakdown, and reproduction steps.

## Development

```bash
npm run dev        # watch-mode build
npm test           # unit + integration tests (<!-- AUTO:TEST_COUNT -->215<!-- /AUTO:TEST_COUNT -->)
npm run cover      # coverage (v8, gated)
npm run test:e2e   # end-to-end in headless Chrome-for-Testing (6 cases)
npm run lint       # eslint (blocks CI)
node bench/run-pipeline.mjs --model haywoodsloan-int8   # accuracy benchmark (75% gate)
```

CI runs lint → tests+coverage → security audit → build → e2e on every push/PR; releases build,
test, package, and publish the zip on `v*` tags.

Docs: [Architecture](docs/ARCHITECTURE.md) · [Model provenance](docs/MODEL.md) ·
[Benchmark](docs/BENCHMARK.md) · [Testing](docs/TESTING.md) · [Changelog](CHANGELOG.md)

## Privacy & security

This extension is privacy-first: after a one-time model download (or zero download with the
bundled zip), it runs entirely offline and never sends image data anywhere. See
[PRIVACY.md](PRIVACY.md) for the full policy and [SECURITY.md](SECURITY.md) for the security
model and how to report a vulnerability.

## Contributing

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for setup, the CI gates every PR
must pass, and conventions.

## License

[MIT](LICENSE). The bundled detection model is Apache-2.0 (see [docs/MODEL.md](docs/MODEL.md)).
