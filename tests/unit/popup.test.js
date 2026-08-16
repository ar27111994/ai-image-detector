/**
 * Unit tests for the toolbar popup (src/popup/popup.js): status rendering, the loading state,
 * per-page stats, and graceful error handling when the service worker is unreachable.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeStub, installDomStub } from '../helpers/dom-stub.js';
import { MSG, STORAGE_KEYS } from '../../src/shared/constants.js';

let cleanupDom;
let chromeStub;

function all(node, acc = []) {
  for (const c of node.children) {
    acc.push(c);
    all(c, acc);
  }
  return acc;
}
function textOf(node) {
  return all(node, [node])
    .map((n) => n._text ?? '')
    .join(' ');
}

async function loadPopup({ status, settings, sendImpl } = {}) {
  if (settings) chromeStub.storage.set(STORAGE_KEYS.SETTINGS, settings);
  chromeStub.chrome.runtime.sendMessage =
    sendImpl ??
    (async (msg) => {
      if (msg.type === MSG.GET_STATUS) {
        return {
          ok: true,
          result: status ?? { model: { status: 'ready' }, ready: true, cacheSize: 3 },
        };
      }
      if (msg.type === MSG.GET_SETTINGS) {
        return { ok: true, result: settings ?? { threshold: 0.65 } };
      }
      if (msg.type === MSG.GET_TAB_STATS) {
        return {
          ok: true,
          result: { tabId: 1, analyzed: 5, ai: 2, real: 2, uncertain: 1, error: 0 },
        };
      }
      return { ok: true, result: {} };
    });
  vi.resetModules();
  await import('../../src/popup/popup.js');
  // Wait until the loading placeholder is removed (success) or an error panel appears, with a
  // bounded poll so slow microtask chains (Promise.all over several messages) settle first.
  const root = document.getElementById('popup-root');
  for (let i = 0; i < 100; i++) {
    const loading = all(root).some((n) => n.classList.contains('popup-loading'));
    const errored = all(root).some((n) => n.classList.contains('popup-error'));
    const statusPill = all(root).some((n) => n.classList.contains('status-pill'));
    if (!loading && (statusPill || errored)) break;
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeEach(() => {
  cleanupDom?.();
  chromeStub?.cleanup();
  cleanupDom = installDomStub();
  chromeStub = installChromeStub();
  const root = document.createElement('main');
  root.setAttribute('id', 'popup-root');
  document.__register(root);
  document.body.appendChild(root);
});

describe('popup', () => {
  it('clears the loading skeleton and renders status + stats when ready', async () => {
    await loadPopup();
    const root = document.getElementById('popup-root');
    // Loading placeholder removed.
    expect(all(root).filter((n) => n.classList.contains('popup-loading'))).toEqual([]);
    // Status pill shows Ready.
    const pill = all(root).find((n) => n.classList.contains('status-pill'));
    expect(pill?.textContent).toMatch(/Ready/i);
    // Stats grid rendered with the analyzed count.
    expect(textOf(root)).toMatch(/Analyzed/);
  });

  it('shows "Setup required" with an Open setup action when the model is missing', async () => {
    await loadPopup({
      status: { model: { status: 'missing' }, ready: false, cacheSize: 0 },
    });
    const root = document.getElementById('popup-root');
    const pill = all(root).find((n) => n.classList.contains('status-pill'));
    expect(pill?.textContent).toMatch(/Setup required/i);
    const openSetup = all(root).find(
      (n) => n.tagName === 'BUTTON' && /Open setup/i.test(n.textContent),
    );
    expect(openSetup).toBeTruthy();
  });

  it('shows a download progress pill while the model downloads', async () => {
    await loadPopup({
      status: { model: { status: 'downloading', progress: 0.3 }, ready: false, cacheSize: 0 },
    });
    const root = document.getElementById('popup-root');
    const pill = all(root).find((n) => n.classList.contains('status-pill'));
    expect(pill?.textContent).toMatch(/Downloading model/i);
  });

  it('renders an accessible error when the service worker never responds', async () => {
    await loadPopup({ sendImpl: async () => Promise.reject(new Error('timeout')) });
    const root = document.getElementById('popup-root');
    const err = all(root).find((n) => n.classList.contains('popup-error'));
    expect(err).toBeTruthy();
    expect(err.getAttribute('role')).toBe('alert');
    expect(err.textContent).toMatch(/busy or not responding/i);
  });

  it('updates the threshold output live as the slider moves', async () => {
    await loadPopup();
    const root = document.getElementById('popup-root');
    const slider = all(root).find((n) => n.getAttribute('type') === 'range');
    const output = all(root).find((n) => n.tagName === 'OUTPUT');
    slider.value = '75';
    slider.dispatch('input');
    expect(output.textContent).toBe('75%');
  });
});
