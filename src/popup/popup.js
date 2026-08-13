/**
 * Toolbar popup. Phase 1 scaffold: shows SW connectivity.
 * Phase 3 adds: per-page stats, threshold control, site toggle.
 */
import { MSG } from '../shared/constants.js';

const statusEl = document.getElementById('popup-status');

async function init() {
  try {
    const pong = await chrome.runtime.sendMessage({ type: MSG.PING });
    statusEl.textContent = pong?.type === MSG.PONG ? 'Connected (scaffold)' : 'No response';
  } catch {
    statusEl.textContent = 'Service worker unavailable';
  }
}

init();
