# Todos

## Active

- None. Milestone 1 (v1.0.0) and the post-release audit/hardening pass are complete.

## Upcoming (owner / v2 candidates — not blocking)

- [ ] Manual: submit the claim on poidh.xyz bounty #323 linking the repo.
- [ ] v2 (deferred scope, see REQUIREMENTS.md): REQ-30 Firefox port, REQ-31 video frame sampling,
      REQ-32 local "wrong verdict" feedback loop.
- [ ] Revisit dormant spectral fusion (TD-1) if a future model/dataset benefits.

## Completed

- [x] Phase 1–6 (scaffold → inference engine → detection UX → forensics/fusion → testing gate →
      docs/release). All 23 v1 requirements (REQ-01…REQ-23) implemented and verified.
- [x] Post-release audit + hardening (2026-08-16): 32 findings fixed — accuracy docs corrected to
      the shipped numbers (84.2% raw / 83.0% augmented), NOTICE added (REQ-21), CodeQL + release
      gates + checksums, WCAG/accessibility fixes, design-token expansion, DRY refactors, offscreen
      crash recovery, and unit tests for all previously-untested modules (460 tests / 35 files).
- [x] PR #1 review fixes (2026-08-17): concurrent-download dedup (abandonable + supersession-safe
      via generation token) + WebGPU session-leak release; CodeQL hygiene (PNG iTXt dead store,
      pack.mjs TOCTOU); conversion-toolchain pins bumped (onnx 1.21.0, pillow 12.3.0,
      transformers 5.5.0).
- [x] PR #1 review round 2 (2026-08-18): threshold threaded to verdicts (+ cache-key), options
      MODEL_RESET protocol fix, C2PA UUID-validation (anti-forgery), full-buffer image hash,
      bounded getAllKeys, dependabot auto-merge via GraphQL, and doc accuracy (spectral dormant,
      privacy image-fetch, single int8 variant). CodeQL model-loader alert dismissed as FP.
- [x] PR #1 review round 3 (2026-08-18): post-write supersession gate, streamed image-fetch cap,
      raw-byte pre-copy size check, model size-budget cancel + final-size check, build fails without
      the manifest, and added tools/verify-manifest.mjs (`npm run models:manifest`).
- [x] PR #1 review round 4 (2026-08-18): model-state writes are now a generation-aware
      compare-and-set (`setModelStateIfCurrent`), so a superseded download's late `ready` commit
      can't overwrite a reset/replacement even when the generation advances during the final state
      read. Removed the unused `setModelState`.
- [x] PR #1 review round 5 (2026-08-18): resetModel now clears the in-flight download dedup handle
      (post-reset start runs a fresh ensureModel, no SUPERSEDED reuse); manifest validator enforces
      outputType/aiLogitIndex semantics.
- [x] PR #1 review round 6 (2026-08-18): model-state mutations serialized through one write queue
      (enqueueModelWrite) so reset can't interleave with a superseded download's commit; stale blob
      writes deleted on supersession; superseded download's settle no longer clobbers a replacement's
      dedup handle (identity check); convert_ateeqq.py defaults to the configured image size with
      interpolate_pos_encoding on export + validation.
- [x] PR #1 review round 7 (2026-08-18): reset is authoritative over a concurrent download start —
      `resetModel` advances the generation before clearing the dedup handle, `ensureModel` re-checks
      supersession after its awaited readiness read, and an in-flight reset is a barrier new starts
      await. CodeQL missing-await on the identity-guard dismissed as FP.
- [x] PR #1 review round 8 (2026-08-18): forensic false-positive hardening — EXIF generator-name
      matching restricted to Software/CreatorTool (an Artist named "Leonardo" is no longer a hit),
      and XMP trainedAlgorithmicMedia requires the IPTC DigitalSourceType property (attribute /
      rdf:li container / controlled-vocabulary URI), not a bare term anywhere in the XML.
- [x] PR #1 review round 9 (2026-08-18): scoped the controlled-vocabulary URI to a DigitalSourceType
      property (a bare URI in dc:description no longer forces a verdict); convert_ateeqq.py reads
      image size from config.vision_config.image_size (SigLIP vision sub-config) with tuple/list
      normalization.
