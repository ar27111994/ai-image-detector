# Feature Research — v1 scope

## Core user workflow (the bounty demo path)

1. Install extension (load unpacked / from zip) -> onboarding page opens.
2. Onboarding downloads model weights once (progress bar, SHA-256 verified) -> "Ready".
3. User browses any site; images on the page are analyzed automatically in the background.
4. Each analyzed image gets a corner badge: color + confidence % (red >=65% AI, green <35%,
   amber between). Clicking the badge shows the breakdown (model score, metadata hits).
5. Toolbar popup: counts (AI / real / pending / failed), threshold slider, pause per-site toggle.
6. Options page: threshold, min image size, badge style, per-site blocklist, model info,
   re-download/reset.

## Supporting workflows

- Works fully offline after setup (airplane-mode browsing test).
- Handles lazy loading/infinite scroll (MutationObserver + IntersectionObserver).
- Handles data:/blob: URLs (bytes relayed from content script), srcset (pick best candidate),
  CSS background-image, <picture>, SVG-excluded (not raster), cross-origin via SW fetch.
- Graceful degradation: undecodable/failed images get a neutral badge or none (per settings).

## Deliberate v1 omissions

- No video/canvas-stream analysis; no right-click "analyze" menu for v1? -> Include context-menu
  "Analyze image" (cheap, useful; REQ-adjacent but trivial). No history/dashboard page; no account;
  no telemetry; no Firefox port.

## Hidden requirements surfaced by the use case

- Badge must survive SPA re-renders: reconcile by element identity + content hash, re-attach after
  DOM churn (observed on React feeds).
- Score calibration to the 0.65 operating point is a product requirement (bounty threshold), not
  just ML hygiene.
- Model download must be resumable and verifiable (fresh-profile evaluation environment).
- Badge overlay must not break page layout (position:fixed/absolute overlay, pointer-events passthrough except badge itself) and must not be removed by page CSS (shadow DOM).
