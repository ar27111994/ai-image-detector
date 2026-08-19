/**
 * Integration tests for the service worker message router: verify the request/response
 * protocol, sender validation, error envelopes, and routing — with a mock chrome runtime.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---- Mock chrome runtime + storage ----------------------------------------------
function makeChrome() {
  const listeners = [];
  const store = new Map();
  return {
    _listeners: listeners,
    _store: store,
    runtime: {
      id: 'test-extension-id',
      onMessage: { addListener: (fn) => listeners.push(fn) },
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      getURL: (p) => `chrome-extension://test-extension-id/${p}`,
    },
    storage: {
      local: {
        get: async (key) => {
          if (Array.isArray(key)) {
            const out = {};
            for (const k of key) if (store.has(k)) out[k] = store.get(k);
            return out;
          }
          return store.has(key) ? { [key]: store.get(key) } : {};
        },
        set: async (obj) => {
          for (const [k, v] of Object.entries(obj)) store.set(k, v);
        },
      },
      onChanged: { addListener: () => {} },
    },
    tabs: {
      onRemoved: { addListener: () => {} },
      onUpdated: { addListener: () => {} },
      create: async () => ({}),
    },
    offscreen: { createDocument: async () => {}, getContexts: async () => [] },
  };
}

/**
 * Dispatch a message to every registered listener and collect responses. For async handlers
 * (return true) we await a response latch instead of a fixed sleep loop, so the test is
 * event-driven and not timing-dependent (no CI flakiness from a 250ms ceiling).
 */
function dispatch(chrome, message, sender = {}) {
  const RESPONSE_TIMEOUT_MS = 5000;
  const results = [];
  const pending = [];
  for (const fn of chrome._listeners) {
    const latch = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(undefined), RESPONSE_TIMEOUT_MS);
      const isAsync = fn(message, sender, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      if (!isAsync) {
        // Synchronous listener that either responded already or opted out (returned false).
        clearTimeout(timer);
        resolve(undefined);
      }
    });
    pending.push(latch);
  }
  return Promise.all(pending).then((settled) => {
    for (const r of settled) if (r !== undefined) results.push(r);
    return results;
  });
}

describe('service-worker message router', () => {
  beforeEach(() => {
    vi.resetModules();
    globalThis.chrome = makeChrome();
  });

  it('responds PONG to a PING envelope from an extension context', async () => {
    await import('../../src/background/service-worker.js');
    const res = await dispatch(
      chrome,
      { id: 'p1', type: 'ping', payload: {} },
      { id: 'test-extension-id', url: 'chrome-extension://test-extension-id/pages/popup.html' },
    );
    expect(res).toHaveLength(1);
    expect(res[0].ok).toBe(true);
    expect(res[0].result.context).toBe('background');
  });

  it('rejects messages from a foreign extension/origin with FORBIDDEN', async () => {
    await import('../../src/background/service-worker.js');
    const res = await dispatch(
      chrome,
      { id: 'x1', type: 'ping', payload: {} },
      { id: 'evil-extension', origin: 'chrome-extension://evil-extension/x.html' },
    );
    expect(res).toHaveLength(1);
    expect(res[0].ok).toBe(false);
    expect(res[0].error.code).toBe('FORBIDDEN');
  });

  it('ignores non-envelope messages (no response)', async () => {
    await import('../../src/background/service-worker.js');
    const res = await dispatch(chrome, { notAnEnvelope: true }, { id: 'test-extension-id' });
    expect(res).toEqual([]);
  });

  it('returns BAD_INPUT for ANALYZE_IMAGE without a url', async () => {
    await import('../../src/background/service-worker.js');
    const res = await dispatch(
      chrome,
      { id: 'a1', type: 'analyze-image', payload: {} },
      { id: 'test-extension-id', tab: { id: 1 }, url: 'https://site.test/' },
    );
    expect(res).toHaveLength(1);
    expect(res[0].ok).toBe(false);
    expect(res[0].error.code).toBe('BAD_INPUT');
  });

  it('returns site-disabled skip when a site is disabled', async () => {
    const { setSiteEnabled } = await import('../../src/shared/settings.js');
    await setSiteEnabled('blocked.test', false);
    await import('../../src/background/service-worker.js');
    const res = await dispatch(
      chrome,
      { id: 'a2', type: 'analyze-image', payload: { url: 'https://blocked.test/x.png' } },
      { id: 'test-extension-id', tab: { id: 1 }, url: 'https://blocked.test/' },
    );
    expect(res).toHaveLength(1);
    expect(res[0].ok).toBe(true);
    expect(res[0].result.skipped).toBe(true);
    expect(res[0].result.reason).toBe('site-disabled');
  });

  it('GET_SETTINGS returns sanitized defaults', async () => {
    await import('../../src/background/service-worker.js');
    const res = await dispatch(
      chrome,
      { id: 'g1', type: 'get-settings', payload: {} },
      { id: 'test-extension-id', tab: { id: 1 }, url: 'https://site.test/' },
    );
    expect(res[0].ok).toBe(true);
    expect(res[0].result.threshold).toBe(0.65);
  });
});
