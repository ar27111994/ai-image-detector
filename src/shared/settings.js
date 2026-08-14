/**
 * Settings persistence + defaults, backed by chrome.storage.local.
 * Sanitizes all user-controlled values on read (defense in depth).
 */
import { DEFAULT_SETTINGS, STORAGE_KEYS } from './constants.js';

const SETTINGS_LIMITS = Object.freeze({
  threshold: { min: 0.05, max: 0.95 },
  minImageSize: { min: 8, max: 1024 },
  maxImagesPerPage: { min: 0, max: 5000 },
  badgePosition: new Set(['top-left', 'top-right', 'bottom-left', 'bottom-right']),
});

/** Clamp/sanitize a settings object into a valid one. Pure — unit-tested. */
export function sanitizeSettings(input) {
  const out = { ...DEFAULT_SETTINGS, ...(input ?? {}) };
  out.threshold = clampNumber(out.threshold, SETTINGS_LIMITS.threshold, DEFAULT_SETTINGS.threshold);
  out.minImageSize = Math.round(
    clampNumber(out.minImageSize, SETTINGS_LIMITS.minImageSize, DEFAULT_SETTINGS.minImageSize),
  );
  out.maxImagesPerPage = Math.round(
    clampNumber(
      out.maxImagesPerPage,
      SETTINGS_LIMITS.maxImagesPerPage,
      DEFAULT_SETTINGS.maxImagesPerPage,
    ),
  );
  out.autoScan = Boolean(out.autoScan);
  out.showBadges = Boolean(out.showBadges);
  out.visibleOnly = Boolean(out.visibleOnly);
  if (!SETTINGS_LIMITS.badgePosition.has(out.badgePosition)) {
    out.badgePosition = DEFAULT_SETTINGS.badgePosition;
  }
  return out;
}

function clampNumber(value, { min, max }, fallback) {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || Number.isNaN(n) || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Load settings from chrome.storage.local (sanitized). */
export async function loadSettings() {
  const raw = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  return sanitizeSettings(raw[STORAGE_KEYS.SETTINGS]);
}

/** Persist settings (sanitized). Returns the sanitized object actually written. */
export async function saveSettings(settings) {
  const clean = sanitizeSettings(settings);
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: clean });
  return clean;
}

/** Site enable/disable rules: { [hostname]: boolean }. */
export async function loadSiteRules() {
  const raw = await chrome.storage.local.get(STORAGE_KEYS.SITE_RULES);
  const rules = raw[STORAGE_KEYS.SITE_RULES];
  return rules && typeof rules === 'object' && !Array.isArray(rules) ? rules : {};
}

/** @param {string} hostname @param {boolean} enabled */
export async function setSiteEnabled(hostname, enabled) {
  const rules = await loadSiteRules();
  rules[String(hostname)] = Boolean(enabled);
  await chrome.storage.local.set({ [STORAGE_KEYS.SITE_RULES]: rules });
  return rules;
}

/** @param {string} hostname */
export async function isSiteEnabled(hostname) {
  const rules = await loadSiteRules();
  const value = rules[String(hostname)];
  return value === undefined ? true : Boolean(value); // default: enabled
}
