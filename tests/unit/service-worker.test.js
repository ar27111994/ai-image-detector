/**
 * Unit tests for the service-worker message router (src/background/service-worker.js).
 * Focus: sender authorization (isExtensionContext) and analysis-result caching + concurrent
 * dedup (cache-stampede protection). The offscreen boundary is mocked at the protocol layer
 * (chrome.runtime.sendMessage), and model-manager at the module layer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeStub } from '../helpers/dom-stub.js';
import { MSG } from '../../src/shared/constants.js';

// Model manager: report ready, no real IndexedDB/network.
vi.mock('../../src/background/model-manager.js', () => ({
  isModelReady: vi.fn(async () => true),
  getModelState: vi.fn(async () => ({ status: 'ready', progress: 1 })),
  loadManifest: vi.fn(async () => ({ variants: [{ kind: 'wasm', key: 'primary-int8' }] })),
  ensureModel: vi.fn(async () => ({ alreadyReady: true })),
}));

let chromeStub;
let listener;
let offscreenCalls;

function dispatch(message, sender) {
  return new Promise((resolve) => {
    listener(message, sender, (res) => resolve(res));
  });
}
const req = (type, payload = {}) => ({ id: `t-${Math.random()}`, type, target: null, payload });

/** Minimal valid PNG header bytes (content differs per call via a counter suffix). */
let pngCounter = 0;
function fakeImageBytes() {
  // 8-byte PNG magic + a varying tail so content-hash differs between images.
  const base = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const tail = new Uint8Array(8);
  new DataView(tail.buffer).setUint32(0, pngCounter++);
  return Uint8Array.from([...base, ...tail]).buffer;
}

beforeEach(async () => {
  chromeStub?.cleanup();
  chromeStub = installChromeStub();
  offscreenCalls = 0;
  // The SW talks to the offscreen doc via chrome.runtime.sendMessage (protocol.sendRequest).
  // Mock it: ENSURE_READY -> ok; OFFSCREEN_ANALYZE -> a synthetic AI result.
  chromeStub.chrome.runtime.sendMessage = async (msg) => {
    if (msg.type === MSG.OFFSCREEN_ENSURE_READY) {
      return { id: msg.id, ok: true, result: { ep: 'wasm', variant: 'primary-int8' } };
    }
    if (msg.type === MSG.OFFSCREEN_ANALYZE) {
      offscreenCalls++;
      // Yield so concurrent callers interleave (exercises the inflight dedup).
      await new Promise((r) => setTimeout(r, 5));
      return {
        id: msg.id,
        ok: true,
        result: { score: 0.91, verdict: 'ai', reasons: [], ep: 'wasm', latencyMs: 2 },
      };
    }
    return { id: msg.id, ok: true, result: {} };
  };
  // SW reads image bytes for analyze-by-url via fetch(); return our fake image.
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    headers: { get: () => null },
    blob: async () => ({ size: 16, arrayBuffer: async () => fakeImageBytes() }),
  }));

  chromeStub.chrome.runtime.onMessage.addListener = (fn) => {
    listener = fn;
  };
  chromeStub.chrome.runtime.onInstalled = { addListener: () => {} };
  chromeStub.chrome.runtime.onStartup = { addListener: () => {} };
  chromeStub.chrome.runtime.getContexts = async () => [{ contextType: 'OFFSCREEN_DOCUMENT' }];
  chromeStub.chrome.offscreen = { createDocument: async () => {} };

  vi.resetModules();
  await import('../../src/background/service-worker.js');
});

const pageSender = { id: 'test-ext-id', url: 'https://site.example/page', tab: { id: 1 } };

