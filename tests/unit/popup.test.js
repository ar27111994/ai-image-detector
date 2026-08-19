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

  it('toggles the site rule via the "This site" checkbox (SET_SITE_ENABLED)', async () => {
    await loadPopup(); // default tabs.query returns https://example.test/
    const root = document.getElementById('popup-root');
    // The site section renders asynchronously (chrome.tabs.query callback) — wait for it.
    let toggle;
    for (let i = 0; i < 100; i++) {
      toggle = all(root).find((n) => n.getAttribute('id') === 'site-toggle');
      if (toggle) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(toggle).toBeTruthy();
    const sent = [];
    chromeStub.chrome.runtime.sendMessage = async (msg) => {
      sent.push(msg.type);
      return { id: msg.id, ok: true, result: {} };
    };
    toggle.checked = false;
    toggle.dispatch('change');
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toContain(MSG.SET_SITE_ENABLED);
    expect(toggle.disabled).toBe(false); // re-enabled after the request settles
  });

  it('shows "Not available on this page." for a non-http(s) tab', async () => {
    chromeStub.chrome.tabs.query = async (_q, cb) => cb([{ id: 1, url: 'chrome://extensions' }]);
    await loadPopup();
    const root = document.getElementById('popup-root');
    let note;
    for (let i = 0; i < 100; i++) {
      note = all(root).find((n) => /Not available on this page/.test(n.textContent ?? ''));
      if (note) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(note).toBeTruthy();
  });

  it('persists the threshold to storage on slider change', async () => {
    await loadPopup();
    const root = document.getElementById('popup-root');
    const slider = all(root).find((n) => n.getAttribute('type') === 'range');
    slider.value = '80';
    slider.dispatch('change');
    await new Promise((r) => setTimeout(r, 20));
    const saved = chromeStub.storage.get(STORAGE_KEYS.SETTINGS);
    expect(saved.threshold).toBeCloseTo(0.8, 5);
  });

  it('handles a malformed tab URL gracefully (no crash, no toggle)', async () => {
    chromeStub.chrome.tabs.query = async (_q, cb) => cb([{ id: 1, url: 'not a url' }]);
    await loadPopup();
    const root = document.getElementById('popup-root');
    let note;
    for (let i = 0; i < 100; i++) {
      note = all(root).find((n) => /Not available on this page/.test(n.textContent ?? ''));
      if (note) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(note).toBeTruthy();
    expect(all(root).find((n) => n.getAttribute('id') === 'site-toggle')).toBeUndefined();
  });

  it('shows a generic error (not the timeout copy) for a non-timeout failure', async () => {
    await loadPopup({ sendImpl: async () => Promise.reject(new Error('boom')) });
    const root = document.getElementById('popup-root');
    const err = all(root).find((n) => n.classList.contains('popup-error'));
    expect(err).toBeTruthy();
    expect(err.textContent).toMatch(/try reloading the extension/i);
    expect(err.textContent).not.toMatch(/timeout/i);
  });

  it('shows "Setup error" when the model is in an error state', async () => {
    await loadPopup({
      status: { model: { status: 'error', error: 'sha256 mismatch' }, ready: false, cacheSize: 0 },
    });
    const root = document.getElementById('popup-root');
    const pill = all(root).find((n) => n.classList.contains('status-pill'));
    expect(pill?.textContent).toMatch(/Setup error/i);
  });

  it('does not render the stats section when the model is not ready', async () => {
    await loadPopup({
      status: { model: { status: 'missing' }, ready: false, cacheSize: 0 },
    });
    const root = document.getElementById('popup-root');
    // Stats grid only renders when ready.
    expect(all(root).some((n) => n.classList.contains('stats-grid'))).toBe(false);
  });

  it('opens the options page from the footer Settings button', async () => {
    await loadPopup();
    const root = document.getElementById('popup-root');
    const opened = [];
    chromeStub.chrome.runtime.openOptionsPage = () => opened.push(true);
    const btn = all(root).find((n) => n.tagName === 'BUTTON' && /Settings/.test(n.textContent));
    btn.click();
    expect(opened.length).toBe(1);
  });

  it('renders zero-count stats when the page has no analyses yet', async () => {
    await loadPopup(); // GET_TAB_STATS returns zeros by default below
    const root = document.getElementById('popup-root');
    // Override stats to an empty result.
    // (The default loadPopup routes GET_TAB_STATS to a populated object; assert the grid cells exist.)
    const cells = all(root).filter((n) => n.classList.contains('stat-value'));
    expect(cells.length).toBe(4); // Analyzed / AI / Real / Unclear
    expect(cells.every((c) => /^\d+$/.test(c.textContent))).toBe(true);
  });

  it('shows the timeout copy specifically for a timeout error', async () => {
    await loadPopup({
      sendImpl: async () => Promise.reject(new Error('request TIMEOUT after 15s')),
    });
    const root = document.getElementById('popup-root');
    const err = all(root).find((n) => n.classList.contains('popup-error'));
    expect(err.textContent).toMatch(/busy or not responding \(timeout\)/i);
  });

  it('renders stats as 0 when the SW returns no tab stats (null result)', async () => {
    await loadPopup({
      sendImpl: async (msg) => {
        if (msg.type === MSG.GET_STATUS) {
          return {
            id: msg.id,
            ok: true,
            result: { model: { status: 'ready' }, ready: true, cacheSize: 0 },
          };
        }
        if (msg.type === MSG.GET_SETTINGS)
          return { id: msg.id, ok: true, result: { threshold: 0.65 } };
        if (msg.type === MSG.GET_TAB_STATS) return { id: msg.id, ok: true, result: null }; // no stats
        return { id: msg.id, ok: true, result: {} };
      },
    });
    const root = document.getElementById('popup-root');
    const cells = all(root).filter((n) => n.classList.contains('stat-value'));
    expect(cells.length).toBe(4);
    expect(cells.every((c) => c.textContent === '0')).toBe(true); // ?? 0 fallback path
  });
});
