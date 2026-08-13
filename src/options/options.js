/**
 * Options page. Phase 1 scaffold: renders default settings (read-only).
 * Phase 3 adds: full settings form + persistence + site rules.
 */
import { DEFAULT_SETTINGS } from '../shared/constants.js';

const statusEl = document.getElementById('options-status');
statusEl.textContent = `Defaults loaded: threshold=${DEFAULT_SETTINGS.threshold}, minImageSize=${DEFAULT_SETTINGS.minImageSize}px`;
