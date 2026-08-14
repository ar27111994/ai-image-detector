# Phase 6 — CONTEXT: Docs + release

## Vision

Ship a bounty-compliant, reproducible submission: complete docs, pinned model manifest, release
packaging, and a rule-compliance audit. Everything a maintainer needs to build, install, and
verify without ambiguity.

## Deliverables

1. **README.md** — value prop, screenshots, quickstart (build + load unpacked), the one-time
   model download flow, offline guarantee, settings reference, FAQ.
2. **docs/ARCHITECTURE.md** — the SW/offscreen/content-split design, EP selection, model
   delivery, security/privacy posture, performance budget.
3. **docs/MODEL.md** — model provenance (source repo, license Apache-2.0, architecture SwinV2,
   conversion steps, quantization, validation gates, SHA-256 manifest).
4. **docs/BENCHMARK.md** — DONE; finalize with augmented-split numbers + forensic coverage.
5. **docs/TESTING.md** — how to run unit/integration/e2e; coverage expectations.
6. **docs/COMPLIANCE.md** — bounty rule-by-rule evidence map.
7. **tools/pack.mjs** — produce dist/ and a versioned zip for distribution.
8. **models/manifest.json** — pinned URLs + SHA-256 (published via tools/publish_models.mjs).
9. **CHANGELOG.md** — finalized for v1.0.0.

## Verification

- Clean-clone `npm ci && npm run build` produces a loadable extension (verified on a fresh dir).
- COMPLIANCE.md reviewed against every bounty rule; no gaps.
