# Privacy Policy

**The short version:** this extension analyzes images entirely on your device. After a one-time
model download, it makes no network requests for inference and never uploads your images,
browsing history, or any personal data anywhere.

## What the extension does

- Reads image bytes **locally** to classify them as AI-generated or real.
- Displays a confidence score as an on-page badge.
- Stores your settings and the downloaded model **locally** (chrome.storage.local + IndexedDB).

## What the extension does NOT do

- ❌ No image, image content, URL, or analysis result is sent to any server.
- ❌ No telemetry, analytics, tracking, or fingerprinting.
- ❌ No cloud inference, external API calls, or local backend processes.
- ❌ No cookies, no accounts, no personal data collection.
- ❌ No data is **uploaded** anywhere, and no request is made to any party other than the image's
  own host (see the complete network list below — analyzing a cross-origin image means fetching
  its bytes from the URL your browser already loaded).

## Network activity (complete list)

1. **One-time model download** at first-run setup: the detection model is fetched once from the
   project's GitHub Releases, SHA-256 verified, and stored locally. (The self-contained "bundled"
   release skips even this — it embeds the model.)
2. **Fetching the image being analyzed**: when an image is hosted cross-origin, the extension's
   service worker fetches its bytes directly from the image's own URL (the same URL your browser
   already loaded). This is required to analyze the pixels locally and is never a data upload.

There is no other network activity. After setup you can disconnect from the internet and the
extension keeps working.

## Permissions and why

| Permission                    | Why it's needed                                                                          |
| ----------------------------- | ---------------------------------------------------------------------------------------- |
| `offscreen`                   | Run the neural model in a long-lived offscreen document (service workers can't hold it). |
| `storage`, `unlimitedStorage` | Persist settings and the downloaded model locally.                                       |
| `contextMenus`                | Reserved for a right-click "analyze image" action.                                       |
| `<all_urls>` (host)           | Fetch cross-origin image bytes for local analysis (page CORS bypass).                    |
| Content script on all pages   | Discover and badge images on the pages you browse.                                       |

## Data retention

- Analysis results are cached **in memory only** for the current session and are not persisted.
- Settings and the model persist locally until you uninstall the extension or use
  "Re-download / reset model" in Options.

## Changes

Any change to this policy is recorded in [CHANGELOG.md](CHANGELOG.md) and reflected here.
