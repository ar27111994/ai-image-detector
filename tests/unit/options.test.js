/**
 * Unit tests for the options page (src/options/options.js) using the shared DOM stub.
 * Focus: the ARIA attribute hygiene of the field builders (the `aria-describedby="null"`
 * regression) and settings round-trip.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeStub, installDomStub } from '../helpers/dom-stub.js';
import { STORAGE_KEYS } from '../../src/shared/constants.js';

let cleanupDom;
let chromeStub;

function collectAttributes(node, acc = []) {
  for (const c of node.children) {
    acc.push(c);
    collectAttributes(c, acc);
  }
  return acc;
}

/** Import options.js fresh (it runs init() at load against the current stub DOM). */
async function loadOptions() {
  vi.resetModules();
  await import('../../src/options/options.js');
  await new Promise((r) => setTimeout(r, 20));
}

beforeEach(() => {
  cleanupDom?.();
  chromeStub?.cleanup();
  cleanupDom = installDomStub();
  chromeStub = installChromeStub();
  // options.js binds to #options-root.
  const root = document.createElement('main');
  root.setAttribute('id', 'options-root');
  document.__register(root);
  document.body.appendChild(root);
});

describe('options page ARIA hygiene', () => {
  it('does not render aria-describedby="null" on fields without a hint', async () => {
    await loadOptions();
    const root = document.getElementById('options-root');
    const offenders = collectAttributes(root).filter(
      (n) => n.getAttribute('aria-describedby') === 'null',
    );
    expect(offenders).toEqual([]);
  });

  it('only sets aria-describedby when a matching hint element exists', async () => {
    await loadOptions();
    const root = document.getElementById('options-root');
    const all = collectAttributes(root);
    const ids = new Set(all.map((n) => n.getAttribute('id')).filter(Boolean));
    for (const n of all) {
      const ref = n.getAttribute('aria-describedby');
      if (ref == null) continue;
      expect(ref).not.toBe('null');
      expect(ids.has(ref)).toBe(true);
    }
  });

  it('renders the detection section heading', async () => {
    await loadOptions();
    const headings = collectAttributes(document.getElementById('options-root'))
      .filter((n) => n.tagName === 'H2')
      .map((n) => n.textContent);
    expect(headings).toContain('Detection');
  });

  it('persists a threshold change to chrome.storage after sanitization', async () => {
    await loadOptions();
    const root = document.getElementById('options-root');
    const number = collectAttributes(root).find((n) => n.getAttribute('type') === 'number');
    expect(number).toBeTruthy();
    number.value = '80';
    number.dispatch('change');
    await new Promise((r) => setTimeout(r, 20));

    const saved = chromeStub.storage.get(STORAGE_KEYS.SETTINGS);
    expect(saved).toBeTruthy();
    expect(saved.threshold).toBeCloseTo(0.8, 5);
  });

  it('renders the empty-state message when there are no per-site rules', async () => {
    await loadOptions();
    const root = document.getElementById('options-root');
    const all = collectAttributes(root);
    expect(all.some((n) => /No per-site overrides yet/.test(n.textContent ?? ''))).toBe(true);
  });

  it('removes a per-site rule after confirmation', async () => {
    chromeStub.storage.set(STORAGE_KEYS.SITE_RULES, { 'example.test': false });
    globalThis.__confirmReturn = true;
    await loadOptions();
    const root = document.getElementById('options-root');
    const all = collectAttributes(root);
    const removeBtn = all.find(
      (n) =>
        n.tagName === 'BUTTON' &&
        /Remove rule for example\.test/.test(n.getAttribute('aria-label') ?? ''),
    );
    expect(removeBtn).toBeTruthy();
    removeBtn.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(chromeStub.storage.get(STORAGE_KEYS.SITE_RULES)).toEqual({});
    expect(globalThis.__confirmCalls.length).toBeGreaterThan(0);
  });

  it('keeps the rule when the removal is cancelled', async () => {
    chromeStub.storage.set(STORAGE_KEYS.SITE_RULES, { 'example.test': false });
    globalThis.__confirmReturn = false; // user cancels the dialog
    await loadOptions();
    const root = document.getElementById('options-root');
    const all = collectAttributes(root);
    const removeBtn = all.find(
      (n) => n.tagName === 'BUTTON' && /Remove rule/.test(n.getAttribute('aria-label') ?? ''),
    );
    removeBtn.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(chromeStub.storage.get(STORAGE_KEYS.SITE_RULES)).toEqual({ 'example.test': false });
  });

  it('resets the model after confirmation and opens onboarding', async () => {
    globalThis.__confirmReturn = true;
    const opened = [];
    chromeStub.chrome.tabs.create = async (t) => opened.push(t);
    await loadOptions();
    const root = document.getElementById('options-root');
    const all = collectAttributes(root);
    const reset = all.find(
      (n) => n.tagName === 'BUTTON' && /Re-download \/ reset model/i.test(n.textContent ?? ''),
    );
    expect(reset).toBeTruthy();
    reset.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(opened.length).toBe(1);
    expect(String(opened[0].url)).toContain('onboarding.html');
  });

  it('shows the model card with status, variant, and size when ready', async () => {
    chromeStub.storage.set(STORAGE_KEYS.MODEL_STATE, {
      status: 'ready',
      variant: 'primary-int8',
      downloadedBytes: 311e6,
    });
    await loadOptions();
    const root = document.getElementById('options-root');
    const all = collectAttributes(root);
    expect(all.some((n) => /Downloaded & verified/.test(n.textContent ?? ''))).toBe(true);
    expect(all.some((n) => n.textContent === 'primary-int8')).toBe(true);
    expect(all.some((n) => /311 MB/.test(n.textContent ?? ''))).toBe(true);
  });

  it('clamps an out-of-range threshold into the valid band on save', async () => {
    await loadOptions();
    const root = document.getElementById('options-root');
    const number = collectAttributes(root).find((n) => n.getAttribute('type') === 'number');
    number.value = '9999'; // way above max
    number.dispatch('change');
    await new Promise((r) => setTimeout(r, 20));
    expect(chromeStub.storage.get(STORAGE_KEYS.SETTINGS).threshold).toBeLessThanOrEqual(0.95);
  });

  it('handles a non-numeric threshold input (NaN) without crashing', async () => {
    await loadOptions();
    const root = document.getElementById('options-root');
    const number = collectAttributes(root).find((n) => n.getAttribute('type') === 'number');
    number.value = 'not-a-number';
    number.dispatch('change');
    await new Promise((r) => setTimeout(r, 20));
    const saved = chromeStub.storage.get(STORAGE_KEYS.SETTINGS);
    expect(Number.isFinite(saved.threshold)).toBe(true);
  });

  it('toggles a boolean setting via its checkbox', async () => {
    await loadOptions();
    const root = document.getElementById('options-root');
    const cb = collectAttributes(root).find((n) => n.getAttribute('type') === 'checkbox');
    expect(cb).toBeTruthy();
    const before = chromeStub.storage.get(STORAGE_KEYS.SETTINGS)?.autoScan ?? true;
    cb.checked = !before;
    cb.dispatch('change');
    await new Promise((r) => setTimeout(r, 20));
    expect(chromeStub.storage.get(STORAGE_KEYS.SETTINGS).autoScan).toBe(!before);
  });

  it('persists a badge-position change via the select', async () => {
    await loadOptions();
    const root = document.getElementById('options-root');
    const sel = collectAttributes(root).find((n) => n.getAttribute('id') === 'badge-position');
    expect(sel).toBeTruthy();
    sel.value = 'bottom-right';
    sel.dispatch('change');
    await new Promise((r) => setTimeout(r, 20));
    expect(chromeStub.storage.get(STORAGE_KEYS.SETTINGS).badgePosition).toBe('bottom-right');
  });

  it('persists every numeric + boolean setting field to storage', async () => {
    await loadOptions();
    const root = document.getElementById('options-root');
    const all = collectAttributes(root);
    // Exercise each numeric field (threshold, minImageSize, maxImagesPerPage).
    for (const num of all.filter((n) => n.getAttribute('type') === 'number')) {
      num.value = num.getAttribute('max') ?? '100';
      num.dispatch('change');
      await new Promise((r) => setTimeout(r, 10));
    }
    // Exercise each checkbox (autoScan, showBadges, visibleOnly).
    for (const cb of all.filter((n) => n.getAttribute('type') === 'checkbox')) {
      cb.checked = !cb.checked;
      cb.dispatch('change');
      await new Promise((r) => setTimeout(r, 10));
    }
    const saved = chromeStub.storage.get(STORAGE_KEYS.SETTINGS);
    expect(saved).toBeTruthy();
    expect(Number.isFinite(saved.minImageSize)).toBe(true);
    expect(Number.isFinite(saved.maxImagesPerPage)).toBe(true);
    expect(typeof saved.showBadges).toBe('boolean');
    expect(typeof saved.visibleOnly).toBe('boolean');
  });
});
