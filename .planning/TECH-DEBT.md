# Tech Debt

Tracked known limitations and deferred work. Items here are conscious, measured tradeoffs — not
bugs. Each notes why it's deferred and the trigger to revisit.

## Open

- **TD-1 — Spectral (2D-FFT) features not fused (REQ-14 latent).**
  `src/shared/metadata/spectral.js` is implemented + unit-tested but not wired into
  `fusion/fuse.js`. Under the shipped int8 model + Platt calibration, neural + forensic fusion
  already clears the 75%/80% gates and the spectral term did not raise measured BA on the
  internal benchmark. **Revisit when:** a future model has lower standalone accuracy, or a
  calibration refit shows spectral features add signal. Until then it is a tested, dormant
  research artifact (see docs/ARCHITECTURE.md "Spectral module — status").

- **TD-2 — Analysis cache/dedup is in-memory (lost on SW restart).**
  The LRU result cache and the concurrent-identical inflight map live in the service worker's
  memory and reset when MV3 kills it. Consequence: after a restart, an already-seen image may be
  re-analyzed once. This is a cache miss, not a correctness issue, and the offscreen document
  keeps the warm session, so the cost is bounded. **Revisit when:** profiling shows restart
  frequency causes meaningful redundant inference; the fix would be a `chrome.storage.session`
  backed cache.

- **TD-3 — E2E uses fixed "observe no crash" waits.** Three e2e cases sleep briefly to let
  asynchronous analysis complete and then assert the absence of page errors (a negative
  condition). They are deterministic on Chrome-for-Testing but not event-driven. **Revisit when:**
  a badge/data-attribute readiness marker is exposed for tests to await instead. **Partially
  resolved:** the badge-mount path is now asserted positively (event-driven `waitFor` on
  `[data-ai-detector-badge]` + an accessible `.badge` button); the remaining fixed waits are the
  negative "no crash over N ms" observations, which are intentional.

## Resolved (this cycle)

- Missing third-party `NOTICE` (REQ-21) → added; shipped in `dist/`.
- Accuracy docs mislabeled the uncalibrated number as calibrated → corrected to the shipped
  84.2% raw / 83.0% augmented (full-set), sourced from the canonical result files.
- `aria-describedby="null"`, dark-only badge panel, sub-AA touch targets → fixed.
- `clamp01` duplication, dead `aiProbability`, scattered timeout/byte magic numbers → centralized.
- `getModelBlob` unbounded IDB call → time-bounded.
- No CodeQL / release tag validation / artifact checksums → added.
- Five UI/content modules had zero unit tests → now covered; the suite grew to 427 tests with
  coverage spanning all of src/ at 98.5% lines / 91.3% branches / 98.0% functions (90% gate).
- Service-worker crash-recovery now resets stale session state; the README accuracy badge renders
  on all markdown renderers; docs:check tolerates sub-0.1 coverage jitter (debounce timing).
