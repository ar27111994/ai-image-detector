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
});
