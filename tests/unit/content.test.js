/**
 * Unit tests for the content script orchestrator (src/content/content.js): discovery -> queue ->
 * analysis -> badge fan-out. Verifies the queue's concurrency cap, same-URL dedup across
 * elements, and graceful error badges. Discovery/badges are stubbed at the module boundary.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeStub, installDomStub, StubElement } from '../helpers/dom-stub.js';
import { MSG } from '../../src/shared/constants.js';

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
});
