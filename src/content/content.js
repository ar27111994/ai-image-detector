/**
 * Content script: image discovery + badge overlays.
 * Phase 1 scaffold: verifies connectivity with the service worker.
 * Phase 3 adds: discovery, observers, badge rendering.
 */
import { MSG } from '../shared/constants.js';

async function bootstrap() {
  try {
    const pong = await chrome.runtime.sendMessage({ type: MSG.PING });
    if (pong?.type === MSG.PONG) {
      console.debug('[ai-detector] content script connected');
      // DOM marker for e2e verification (console from content scripts is unreliable
      // in headless/automation contexts).
      document.documentElement.setAttribute('data-ai-detector-connected', 'true');
    }
  } catch {
    // Extension context invalidated (reload/update) — safe to ignore.
  }
}

bootstrap();
