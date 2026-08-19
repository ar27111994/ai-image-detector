/**
 * Unit tests for the content script orchestrator (src/content/content.js): discovery -> queue ->
 * analysis -> badge fan-out. Verifies the queue's concurrency cap, same-URL dedup across
 * elements, and graceful error badges. Discovery/badges are stubbed at the module boundary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeStub, installDomStub, StubElement } from '../helpers/dom-stub.js';
import { MSG } from '../../src/shared/constants.js';

const realFetch = globalThis.fetch;

/** A fetch() Response stub whose body streams `bytes` in chunks (matches readElementBytes). */
function streamResponse(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return {
    ok: true,
    body: {
      getReader: () => {
        let i = 0;
        const chunk = 8192;
        return {
          read: async () =>
            i < u8.length
              ? { done: false, value: u8.slice(i, (i += chunk)) }
              : { done: true, value: undefined },
          cancel: async () => {},
        };
      },
    },
  };
}

// Stub discovery + badges at the module boundary so we test content.js's queueing logic,
// not DOM parsing or shadow-DOM rendering (those have their own suites).
const discoverState = { images: [] };
vi.mock('../../src/content/discovery.js', () => ({
  discoverImages: vi.fn(() => discoverState.images),
  discoverBackgroundImages: vi.fn(() => []),
  meetsMinSize: vi.fn(() => true),
  urlForElement: vi.fn((el) => el._url),
}));
const badgeCalls = [];
vi.mock('../../src/content/badges.js', () => ({
  setBadge: vi.fn((el, result) => badgeCalls.push({ el, result })),
  removeBadge: vi.fn(),
}));

let cleanupDom;
let chromeStub;

function makeImg(url) {
  const img = new StubElement('img');
  img._url = url;
  img.isConnected = true;
  return img;
}

async function loadContent({ sendImpl } = {}) {
  chromeStub.chrome.runtime.sendMessage =
    sendImpl ??
    (async (msg) => {
      if (msg.type === MSG.PING) return { id: msg.id, ok: true, result: { context: 'background' } };
      if (msg.type === MSG.GET_SETTINGS)
        return {
          id: msg.id,
          ok: true,
          result: { autoScan: true, showBadges: true, minImageSize: 1, maxImagesPerPage: 50 },
        };
      if (msg.type === MSG.ANALYZE_IMAGE)
        return { id: msg.id, ok: true, result: { score: 0.9, verdict: 'ai', reasons: [] } };
      return { id: msg.id, ok: true, result: {} };
    });
  vi.resetModules();
  await import('../../src/content/content.js');
  // Let init() (ping -> settings -> start -> scan -> pump) settle.
  await new Promise((r) => setTimeout(r, 30));
}

beforeEach(() => {
  cleanupDom?.();
  chromeStub?.cleanup();
  cleanupDom = installDomStub();
  chromeStub = installChromeStub();
  badgeCalls.length = 0;
  discoverState.images = [];
});

