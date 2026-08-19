# Phase 5 — CONTEXT: Testing + accuracy gate

## Vision

Prove the extension works end-to-end in a real browser and that the full pipeline clears the
internal accuracy gate (>= 80% balanced accuracy @ 0.65) on both raw and web-augmented splits.

## Components

1. **Unit tests** (DONE — 75 tests): preprocess, metrics, rng, protocol, lru-cache, containers,
   png/xmp/c2pa detectors, fusion, spectral. Coverage gate enforced in vitest.config.
2. **Integration benchmark** (bench/run-pipeline.mjs): full stack (forensic -> neural -> fusion)
   over the manifest; emits BA + CI + per-generator. Runs in Node with onnxruntime-node — same
   ONNX graph and shared preprocessing as production.
3. **E2E tests** (tests/e2e): spawn+CDP-connect harness (deterministic under Chrome 139). Cases:
   - smoke: SW starts, content script connects, badge appears on a fixture image
   - offline: after model seeding into the profile's IndexedDB, block network and assert
     inference still completes
   - multi-image page + lazy-load (MutationObserver path)
   - settings propagation (threshold change reflects in badge)
   - perf: page with N images completes within a budget
4. **Accuracy gate**: `npm run bench` exit code fails below the bar; CI runs it on the cached
   internal dataset (subset to keep CI time bounded).

## Verification

- `npm test` (unit) green; `npm run test:e2e` green; `node bench/run-pipeline.mjs` BA >= 0.80.

## Out of scope

- Cross-browser (Firefox) e2e — v2.
