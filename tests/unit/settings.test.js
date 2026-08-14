import { beforeEach, describe, expect, it, vi } from 'vitest';

// Minimal chrome.storage.local stub for the settings module.
const store = new Map();
globalThis.chrome = {
  storage: {
    local: {
      get: vi.fn(async (key) => {
        if (Array.isArray(key)) {
          const out = {};
          for (const k of key) if (store.has(k)) out[k] = store.get(k);
          return out;
        }
        return store.has(key) ? { [key]: store.get(key) } : {};
      }),
      set: vi.fn(async (obj) => {
        for (const [k, v] of Object.entries(obj)) store.set(k, v);
      }),
    },
  },
};

const {
  loadSettings,
  saveSettings,
  sanitizeSettings,
  isSiteEnabled,
  setSiteEnabled,
  loadSiteRules,
} = await import('../../src/shared/settings.js');

beforeEach(() => store.clear());

describe('settings.sanitizeSettings', () => {
  it('returns defaults for empty input', () => {
    const s = sanitizeSettings({});
    expect(s.threshold).toBe(0.65);
    expect(s.minImageSize).toBe(64);
    expect(s.autoScan).toBe(true);
  });

  it('clamps threshold into [0.05, 0.95]', () => {
    expect(sanitizeSettings({ threshold: 0.001 }).threshold).toBe(0.05);
    expect(sanitizeSettings({ threshold: 5 }).threshold).toBe(0.95);
  });

  it('falls back to default on non-numeric threshold', () => {
    expect(sanitizeSettings({ threshold: 'abc' }).threshold).toBe(0.65);
    expect(sanitizeSettings({ threshold: NaN }).threshold).toBe(0.65);
  });

  it('rounds minImageSize and clamps', () => {
    expect(sanitizeSettings({ minImageSize: 3 }).minImageSize).toBe(8);
    expect(sanitizeSettings({ minImageSize: 100.7 }).minImageSize).toBe(101);
  });

  it('rejects invalid badgePosition', () => {
    expect(sanitizeSettings({ badgePosition: 'nowhere' }).badgePosition).toBe('top-left');
    expect(sanitizeSettings({ badgePosition: 'bottom-right' }).badgePosition).toBe('bottom-right');
  });

  it('coerces booleans', () => {
    const s = sanitizeSettings({ autoScan: 0, showBadges: 1 });
    expect(s.autoScan).toBe(false);
    expect(s.showBadges).toBe(true);
  });

  it('never throws on adversarial input', () => {
    expect(() => sanitizeSettings(null)).not.toThrow();
    expect(() => sanitizeSettings({ threshold: { evil: true } })).not.toThrow();
    expect(() => sanitizeSettings('string')).not.toThrow();
  });
});

describe('settings storage round-trip', () => {
  it('saves sanitized and loads back', async () => {
    await saveSettings({ threshold: 0.7, minImageSize: 100 });
    const loaded = await loadSettings();
    expect(loaded.threshold).toBe(0.7);
    expect(loaded.minImageSize).toBe(100);
  });

  it('loads defaults when nothing stored', async () => {
    const loaded = await loadSettings();
    expect(loaded.threshold).toBe(0.65);
  });
});

describe('site rules', () => {
  it('defaults to enabled for unknown host', async () => {
    expect(await isSiteEnabled('example.com')).toBe(true);
  });

  it('persists disable/enable per host', async () => {
    await setSiteEnabled('bad.com', false);
    expect(await isSiteEnabled('bad.com')).toBe(false);
    expect(await isSiteEnabled('other.com')).toBe(true);
    await setSiteEnabled('bad.com', true);
    expect(await isSiteEnabled('bad.com')).toBe(true);
  });

  it('loadSiteRules returns an object even when storage is corrupt', async () => {
    store.set('site.rules.v1', 'not-an-object');
    expect(await loadSiteRules()).toEqual({});
  });
});