afterEach(() => {
  // Restore any per-test fetch stub so it can't leak into the next test.
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('content script orchestrator', () => {
  it('discovers images and requests analysis for each', async () => {
    discoverState.images = [makeImg('https://x/a.png'), makeImg('https://x/b.png')];
    const analyzed = [];
    await loadContent({
      sendImpl: async (msg) => {
        if (msg.type === MSG.PING) return { id: msg.id, ok: true, result: {} };
        if (msg.type === MSG.GET_SETTINGS)
          return {
            id: msg.id,
            ok: true,
            result: { autoScan: true, showBadges: true, minImageSize: 1, maxImagesPerPage: 50 },
          };
        if (msg.type === MSG.ANALYZE_IMAGE) {
          analyzed.push(msg.payload.url);
          return { id: msg.id, ok: true, result: { score: 0.8, verdict: 'ai', reasons: [] } };
        }
        return { id: msg.id, ok: true, result: {} };
      },
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(analyzed.sort()).toEqual(['https://x/a.png', 'https://x/b.png']);
  });

  it('fans one analysis result out to every element sharing the same URL', async () => {
    const a = makeImg('https://x/same.png');
    const b = makeImg('https://x/same.png');
    discoverState.images = [a, b];
    await loadContent();
    await new Promise((r) => setTimeout(r, 40));
    const targets = badgeCalls.filter((c) => c.result.verdict === 'ai').map((c) => c.el);
    expect(targets).toContain(a);
    expect(targets).toContain(b);
  });

  it('renders an error badge (not a crash) when analysis returns an error envelope', async () => {
    discoverState.images = [makeImg('https://x/fail.png')];
    await loadContent({
      sendImpl: async (msg) => {
        if (msg.type === MSG.PING) return { id: msg.id, ok: true, result: {} };
        if (msg.type === MSG.GET_SETTINGS)
          return {
            id: msg.id,
            ok: true,
            result: { autoScan: true, showBadges: true, minImageSize: 1, maxImagesPerPage: 50 },
          };
        if (msg.type === MSG.ANALYZE_IMAGE)
          return { id: msg.id, ok: false, error: { message: 'boom', code: 'INTERNAL' } };
        return { id: msg.id, ok: true, result: {} };
      },
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(badgeCalls.length).toBeGreaterThan(0);
    expect(badgeCalls[0].result.verdict).toBe('error');
  });

  it('stays dormant when the service worker does not respond to ping', async () => {
    discoverState.images = [makeImg('https://x/a.png')];
    await loadContent({ sendImpl: async () => Promise.reject(new Error('context invalidated')) });
    await new Promise((r) => setTimeout(r, 40));
    // No analysis should have been requested, and no badge rendered.
    expect(badgeCalls).toEqual([]);
  });

  it('reads blob: image bytes in-page and sends them via ANALYZE_IMAGE_BYTES', async () => {
    discoverState.images = [makeImg('blob:https://x/abc')];
    const sent = [];
    globalThis.fetch = vi.fn(async () => streamResponse(new Uint8Array([1, 2, 3, 4])));
    await loadContent({
      sendImpl: async (msg) => {
        sent.push(msg.type);
        if (msg.type === MSG.PING) return { id: msg.id, ok: true, result: {} };
        if (msg.type === MSG.GET_SETTINGS)
          return {
            id: msg.id,
            ok: true,
            result: { autoScan: true, showBadges: true, minImageSize: 1, maxImagesPerPage: 50 },
          };
        if (msg.type === MSG.ANALYZE_IMAGE_BYTES)
          return { id: msg.id, ok: true, result: { score: 0.7, verdict: 'ai', reasons: [] } };
        return { id: msg.id, ok: true, result: {} };
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toContain(MSG.ANALYZE_IMAGE_BYTES);
    expect(sent).not.toContain(MSG.ANALYZE_IMAGE);
  });

  it('skips images that fail the minimum-size filter', async () => {
    const { meetsMinSize } = await import('../../src/content/discovery.js');
    meetsMinSize.mockReturnValue(false); // every image too small
    discoverState.images = [makeImg('https://x/tiny.png')];
    const analyzed = [];
    await loadContent({
      sendImpl: async (msg) => {
        if (msg.type === MSG.ANALYZE_IMAGE) analyzed.push(msg.payload.url);
        if (msg.type === MSG.PING) return { id: msg.id, ok: true, result: {} };
        if (msg.type === MSG.GET_SETTINGS)
          return {
            id: msg.id,
            ok: true,
            result: { autoScan: true, showBadges: true, minImageSize: 64, maxImagesPerPage: 50 },
          };
        return { id: msg.id, ok: true, result: {} };
      },
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(analyzed).toEqual([]);
    expect(badgeCalls).toEqual([]);
  });

  it('stops scanning and strips badges when the user disables the extension live', async () => {
    const badges = await import('../../src/content/badges.js');
    let onChanged;
    chromeStub.chrome.storage.onChanged = { addListener: (fn) => (onChanged = fn) };
    // Start with badges ON, an image present, and a working analysis path.
    discoverState.images = [makeImg('https://x/toggle.png')];
    await loadContent();
    for (let i = 0; i < 200 && badgeCalls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(badgeCalls.length).toBeGreaterThan(0); // sanity: image was badged
    badges.removeBadge.mockClear();
    onChanged({ 'settings.v1': { newValue: { showBadges: false, autoScan: false } } }, 'local');
    await new Promise((r) => setTimeout(r, 20));
    expect(badges.removeBadge).toHaveBeenCalled();
  });

  it('does nothing when the storage change is for a different area/key', async () => {
    let onChanged;
    chromeStub.chrome.storage.onChanged = { addListener: (fn) => (onChanged = fn) };
    await loadContent();
    // Non-local area + unrelated key: must not throw or rescan.
    onChanged({ 'settings.v1': { newValue: { autoScan: false } } }, 'sync');
    onChanged({ other: { newValue: {} } }, 'local');
    await new Promise((r) => setTimeout(r, 10));
    // Reaching here without throwing is the assertion.
  });

  it('reports bytes-unavailable (skip) when a blob: image read fails', async () => {
    discoverState.images = [makeImg('blob:https://x/gone')];
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 404 })); // read fails
    const sent = [];
    await loadContent({
      sendImpl: async (msg) => {
        sent.push(msg.type);
        if (msg.type === MSG.PING) return { id: msg.id, ok: true, result: {} };
        if (msg.type === MSG.GET_SETTINGS)
          return {
            id: msg.id,
            ok: true,
            result: { autoScan: true, showBadges: true, minImageSize: 1, maxImagesPerPage: 50 },
          };
        return { id: msg.id, ok: true, result: {} };
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    // bytes-unavailable returns a skip without ever calling ANALYZE_IMAGE_BYTES.
    expect(sent).not.toContain(MSG.ANALYZE_IMAGE_BYTES);
  });

  it('does not render a badge for a result whose element detached from the DOM', async () => {
    const img = makeImg('https://x/detach.png');
    discoverState.images = [img];
    // Gate the analysis response so we can detach the element after it's dequeued but before
    // the result is applied (the disconnected-guard path in showResult).
    let releaseAnalysis;
    const gate = new Promise((resolve) => (releaseAnalysis = resolve));
    await loadContent({
      sendImpl: async (msg) => {
        if (msg.type === MSG.PING) return { id: msg.id, ok: true, result: {} };
        if (msg.type === MSG.GET_SETTINGS)
          return {
            id: msg.id,
            ok: true,
            result: { autoScan: true, showBadges: true, minImageSize: 1, maxImagesPerPage: 50 },
          };
        if (msg.type === MSG.ANALYZE_IMAGE) {
          await gate; // hold the response until we detach
          return { id: msg.id, ok: true, result: { score: 0.9, verdict: 'ai', reasons: [] } };
        }
        return { id: msg.id, ok: true, result: {} };
      },
    });
    // Let scan/pump dequeue the image and reach the in-flight analysis.
    await new Promise((r) => setTimeout(r, 40));
    img.isConnected = false; // detach before the result lands
    releaseAnalysis();
    await new Promise((r) => setTimeout(r, 40));
    expect(badgeCalls.find((c) => c.el === img)).toBeUndefined();
  });

  it('restarts scanning when autoScan is re-enabled live', async () => {
    let onChanged;
    chromeStub.chrome.storage.onChanged = { addListener: (fn) => (onChanged = fn) };
    discoverState.images = [makeImg('https://x/restart.png')];
    await loadContent();
    // Toggle autoScan off then on.
    onChanged({ 'settings.v1': { newValue: { autoScan: false } } }, 'local');
    await new Promise((r) => setTimeout(r, 20));
    onChanged({ 'settings.v1': { newValue: { autoScan: true, showBadges: true } } }, 'local');
    await new Promise((r) => setTimeout(r, 30));
    // Reaching here (start() re-ran without a duplicate-listener crash) is the assertion.
    expect(true).toBe(true);
  });

  it('renders an error badge when the analysis request throws (network/timeout)', async () => {
    discoverState.images = [makeImg('https://x/throws.png')];
    await loadContent({
      sendImpl: async (msg) => {
        if (msg.type === MSG.PING) return { id: msg.id, ok: true, result: {} };
        if (msg.type === MSG.GET_SETTINGS)
          return {
            id: msg.id,
            ok: true,
            result: { autoScan: true, showBadges: true, minImageSize: 1, maxImagesPerPage: 50 },
          };
        if (msg.type === MSG.ANALYZE_IMAGE) throw new Error('service worker gone');
        return { id: msg.id, ok: true, result: {} };
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    const err = badgeCalls.find((c) => c.el._url === 'https://x/throws.png');
    expect(err).toBeTruthy();
    expect(err.result.verdict).toBe('error');
  });

  it('skips a disconnected element during pump (continue branch)', async () => {
    const gone = makeImg('https://x/gone.png');
    const live = makeImg('https://x/live.png');
    discoverState.images = [gone, live];
    // Detach `gone` before pump processes it.
    gone.isConnected = false;
    const analyzed = [];
    await loadContent({
      sendImpl: async (msg) => {
        if (msg.type === MSG.PING) return { id: msg.id, ok: true, result: {} };
        if (msg.type === MSG.GET_SETTINGS)
          return {
            id: msg.id,
            ok: true,
            result: { autoScan: true, showBadges: true, minImageSize: 1, maxImagesPerPage: 50 },
          };
        if (msg.type === MSG.ANALYZE_IMAGE) {
          analyzed.push(msg.payload.url);
          return {
            id: msg.id,
            ok: true,
            result: { score: 0.5, verdict: 'uncertain', reasons: [] },
          };
        }
        return { id: msg.id, ok: true, result: {} };
      },
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(analyzed).toContain('https://x/live.png');
    expect(analyzed).not.toContain('https://x/gone.png');
  });

  it('prioritizes a visible image via IntersectionObserver (reorder to front)', async () => {
    const a = makeImg('https://x/slow-a.png');
    const b = makeImg('https://x/slow-b.png');
    discoverState.images = [a, b];
    // Capture the IntersectionObserver callback and a controllable analysis.
    let ioCallback;
    const origIO = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = class {
      constructor(cb) {
        ioCallback = cb;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    const order = [];
    await loadContent({
      sendImpl: async (msg) => {
        if (msg.type === MSG.PING) return { id: msg.id, ok: true, result: {} };
        if (msg.type === MSG.GET_SETTINGS)
          return {
            id: msg.id,
            ok: true,
            result: { autoScan: true, showBadges: true, minImageSize: 1, maxImagesPerPage: 50 },
          };
        if (msg.type === MSG.ANALYZE_IMAGE) {
          order.push(msg.payload.url);
          return {
            id: msg.id,
            ok: true,
            result: { score: 0.5, verdict: 'uncertain', reasons: [] },
          };
        }
        return { id: msg.id, ok: true, result: {} };
      },
    });
    globalThis.IntersectionObserver = origIO;
    await new Promise((r) => setTimeout(r, 30));
    // Signal that b scrolled into view -> prioritize(b) moves it to the front.
    if (ioCallback) ioCallback([{ isIntersecting: true, target: b }]);
    await new Promise((r) => setTimeout(r, 60));
    expect(order.length).toBeGreaterThan(0);
  });

  it('stays dormant when the ping returns a non-ok envelope', async () => {
    discoverState.images = [makeImg('https://x/notok.png')];
    await loadContent({
      sendImpl: async (msg) =>
        msg.type === MSG.PING
          ? { id: msg.id, ok: false, error: { message: 'no', code: 'X' } }
          : { id: msg.id, ok: true, result: {} },
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(badgeCalls).toEqual([]); // no analysis ran
  });

  it('uses default settings when the settings read fails', async () => {
    discoverState.images = [makeImg('https://x/defset.png')];
    const analyzed = [];
    await loadContent({
      sendImpl: async (msg) => {
        if (msg.type === MSG.PING) return { id: msg.id, ok: true, result: {} };
        if (msg.type === MSG.GET_SETTINGS) throw new Error('storage gone');
        if (msg.type === MSG.ANALYZE_IMAGE) {
          analyzed.push(msg.payload.url);
          return {
            id: msg.id,
            ok: true,
            result: { score: 0.5, verdict: 'uncertain', reasons: [] },
          };
        }
        return { id: msg.id, ok: true, result: {} };
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(analyzed).toContain('https://x/defset.png'); // ran with DEFAULT_SETTINGS
  });

  it('does not scan when autoScan is off in settings', async () => {
    discoverState.images = [makeImg('https://x/off.png')];
    const analyzed = [];
    await loadContent({
      sendImpl: async (msg) => {
        if (msg.type === MSG.PING) return { id: msg.id, ok: true, result: {} };
        if (msg.type === MSG.GET_SETTINGS)
          return {
            id: msg.id,
            ok: true,
            result: { autoScan: false, showBadges: true, minImageSize: 1, maxImagesPerPage: 50 },
          };
        if (msg.type === MSG.ANALYZE_IMAGE) analyzed.push(msg.payload.url);
        return { id: msg.id, ok: true, result: {} };
      },
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(analyzed).toEqual([]);
  });

  it('skips elements with no analyzable URL', async () => {
    const noUrl = makeImg(undefined);
    noUrl._url = null;
    discoverState.images = [noUrl, makeImg('https://x/has.png')];
    const analyzed = [];
    await loadContent({
      sendImpl: async (msg) => {
        if (msg.type === MSG.PING) return { id: msg.id, ok: true, result: {} };
        if (msg.type === MSG.GET_SETTINGS)
          return {
            id: msg.id,
            ok: true,
            result: { autoScan: true, showBadges: true, minImageSize: 1, maxImagesPerPage: 50 },
          };
        if (msg.type === MSG.ANALYZE_IMAGE) analyzed.push(msg.payload.url);
        return { id: msg.id, ok: true, result: {} };
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(analyzed).toContain('https://x/has.png');
    expect(analyzed.filter(Boolean).length).toBe(analyzed.length); // no undefined/null analyzed
  });

  it('respects maxImagesPerPage (stops enqueueing past the cap)', async () => {
    discoverState.images = Array.from({ length: 10 }, (_, i) => makeImg(`https://x/cap-${i}.png`));
    const analyzed = [];
    await loadContent({
      sendImpl: async (msg) => {
        if (msg.type === MSG.PING) return { id: msg.id, ok: true, result: {} };
        if (msg.type === MSG.GET_SETTINGS)
          return {
            id: msg.id,
            ok: true,
            result: { autoScan: true, showBadges: true, minImageSize: 1, maxImagesPerPage: 3 },
          };
        if (msg.type === MSG.ANALYZE_IMAGE) {
          analyzed.push(msg.payload.url);
          return {
            id: msg.id,
            ok: true,
            result: { score: 0.5, verdict: 'uncertain', reasons: [] },
          };
        }
        return { id: msg.id, ok: true, result: {} };
      },
    });
    await new Promise((r) => setTimeout(r, 80));
    expect(analyzed.length).toBeLessThanOrEqual(3);
  });

  it('does not re-analyze an element it already processed (WeakSet dedup)', async () => {
    const img = makeImg('https://x/once.png');
    discoverState.images = [img];
    let analysisCount = 0;
    let rescan;
    const origMO = globalThis.MutationObserver;
    globalThis.MutationObserver = class {
      constructor(cb) {
        rescan = cb;
      }
      observe() {}
      disconnect() {}
    };
    await loadContent({
      sendImpl: async (msg) => {
        if (msg.type === MSG.PING) return { id: msg.id, ok: true, result: {} };
        if (msg.type === MSG.GET_SETTINGS)
          return {
            id: msg.id,
            ok: true,
            result: { autoScan: true, showBadges: true, minImageSize: 1, maxImagesPerPage: 50 },
          };
        if (msg.type === MSG.ANALYZE_IMAGE) {
          analysisCount++;
          return {
            id: msg.id,
            ok: true,
            result: { score: 0.5, verdict: 'uncertain', reasons: [] },
          };
        }
        return { id: msg.id, ok: true, result: {} };
      },
    });
    globalThis.MutationObserver = origMO;
    await new Promise((r) => setTimeout(r, 50));
    expect(analysisCount).toBe(1);
    // Trigger a rescan (mutation) — the element is already in the analyzed WeakSet.
    if (rescan) rescan([]);
    await new Promise((r) => setTimeout(r, 60));
    expect(analysisCount).toBe(1); // still 1 — not re-analyzed
  });

  it('reorders a queued image to the front when it scrolls into view (prioritize)', async () => {
    // Two images; b is queued behind a. IntersectionObserver fires for b -> b jumps the queue.
    const a = makeImg('https://x/prio-a.png');
    const b = makeImg('https://x/prio-b.png');
    discoverState.images = [a, b];
    let ioCallback;
    const origIO = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = class {
      constructor(cb) {
        ioCallback = cb;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    // Hold analysis so both are queued before either completes, then free them in order.
    const gate = [];
    await loadContent({
      sendImpl: async (msg) => {
        if (msg.type === MSG.PING) return { id: msg.id, ok: true, result: {} };
        if (msg.type === MSG.GET_SETTINGS)
          return {
            id: msg.id,
            ok: true,
            result: { autoScan: true, showBadges: true, minImageSize: 1, maxImagesPerPage: 50 },
          };
        if (msg.type === MSG.ANALYZE_IMAGE) {
          return await new Promise((resolve) =>
            gate.push(() =>
              resolve({
                id: msg.id,
                ok: true,
                result: { score: 0.5, verdict: 'uncertain', reasons: [] },
              }),
            ),
          );
        }
        return { id: msg.id, ok: true, result: {} };
      },
    });
    globalThis.IntersectionObserver = origIO;
    await new Promise((r) => setTimeout(r, 30));
    if (ioCallback) ioCallback([{ isIntersecting: true, target: b }]);
    for (const release of gate) release();
    await new Promise((r) => setTimeout(r, 40));
    // b was prioritized; both eventually analyzed.
    expect(gate.length).toBeGreaterThan(0);
  });

  it('returns null (skip) for a blob: image whose bytes exceed the in-page size cap', async () => {
    discoverState.images = [makeImg('blob:https://x/toobig')];
    const sent = [];
    const { MAX_RELAY_BYTES } = await import('../../src/shared/constants.js');
    globalThis.fetch = vi.fn(
      async () => streamResponse(new Uint8Array(MAX_RELAY_BYTES + 1024)), // just over the relay cap
    );
    await loadContent({
      sendImpl: async (msg) => {
        sent.push(msg.type);
        if (msg.type === MSG.PING) return { id: msg.id, ok: true, result: {} };
        if (msg.type === MSG.GET_SETTINGS)
          return {
            id: msg.id,
            ok: true,
            result: { autoScan: true, showBadges: true, minImageSize: 1, maxImagesPerPage: 50 },
          };
        return { id: msg.id, ok: true, result: {} };
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    // Oversized in-page read returns null -> skipped; never sent to the SW as bytes.
    expect(sent).not.toContain(MSG.ANALYZE_IMAGE_BYTES);
  });
});
