# Phase 1 — Task 1: Repository scaffold & toolchain

## Objective

Create the complete project scaffold: package.json (pinned deps), esbuild build script producing
`dist/` (MV3 extension layout), Vitest config with coverage, ESLint flat config + Prettier,
directory layout (`src/`, `extension/`, `bench/`, `tools/`, `tests/`), GitHub Actions CI, and a
loadable MV3 manifest skeleton with the CSP required for WASM.

## Steps

1. `package.json` with pinned devDeps: esbuild, vitest, @vitest/coverage-v8, eslint, prettier,
   puppeteer, onnxruntime-node, onnxruntime-web, exifr, fft.js; scripts: build/dev/test/cover/
   lint/bench/pack.
2. `esbuild.config.mjs`: bundles background SW, offscreen, content, popup, options, onboarding;
   copies static assets (`extension/manifest.json`, icons, vendored ORT .wasm/.mjs) to `dist/`;
   `--watch` dev mode; production minify + sourcemap flags.
3. `extension/manifest.json`: MV3, CSP `script-src 'self' 'wasm-unsafe-eval'`, permissions
   (storage, offscreen, unlimitedStorage), host_permissions `<all_urls>`, web_accessible_resources
   for model/wasm assets, action/popup, options, background service_worker.
4. Placeholder entry files so the build passes end-to-end.
5. ESLint flat config (recommended + no-console rules), Prettier config, editorconfig.
6. `.github/workflows/ci.yml`: npm ci -> lint -> unit tests -> build -> (e2e job scaffold).
7. Vitest config with v8 coverage thresholds (90% lines on src shared modules).

## Verification

- `npm ci && npm run build` produces `dist/` with manifest + all bundles; `npm test` runs
  (placeholder test passes); `npm run lint` clean.

## Done When

- Clean checkout build passes locally; manifest validates (`chrome --load-extension` smoke later);
  CI file committed.

## Parallel: no

## Estimated Complexity: medium
