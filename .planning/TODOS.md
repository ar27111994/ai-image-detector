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
      crash recovery, and unit tests for all previously-untested modules (427 tests / 34 files).
