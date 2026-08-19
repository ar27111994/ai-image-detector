# Copilot instructions — AI Image Detector

Chrome MV3 extension that detects AI-generated images with 100% in-browser inference
(ONNX Runtime Web: WebGPU → WASM). No cloud, no servers, no tracking.

## Architecture (read `docs/ARCHITECTURE.md` first)

- `src/background/` — MV3 service worker (orchestration only; never holds the ONNX session).
- `src/offscreen/` — offscreen document that owns the ONNX `InferenceSession`.
- `src/content/` — content script: image discovery + Shadow-DOM badges.
- `src/shared/` — pure, platform-independent logic (protocol, preprocess, fusion, metadata,
  model-store, settings). **All scoring/forensic math lives here so the Node bench harness
  (`bench/`) exercises the exact shipped code path.**
- `extension/` — manifest, pages (popup/options/onboarding), tokens.css design system.

## Non-negotiable invariants

- **No runtime network calls for inference.** After a one-time SHA-256-verified model download
  the extension is fully offline. Do not add CDN/telemetry/analytics.
- **Content script is bundled as IIFE** (esbuild `format: 'iife'`); everything else is ESM.
- **`onnxruntime-web` and `onnxruntime-node` must stay on the same version** — `build.mjs`
  asserts this; a mismatched Dependabot bump fails the build.
- Never trust page/JS-supplied data: sanitize settings, bounds-check all metadata parsers,
  and HTML-escape any string rendered into the DOM.

## Commands

```bash
npm run dev        # watch build
npm test           # unit + integration (vitest)
npm run cover      # coverage, 90% gate on src/shared + model-manager
npm run test:e2e   # Puppeteer e2e in headless Chrome-for-Testing
npm run lint       # eslint (CI blocks on error)
npm run build      # production build -> dist/
npm run docs:check # fails if AUTO: doc markers are stale (run `npm run docs:sync`)
```

## Conventions

- Vanilla ES2022, no framework. Conventional Commits (`feat:`, `fix:`, `test:`, `docs:`,
  `refactor:`, `chore:`). Husky pre-commit runs lint-staged + docs:check; pre-push runs the
  full test + e2e suite.
- Docs with `<!-- AUTO:KEY -->` markers are machine-synced by `tools/sync-docs.mjs` — never
  hand-edit the value between the markers.
- Accuracy numbers in docs come from `bench/results/*.jsonl` and are recomputed, never typed.
