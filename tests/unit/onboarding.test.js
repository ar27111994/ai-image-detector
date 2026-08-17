/**
 * Unit tests for the onboarding page (src/onboarding/onboarding.js): initial render per model
 * state (missing / downloading / error / ready) and the download-start action.
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

async function loadOnboarding(initialState) {
  chromeStub.storage.set(STORAGE_KEYS.MODEL_STATE, initialState);
  // Route the STATUS request to return our state.
  chromeStub.chrome.runtime.sendMessage = async (msg) => {
    if (msg.type === MSG.MODEL_DOWNLOAD_STATUS) return { ok: true, result: initialState };
    if (msg.type === MSG.MODEL_DOWNLOAD_START) return { ok: true, result: { started: true } };
    return { ok: true, result: {} };
  };
  vi.resetModules();
  await import('../../src/onboarding/onboarding.js');
  await new Promise((r) => setTimeout(r, 20));
}

beforeEach(() => {
  cleanupDom?.();
  chromeStub?.cleanup();
  cleanupDom = installDomStub();
  chromeStub = installChromeStub();
  const root = document.createElement('main');
  root.setAttribute('id', 'onboarding-root');
  document.__register(root);
  document.body.appendChild(root);
});

describe('onboarding page', () => {
  it('shows the download CTA when the model is missing', async () => {
    await loadOnboarding({ status: 'missing', progress: 0 });
    const status = document.getElementById('status');
    const buttons = all(status).filter((n) => n.tagName === 'BUTTON');
    expect(buttons.map((b) => b.textContent)).toContain('Download model');
  });

  it('shows progress while downloading', async () => {
    await loadOnboarding({
      status: 'downloading',
      progress: 0.42,
      downloadedBytes: 42e6,
      totalBytes: 100e6,
    });
    const status = document.getElementById('status');
    expect(textOf(status)).toMatch(/42%/);
    const bar = all(status).find((n) => n.tagName === 'PROGRESS');
    expect(bar.getAttribute('aria-valuenow')).toBe('42');
  });

  it('shows a retry action on error', async () => {
    await loadOnboarding({ status: 'error', error: 'sha256 mismatch' });
    const status = document.getElementById('status');
    expect(textOf(status)).toMatch(/Download failed/);
    const buttons = all(status).filter((n) => n.tagName === 'BUTTON');
    expect(buttons.map((b) => b.textContent)).toContain('Retry download');
  });

  it('shows the ready state with next steps when the model is ready', async () => {
    await loadOnboarding({ status: 'ready', progress: 1 });
    const status = document.getElementById('status');
    expect(textOf(status)).toMatch(/Model ready/);
    expect(textOf(status)).toMatch(/all set/i);
  });

  it('clicking "Download model" sends MODEL_DOWNLOAD_START', async () => {
    await loadOnboarding({ status: 'missing', progress: 0 });
    const status = document.getElementById('status');
    const start = all(status).find(
      (n) => n.tagName === 'BUTTON' && /Download model/.test(n.textContent),
    );
    const sent = [];
    chromeStub.chrome.runtime.sendMessage = async (msg) => {
      sent.push(msg.type);
      return { ok: true, result: {} };
    };
    start.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toContain(MSG.MODEL_DOWNLOAD_START);
  });

  it('falls back to chrome.storage when the status message fails', async () => {
    chromeStub.storage.set(STORAGE_KEYS.MODEL_STATE, { status: 'ready', progress: 1 });
    chromeStub.chrome.runtime.sendMessage = async () => Promise.reject(new Error('no SW'));
    vi.resetModules();
    await import('../../src/onboarding/onboarding.js');
    await new Promise((r) => setTimeout(r, 30));
    const status = document.getElementById('status');
    expect(textOf(status)).toMatch(/Model ready/);
  });

  it('re-renders on a MODEL_DOWNLOAD_PROGRESS message', async () => {
    await loadOnboarding({
      status: 'downloading',
      progress: 0.1,
      downloadedBytes: 1e7,
      totalBytes: 1e8,
    });
    const status = document.getElementById('status');
    // Drive the runtime.onMessage listener registered by init().
    const listeners = chromeStub.listeners?.message ?? [];
    expect(listeners.length).toBeGreaterThan(0);
    for (const fn of listeners) {
      fn(
        {
          type: MSG.MODEL_DOWNLOAD_PROGRESS,
          payload: { status: 'downloading', progress: 0.9, downloadedBytes: 9e7, totalBytes: 1e8 },
        },
        {},
        () => {},
      );
    }
    await new Promise((r) => setTimeout(r, 20));
    expect(textOf(status)).toMatch(/90%/);
  });

  it('re-renders on a storage change to the model state', async () => {
    await loadOnboarding({
      status: 'downloading',
      progress: 0.5,
      downloadedBytes: 5e7,
      totalBytes: 1e8,
    });
    const status = document.getElementById('status');
    const changed = chromeStub.listeners?.changed ?? [];
    expect(changed.length).toBeGreaterThan(0);
    for (const fn of changed) {
      fn({ [STORAGE_KEYS.MODEL_STATE]: { newValue: { status: 'ready', progress: 1 } } }, 'local');
    }
    await new Promise((r) => setTimeout(r, 20));
    expect(textOf(status)).toMatch(/Model ready/);
  });

  it('shows "Failed to start" when MODEL_DOWNLOAD_START rejects', async () => {
    await loadOnboarding({ status: 'missing', progress: 0 });
    const status = document.getElementById('status');
    const start = all(status).find(
      (n) => n.tagName === 'BUTTON' && /Download model/.test(n.textContent),
    );
    chromeStub.chrome.runtime.sendMessage = async () => Promise.reject(new Error('no route'));
    start.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(textOf(status)).toMatch(/Failed to start/i);
  });

  it('shows "?" for unknown total size during a download', async () => {
    await loadOnboarding({
      status: 'downloading',
      progress: 0.5,
      downloadedBytes: 5e7,
      totalBytes: 0,
    });
    const status = document.getElementById('status');
    expect(textOf(status)).toMatch(/\? MB/);
  });

  it('ignores non-progress messages on the runtime channel', async () => {
    await loadOnboarding({ status: 'missing', progress: 0 });
    const status = document.getElementById('status');
    const listeners = chromeStub.listeners?.message ?? [];
    for (const fn of listeners) fn({ type: 'some-other-message', payload: {} }, {}, () => {});
    await new Promise((r) => setTimeout(r, 10));
    // Still on the missing/download CTA — no crash, no spurious re-render.
    expect(textOf(status)).toMatch(/Download model/);
  });

  it('ignores storage changes for other keys/areas', async () => {
    await loadOnboarding({ status: 'missing', progress: 0 });
    const status = document.getElementById('status');
    const changed = chromeStub.listeners?.changed ?? [];
    for (const fn of changed) {
      fn({ unrelated: { newValue: 1 } }, 'local'); // wrong key
      fn({ [STORAGE_KEYS.MODEL_STATE]: { newValue: { status: 'ready' } } }, 'sync'); // wrong area
    }
    await new Promise((r) => setTimeout(r, 10));
    expect(textOf(status)).toMatch(/Download model/);
  });
});
