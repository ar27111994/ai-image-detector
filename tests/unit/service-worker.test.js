/**
 * Unit tests for the service-worker message router (src/background/service-worker.js).
 * Focus: sender authorization (isExtensionContext) and analysis-result caching + concurrent
 * dedup (cache-stampede protection). The offscreen boundary is mocked at the protocol layer
 * (chrome.runtime.sendMessage), and model-manager at the module layer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeStub } from '../helpers/dom-stub.js';
import { MSG, TIMEOUTS } from '../../src/shared/constants.js';

// Model manager: report ready, no real IndexedDB/network.
vi.mock('../../src/background/model-manager.js', () => ({
  isModelReady: vi.fn(async () => true),
  getModelState: vi.fn(async () => ({ status: 'ready', progress: 1 })),
  loadManifest: vi.fn(async () => ({ variants: [{ kind: 'wasm', key: 'primary-int8' }] })),
  ensureModel: vi.fn(async () => ({ alreadyReady: true })),
}));

// Model store: the SW's resetModel() imports it dynamically to clear the store.
vi.mock('../../src/shared/model-store.js', () => ({
  clearModelStore: vi.fn(async () => {}),
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

  it('rejects an oversized image by content-length before reading the body', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      headers: { get: () => String(64 * 1024 * 1024) }, // 64MB > 32MB cap
      blob: async () => ({ size: 64 * 1024 * 1024, arrayBuffer: async () => new ArrayBuffer(8) }),
    }));
    const res = await dispatch(
      req(MSG.ANALYZE_IMAGE, { url: 'https://cdn.example/huge.png' }),
      pageSender,
    );
    expect(res.ok).toBe(false);
    expect(res.error.message).toMatch(/too large/);
    expect(offscreenCalls).toBe(0);
  });

  it('rejects an oversized image by actual blob size (no content-length)', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      headers: { get: () => null },
      blob: async () => ({ size: 64 * 1024 * 1024, arrayBuffer: async () => new ArrayBuffer(8) }),
    }));
    const res = await dispatch(
      req(MSG.ANALYZE_IMAGE, { url: 'https://cdn.example/huge2.png' }),
      pageSender,
    );
    expect(res.ok).toBe(false);
    expect(res.error.message).toMatch(/too large/);
  });

  it('skips data:/blob: URLs on the by-url path (bytes required instead)', async () => {
    const res = await dispatch(
      req(MSG.ANALYZE_IMAGE, { url: 'data:image/png;base64,AAAA' }),
      pageSender,
    );
    expect(res.ok).toBe(true);
    expect(res.result.skipped).toBe(true);
    expect(res.result.reason).toBe('bytes-required');
  });

  it('handles a fetch HTTP error as a clean error envelope', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 404,
      headers: { get: () => null },
    }));
    const res = await dispatch(
      req(MSG.ANALYZE_IMAGE, { url: 'https://cdn.example/missing.png' }),
      pageSender,
    );
    expect(res.ok).toBe(false);
    expect(res.error.message).toMatch(/HTTP 404/);
  });

  it('analyzes raw bytes sent by the content script (ANALYZE_IMAGE_BYTES)', async () => {
    const bytes = fakeImageBytes();
    const res = await dispatch(
      req(MSG.ANALYZE_IMAGE_BYTES, { bytes: { data: Array.from(new Uint8Array(bytes)) } }),
      pageSender,
    );
    expect(res.ok).toBe(true);
    expect(res.result.verdict).toBe('ai');
    expect(offscreenCalls).toBe(1);
  });

  it('rejects ANALYZE_IMAGE_BYTES with no bytes (BAD_INPUT)', async () => {
    const res = await dispatch(req(MSG.ANALYZE_IMAGE_BYTES, {}), pageSender);
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('BAD_INPUT');
  });

  it('MODEL_DOWNLOAD_START delegates to model-manager.ensureModel', async () => {
    const { ensureModel } = await import('../../src/background/model-manager.js');
    ensureModel.mockClear();
    const res = await dispatch(req(MSG.MODEL_DOWNLOAD_START), pageSender);
    expect(res.ok).toBe(true);
    expect(ensureModel).toHaveBeenCalled();
  });

  it('concurrent MODEL_DOWNLOAD_START calls share one in-flight ensureModel', async () => {
    const { ensureModel } = await import('../../src/background/model-manager.js');
    // Hold the download open so both dispatches overlap (a timed-out onboarding retry while the
    // first download is still running must not start a second 311MB acquisition).
    let release;
    ensureModel.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ key: 'primary-int8', bytes: 311000000, verified: true });
        }),
    );
    ensureModel.mockClear();

    const p1 = dispatch(req(MSG.MODEL_DOWNLOAD_START), pageSender);
    const p2 = dispatch(req(MSG.MODEL_DOWNLOAD_START), pageSender);
    release();
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    // One shared operation: both callers resolve with the same result, ensureModel ran once.
    expect(ensureModel).toHaveBeenCalledTimes(1);
    expect(r1.result).toEqual(r2.result);
  });

  it('a stalled download times out and a retry starts a fresh ensureModel', async () => {
    const { ensureModel } = await import('../../src/background/model-manager.js');
    vi.useFakeTimers();
    try {
      // First download never settles (a stalled fetch stream) — the SW operation hangs.
      ensureModel.mockImplementationOnce(() => new Promise(() => {}));
      ensureModel.mockClear();

      const p1 = dispatch(req(MSG.MODEL_DOWNLOAD_START), pageSender);
      // Let the handler register the in-flight (timed) promise, then fire the deadline.
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(TIMEOUTS.MODEL_DOWNLOAD_MS + 1);
      const r1 = await p1;
      expect(r1.ok).toBe(false);
      expect(r1.error.code).toBe('TIMEOUT');

      // Retry: must NOT await the stuck promise — it clears and starts a replacement download.
      vi.useRealTimers();
      ensureModel.mockImplementation(async () => ({ alreadyReady: true }));
      const r2 = await dispatch(req(MSG.MODEL_DOWNLOAD_START), pageSender);
      expect(r2.ok).toBe(true);
      expect(ensureModel).toHaveBeenCalledTimes(2); // stalled + replacement
    } finally {
      vi.useRealTimers();
    }
  });

  it('MODEL_DOWNLOAD_STATUS returns the model state', async () => {
    const res = await dispatch(req(MSG.MODEL_DOWNLOAD_STATUS), pageSender);
    expect(res.ok).toBe(true);
    expect(res.result.status).toBe('ready');
  });

  it('GET_TAB_STATS returns per-tab tallies after an analysis', async () => {
    const fixed = fakeImageBytes();
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      headers: { get: () => null },
      blob: async () => ({ size: 16, arrayBuffer: async () => fixed.slice(0) }),
    }));
    await dispatch(req(MSG.ANALYZE_IMAGE, { url: 'https://cdn.example/stat.png' }), pageSender);
    const res = await dispatch(req(MSG.GET_TAB_STATS, { tabId: 1 }), pageSender);
    expect(res.ok).toBe(true);
    expect(res.result.analyzed).toBeGreaterThanOrEqual(1);
    expect(res.result.ai).toBeGreaterThanOrEqual(1);
  });

  it('MODEL_RESET clears the model store and resets state', async () => {
    // resetModel imports model-store dynamically; stub it via the real module path.
    const res = await dispatch(req(MSG.MODEL_RESET), pageSender);
    expect(res.ok).toBe(true);
    expect(res.result.reset).toBe(true);
  });

  it('opens the onboarding page on first install when the model is not ready', async () => {
    const { isModelReady } = await import('../../src/background/model-manager.js');
    isModelReady.mockResolvedValueOnce(false);
    const created = [];
    chromeStub.chrome.tabs.create = async (t) => created.push(t);
    let installedHandler;
    chromeStub.chrome.runtime.onInstalled = { addListener: (fn) => (installedHandler = fn) };
    vi.resetModules();
    await import('../../src/background/service-worker.js');
    await installedHandler({ reason: 'install' });
    expect(created.length).toBe(1);
    expect(String(created[0].url)).toContain('onboarding.html');
  });

  it('aggregates stats across tabs when GET_TAB_STATS is called without a tabId', async () => {
    // Use the bytes path with distinct content per tab so each is a fresh analysis (not a
    // content-hash cache hit shared across tabs).
    const mkBytes = () => ({ data: Array.from(new Uint8Array(fakeImageBytes())) });
    const r1 = await dispatch(req(MSG.ANALYZE_IMAGE_BYTES, { bytes: mkBytes() }), pageSender);
    const r2 = await dispatch(req(MSG.ANALYZE_IMAGE_BYTES, { bytes: mkBytes() }), {
      ...pageSender,
      tab: { id: 2 },
    });
    expect(r1.ok && r2.ok).toBe(true);
    // Aggregate path: no sender.tab and no payload.tabId -> sum across all tabs.
    const res = await dispatch(req(MSG.GET_TAB_STATS, {}), { id: 'test-ext-id' });
    expect(res.ok).toBe(true);
    expect(res.result.analyzed).toBeGreaterThanOrEqual(2);
  });

  it("resets a tab's stats when the tab reloads (onUpdated loading)", async () => {
    const fixed = fakeImageBytes();
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      headers: { get: () => null },
      blob: async () => ({ size: 16, arrayBuffer: async () => fixed.slice(0) }),
    }));
    let updatedHandler;
    chromeStub.chrome.tabs.onUpdated = { addListener: (fn) => (updatedHandler = fn) };
    vi.resetModules();
    await import('../../src/background/service-worker.js');
    await dispatch(req(MSG.ANALYZE_IMAGE, { url: 'https://cdn.example/reload.png' }), pageSender);
    let res = await dispatch(req(MSG.GET_TAB_STATS, { tabId: 1 }), pageSender);
    expect(res.result.analyzed).toBeGreaterThanOrEqual(1);
    // Fire the tab-reload listener -> stats reset.
    updatedHandler(1, { status: 'loading' });
    res = await dispatch(req(MSG.GET_TAB_STATS, { tabId: 1 }), pageSender);
    expect(res.result.analyzed).toBe(0);
  });

  it("drops a closed tab's stats (onRemoved)", async () => {
    const fixed = fakeImageBytes();
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      headers: { get: () => null },
      blob: async () => ({ size: 16, arrayBuffer: async () => fixed.slice(0) }),
    }));
    let removedHandler;
    chromeStub.chrome.tabs.onRemoved = { addListener: (fn) => (removedHandler = fn) };
    vi.resetModules();
    await import('../../src/background/service-worker.js');
    await dispatch(req(MSG.ANALYZE_IMAGE, { url: 'https://cdn.example/close.png' }), pageSender);
    let res = await dispatch(req(MSG.GET_TAB_STATS, { tabId: 1 }), pageSender);
    expect(res.result.analyzed).toBeGreaterThanOrEqual(1);
    removedHandler(1);
    res = await dispatch(req(MSG.GET_TAB_STATS, { tabId: 1 }), pageSender);
    expect(res.result.analyzed).toBe(0);
  });

  it('does NOT open onboarding on install when the model is already ready', async () => {
    const created = [];
    chromeStub.chrome.tabs.create = async (t) => created.push(t);
    let installedHandler;
    chromeStub.chrome.runtime.onInstalled = { addListener: (fn) => (installedHandler = fn) };
    vi.resetModules();
    await import('../../src/background/service-worker.js');
    await installedHandler({ reason: 'install' }); // isModelReady() is true by default
    expect(created.length).toBe(0);
  });

  it('rejects a sender with a foreign id even when it has a tab', async () => {
    const res = await dispatch(req(MSG.GET_STATUS), {
      id: 'evil-ext',
      url: 'https://evil.test/',
      tab: { id: 9 },
    });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('FORBIDDEN');
  });

  it('rejects a sender with a foreign origin and no tab', async () => {
    const res = await dispatch(req(MSG.GET_STATUS), {
      id: 'test-ext-id',
      origin: 'https://not-us.example',
    });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('FORBIDDEN');
  });

  it('accepts a same-origin extension page (no tab)', async () => {
    const res = await dispatch(req(MSG.PING), {
      id: 'test-ext-id',
      url: 'chrome-extension://test-ext-id/pages/options.html',
    });
    expect(res.ok).toBe(true);
  });

  it('rejects a message with no sender', async () => {
    const res = await dispatch(req(MSG.PING), null);
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('FORBIDDEN');
  });

  it('ignores non-envelope messages entirely (no sendResponse)', async () => {
    let responded = false;
    const keepOpen = listener({ notAnEnvelope: true }, pageSender, () => (responded = true));
    expect(keepOpen).toBe(false);
    expect(responded).toBe(false);
  });

  it('creates the offscreen document when none exists (getContexts empty)', async () => {
    chromeStub.chrome.runtime.getContexts = async () => []; // no existing doc
    let created = 0;
    chromeStub.chrome.offscreen.createDocument = async () => {
      created++;
    };
    vi.resetModules();
    await import('../../src/background/service-worker.js');
    const res = await dispatch(
      req(MSG.ANALYZE_IMAGE_BYTES, {
        bytes: { data: Array.from(new Uint8Array(fakeImageBytes())) },
      }),
      pageSender,
    );
    expect(res.ok).toBe(true);
    expect(created).toBeGreaterThanOrEqual(1);
  });

  it('returns MODEL_NOT_READY when analysis is requested before setup', async () => {
    const { isModelReady } = await import('../../src/background/model-manager.js');
    isModelReady.mockResolvedValueOnce(false);
    const res = await dispatch(
      req(MSG.ANALYZE_IMAGE_BYTES, {
        bytes: { data: Array.from(new Uint8Array(fakeImageBytes())) },
      }),
      pageSender,
    );
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('MODEL_NOT_READY');
  });

  it('surfaces an offscreen failure response (not-ok) as an error after recovery also fails', async () => {
    // Both the initial warm-up AND the post-recovery retry fail -> error propagates.
    chromeStub.chrome.offscreen.closeDocument = async () => {};
    chromeStub.chrome.runtime.getContexts = async () => [];
    chromeStub.chrome.runtime.sendMessage = async (msg) => {
      if (msg.type === MSG.OFFSCREEN_ENSURE_READY) {
        return { id: msg.id, ok: false, error: { message: 'engine dead', code: 'ENGINE' } };
      }
      return { id: msg.id, ok: true, result: {} };
    };
    const res = await dispatch(
      req(MSG.ANALYZE_IMAGE_BYTES, {
        bytes: { data: Array.from(new Uint8Array(fakeImageBytes())) },
      }),
      pageSender,
    );
    expect(res.ok).toBe(false);
    expect(res.error.message).toMatch(/engine dead|init failed/i);
  });

  it('dedupes concurrent offscreen-document creation into one create call', async () => {
    // No existing doc; two concurrent analyses must share one createDocument.
    chromeStub.chrome.runtime.getContexts = async () => [];
    let created = 0;
    chromeStub.chrome.offscreen.createDocument = async () => {
      created++;
      await new Promise((r) => setTimeout(r, 10)); // hold creation so the 2nd caller overlaps
    };
    vi.resetModules();
    await import('../../src/background/service-worker.js');
    const bytes = () => ({ data: Array.from(new Uint8Array(fakeImageBytes())) });
    await Promise.all([
      dispatch(req(MSG.ANALYZE_IMAGE_BYTES, { bytes: bytes() }), pageSender),
      dispatch(req(MSG.ANALYZE_IMAGE_BYTES, { bytes: bytes() }), pageSender),
    ]);
    expect(created).toBe(1);
  });

  it('tallies each verdict class into tab stats (ai/real/uncertain/error)', async () => {
    // Drive four analyses with distinct bytes, each returning a different verdict.
    const verdicts = ['ai', 'real', 'uncertain', 'error'];
    let i = 0;
    chromeStub.chrome.runtime.sendMessage = async (msg) => {
      if (msg.type === MSG.OFFSCREEN_ENSURE_READY) {
        return { id: msg.id, ok: true, result: { ep: 'wasm', variant: 'primary-int8' } };
      }
      if (msg.type === MSG.OFFSCREEN_ANALYZE) {
        const v = verdicts[i++ % verdicts.length];
        return {
          id: msg.id,
          ok: true,
          result: { score: 0.5, verdict: v, reasons: [], ep: 'wasm', latencyMs: 1 },
        };
      }
      return { id: msg.id, ok: true, result: {} };
    };
    for (let k = 0; k < 4; k++) {
      await dispatch(
        req(MSG.ANALYZE_IMAGE_BYTES, {
          bytes: { data: Array.from(new Uint8Array(fakeImageBytes())) },
        }),
        pageSender,
      );
    }
    const res = await dispatch(req(MSG.GET_TAB_STATS, { tabId: 1 }), pageSender);
    expect(res.ok).toBe(true);
    expect(res.result.analyzed).toBe(4);
    expect(res.result.ai + res.result.real + res.result.uncertain + res.result.error).toBe(4);
  });

  it('does not record stats for a skipped result', async () => {
    await dispatch(
      req(MSG.SET_SITE_ENABLED, { hostname: 'site.example', enabled: false }),
      pageSender,
    );
    await dispatch(
      req(MSG.ANALYZE_IMAGE, { url: 'https://cdn.example/skip.png' }),
      pageSender, // site disabled -> skipped
    );
    const res = await dispatch(req(MSG.GET_TAB_STATS, { tabId: 1 }), pageSender);
    expect(res.result.analyzed).toBe(0);
  });

  it('setSiteEnabled uses the sender URL hostname when payload omits hostname', async () => {
    const res = await dispatch(req(MSG.SET_SITE_ENABLED, { enabled: false }), {
      id: 'test-ext-id',
      url: 'https://host-from-sender.example/page',
      tab: { id: 3 },
    });
    expect(res.ok).toBe(true);
    // The rule should now exist for the sender-derived host.
    const { loadSiteRules } = await import('../../src/shared/settings.js');
    const rules = await loadSiteRules();
    expect(rules['host-from-sender.example']).toBe(false);
  });

  it('setSiteEnabled errors when no hostname can be derived', async () => {
    const res = await dispatch(
      req(MSG.SET_SITE_ENABLED, { enabled: true }),
      { id: 'test-ext-id' }, // no url, no payload.hostname
    );
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('BAD_INPUT');
  });

  it('GET_STATUS reports model state + readiness + cache size', async () => {
    const res = await dispatch(req(MSG.GET_STATUS), pageSender);
    expect(res.ok).toBe(true);
    expect(res.result.ready).toBe(true);
    expect(res.result.model.status).toBe('ready');
    expect(typeof res.result.cacheSize).toBe('number');
  });

  it('surfaces an offscreen ANALYZE error (not-ok response) as an error envelope', async () => {
    chromeStub.chrome.runtime.sendMessage = async (msg) => {
      if (msg.type === MSG.OFFSCREEN_ENSURE_READY) {
        return { id: msg.id, ok: true, result: { ep: 'wasm', variant: 'primary-int8' } };
      }
      if (msg.type === MSG.OFFSCREEN_ANALYZE) {
        return { id: msg.id, ok: false, error: { message: 'inference blew up', code: 'INFER' } };
      }
      return { id: msg.id, ok: true, result: {} };
    };
    const res = await dispatch(
      req(MSG.ANALYZE_IMAGE_BYTES, {
        bytes: { data: Array.from(new Uint8Array(fakeImageBytes())) },
      }),
      pageSender,
    );
    expect(res.ok).toBe(false);
    expect(res.error.message).toMatch(/inference blew up/);
  });

  it('handles the browser-startup hook without throwing', async () => {
    let startupHandler;
    chromeStub.chrome.runtime.onStartup = { addListener: (fn) => (startupHandler = fn) };
    vi.resetModules();
    await import('../../src/background/service-worker.js');
    expect(() => startupHandler()).not.toThrow();
  });

  it('survives a 50-image concurrent stampede with no lost results or duplicate inferences', async () => {
    // 50 unique images analyzed concurrently. Each unique content must infer exactly once
    // (dedup by content hash), and every caller must get a result (none dropped).
    const N = 50;
    let inferCount = 0;
    chromeStub.chrome.runtime.sendMessage = async (msg) => {
      if (msg.type === MSG.OFFSCREEN_ENSURE_READY) {
        return { id: msg.id, ok: true, result: { ep: 'wasm', variant: 'primary-int8' } };
      }
      if (msg.type === MSG.OFFSCREEN_ANALYZE) {
        inferCount++;
        await new Promise((r) => setTimeout(r, 2)); // small async latency
        return {
          id: msg.id,
          ok: true,
          result: { score: 0.9, verdict: 'ai', reasons: [], ep: 'wasm', latencyMs: 1 },
        };
      }
      return { id: msg.id, ok: true, result: {} };
    };
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        dispatch(
          req(MSG.ANALYZE_IMAGE_BYTES, {
            bytes: { data: Array.from(new Uint8Array(fakeImageBytes())) },
          }),
          pageSender,
        ),
      ),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(inferCount).toBe(N); // unique content -> one inference each (no false dedup)
    const stats = await dispatch(req(MSG.GET_TAB_STATS, { tabId: 1 }), pageSender);
    expect(stats.result.analyzed).toBe(N);
  });

  it('collapses a same-image burst into a single inference (stampede protection)', async () => {
    // The SAME image requested 50 times concurrently must infer ONCE (cache-stampede guard).
    const fixed = fakeImageBytes();
    const mk = () => ({ data: Array.from(new Uint8Array(fixed)) });
    let inferCount = 0;
    chromeStub.chrome.runtime.sendMessage = async (msg) => {
      if (msg.type === MSG.OFFSCREEN_ENSURE_READY) {
        return { id: msg.id, ok: true, result: { ep: 'wasm', variant: 'primary-int8' } };
      }
      if (msg.type === MSG.OFFSCREEN_ANALYZE) {
        inferCount++;
        await new Promise((r) => setTimeout(r, 5));
        return {
          id: msg.id,
          ok: true,
          result: { score: 0.9, verdict: 'ai', reasons: [], ep: 'wasm', latencyMs: 1 },
        };
      }
      return { id: msg.id, ok: true, result: {} };
    };
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        dispatch(req(MSG.ANALYZE_IMAGE_BYTES, { bytes: mk() }), pageSender),
      ),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(inferCount).toBe(1); // 50 concurrent identical -> 1 inference
  });
});