describe('service-worker router', () => {
  it('rejects messages from a foreign extension/origin', async () => {
    const res = await dispatch(req(MSG.GET_STATUS), { id: 'other-ext', url: 'https://evil.test' });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('FORBIDDEN');
  });

  it('accepts PING from an extension context and answers', async () => {
    const res = await dispatch(req(MSG.PING), pageSender);
    expect(res.ok).toBe(true);
    expect(res.result.context).toBe('background');
  });

  it('caches analysis results by content hash (second identical request is a cache hit)', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      headers: { get: () => null },
      blob: async () => ({ size: 16, arrayBuffer: async () => fakeImageBytes().slice(0) }),
    }));
    // Force both requests to use the SAME bytes by pinning the counter.
    const fixed = fakeImageBytes();
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      headers: { get: () => null },
      blob: async () => ({ size: fixed.byteLength, arrayBuffer: async () => fixed.slice(0) }),
    }));

    const first = await dispatch(
      req(MSG.ANALYZE_IMAGE, { url: 'https://cdn.example/a.png' }),
      pageSender,
    );
    const second = await dispatch(
      req(MSG.ANALYZE_IMAGE, { url: 'https://cdn.example/a.png' }),
      pageSender,
    );
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.result.cached).toBe(true);
    expect(offscreenCalls).toBe(1); // second request served from cache
  });

  it('deduplicates concurrent identical analyses into one inference call', async () => {
    const fixed = fakeImageBytes();
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      headers: { get: () => null },
      blob: async () => ({ size: fixed.byteLength, arrayBuffer: async () => fixed.slice(0) }),
    }));
    const url = 'https://cdn.example/dup.png';
    const [a, b, c] = await Promise.all([
      dispatch(req(MSG.ANALYZE_IMAGE, { url }), pageSender),
      dispatch(req(MSG.ANALYZE_IMAGE, { url }), pageSender),
      dispatch(req(MSG.ANALYZE_IMAGE, { url }), pageSender),
    ]);
    expect(a.ok && b.ok && c.ok).toBe(true);
    expect(offscreenCalls).toBe(1); // stampede collapsed to a single inference
  });

  it('returns a clean error for a malformed analyze request (no url)', async () => {
    const res = await dispatch(req(MSG.ANALYZE_IMAGE, {}), pageSender);
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('BAD_INPUT');
  });

  it('skips analysis on a site the user disabled', async () => {
    // Disable the host first.
    await dispatch(
      req(MSG.SET_SITE_ENABLED, { hostname: 'site.example', enabled: false }),
      pageSender,
    );
    const res = await dispatch(
      req(MSG.ANALYZE_IMAGE, { url: 'https://cdn.example/x.png' }),
      pageSender,
    );
    expect(res.ok).toBe(true);
    expect(res.result.skipped).toBe(true);
    expect(res.result.reason).toBe('site-disabled');
    expect(offscreenCalls).toBe(0);
  });

  it('recovers when the offscreen document fails once (recreate + retry)', async () => {
    // First ENSURE_READY fails (simulating a crashed offscreen doc); the SW should recreate
    // the document and retry, succeeding on the second attempt.
    let ensureAttempts = 0;
    let closeCalls = 0;
    chromeStub.chrome.offscreen.closeDocument = async () => {
      closeCalls++;
    };
    chromeStub.chrome.runtime.getContexts = async () => []; // after close, none remain
    chromeStub.chrome.runtime.sendMessage = async (msg) => {
      if (msg.type === MSG.OFFSCREEN_ENSURE_READY) {
        ensureAttempts++;
        if (ensureAttempts === 1) {
          return { id: msg.id, ok: false, error: { message: 'offscreen gone', code: 'NO_DOC' } };
        }
        return { id: msg.id, ok: true, result: { ep: 'wasm', variant: 'primary-int8' } };
      }
      if (msg.type === MSG.OFFSCREEN_ANALYZE) {
        offscreenCalls++;
        return {
          id: msg.id,
          ok: true,
          result: { score: 0.5, verdict: 'uncertain', reasons: [], ep: 'wasm', latencyMs: 1 },
        };
      }
      return { id: msg.id, ok: true, result: {} };
    };

    const res = await dispatch(
      req(MSG.ANALYZE_IMAGE, { url: 'https://cdn.example/recover.png' }),
      pageSender,
    );
    expect(res.ok).toBe(true);
    expect(ensureAttempts).toBe(2); // failed once, retried after recreate
    expect(closeCalls).toBeGreaterThan(0); // recovery closed the stale document
  });

  it('recovery clears cached manifest + rejected init promise (no stale reuse)', async () => {
    // Regression test for the recovery-state bug: after a failed warm-up, the retry must not
    // reuse the rejected initializingSession promise nor a stale cachedManifest.
    const { loadManifest } = await import('../../src/background/model-manager.js');
    let ensureAttempts = 0;
    chromeStub.chrome.offscreen.closeDocument = async () => {};
    chromeStub.chrome.runtime.getContexts = async () => [];
    chromeStub.chrome.runtime.sendMessage = async (msg) => {
      if (msg.type === MSG.OFFSCREEN_ENSURE_READY) {
        ensureAttempts++;
        // Fail the first attempt; succeed thereafter. The retry must carry a FRESH manifest
        // (loadManifest called again) — if the guard state weren't cleared, the retry would
        // reuse the rejected promise and never reach a second sendMessage.
        if (ensureAttempts === 1) {
          return { id: msg.id, ok: false, error: { message: 'dead', code: 'NO_DOC' } };
        }
        return { id: msg.id, ok: true, result: { ep: 'wasm', variant: 'primary-int8' } };
      }
      if (msg.type === MSG.OFFSCREEN_ANALYZE) {
        return {
          id: msg.id,
          ok: true,
          result: { score: 0.5, verdict: 'uncertain', reasons: [], ep: 'wasm', latencyMs: 1 },
        };
      }
      return { id: msg.id, ok: true, result: {} };
    };

    const res = await dispatch(
      req(MSG.ANALYZE_IMAGE, { url: 'https://cdn.example/recover2.png' }),
      pageSender,
    );
    expect(res.ok).toBe(true);
    expect(ensureAttempts).toBe(2);
    // A fresh manifest must be loaded for the retry (initial + re-load after recovery).
    expect(loadManifest.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
