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
});
