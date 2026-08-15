# Contributing

Thanks for your interest in improving the AI Image Detector. This project is open source under
the [MIT License](LICENSE) — contributions are welcome.

## Ways to contribute

- **Report bugs** — open an issue with reproduction steps, Chrome version, and the extension
  version (from `chrome://extensions`).
- **Improve detection** — propose model candidates or forensic heuristics with evidence
  (see `docs/BENCHMARK.md` for how we measure).
- **Fix issues** — pick an open issue or an item in `.planning/TODOS.md`.
- **Improve UX/accessibility** — we hold the UI to WCAG AA; keep it that way.

## Development setup

Requirements: Node.js ≥ 20, Chrome (or Chrome for Testing) ≥ 116.

```bash
git clone https://github.com/ar27111994/ai-image-detector.git
cd ai-image-detector
npm ci
npm run build        # produces dist/ (load via chrome://extensions -> Load unpacked)
npm run dev          # watch mode
```

## Git hooks (installed automatically via `npm ci` → `husky`)

- **`pre-commit`**: `lint-staged` (Prettier + ESLint --fix on staged files) + `docs:check`
  (fails if auto-synced doc numbers drift).
- **`pre-push`**: full `npm test` + `npm run test:e2e` (catches regressions before they hit CI).

Bypass only when you must (`git commit --no-verify`), and expect CI to catch it anyway.

## Before you open a PR — the gates (all must pass)

```bash
npm run lint           # ESLint (blocks CI)
npm run format:check   # Prettier (blocks CI)
npm test               # unit + integration (Vitest)
npm run cover          # coverage gate on src/shared + model-manager (>=90%; currently ~97%)
npm run test:e2e       # real extension in headless Chrome-for-Testing
npm run build          # production build
```

If your change touches detection logic, also run the accuracy benchmark (must stay ≥ 75%
balanced accuracy; the harness exits non-zero below the bar):

```bash
node bench/run-pipeline.mjs --model haywoodsloan-int8
```

## Auto-synced documentation numbers

Dynamic values in docs (version, test counts, coverage %, benchmark accuracy) are **not edited by
hand**. They're marked with `<!-- AUTO:KEY -->…<!-- /AUTO:KEY -->` placeholders and recomputed
from the source of truth by a tool:

```bash
npm run docs:sync    # recompute + write marked values (test count, coverage, accuracy, version)
npm run docs:check   # exit non-zero if any marked doc is stale (runs in CI)
```

If you add a dynamic number to a doc, wrap it in an `AUTO:` marker and add its computation to
`tools/sync-docs.mjs`. CI fails the `test` job if marked docs drift from the computed values.

## Conventions

- **Code style**: vanilla ES2022 modules, Prettier + ESLint enforced. Follow the existing
  structure: `src/shared/` (pure, unit-tested), `src/background/` (service worker orchestration),
  `src/offscreen/` (inference), `src/content/` (page UX), `src/{popup,options,onboarding}/` (pages).
- **Design system**: UI styling uses tokens from `extension/pages/tokens.css` — no hardcoded
  hex/px values in component stylesheets.
- **Commits**: [Conventional Commits](https://www.conventionalcommits.org/) (e.g.
  `feat(scope): …`, `fix(scope): …`). One logical change per commit.
- **Tests**: every new pure function gets unit tests; every runtime behavior change gets an
  integration or e2e test. Malformed-input and security cases are required for parsers.
- **Privacy**: never add telemetry, analytics, or any network call that carries user data. Model
  weights may only be added via the pinned manifest (`models/manifest.json`) — see
  `docs/MODEL.md`.

## Adding or changing the detection model

See `docs/MODEL.md` ("Publishing / updating the model"). In short: convert + quantize via
`tools/`, publish via `tools/publish_models.mjs` (it re-pins `models/manifest.json`), commit the
updated manifest, and confirm the accuracy gate still passes.

## Code of conduct

Be kind and constructive. We're building privacy-preserving open infrastructure — contributions
should share that spirit.
