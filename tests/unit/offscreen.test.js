/**
 * Unit tests for the offscreen orchestrator (src/offscreen/offscreen.js): message routing,
 * input validation on analyze(), and forensic→neural→fusion orchestration.
 *
 * The inference engine is mocked (vi.mock) so we test orchestration, not ONNX.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeStub } from '../helpers/dom-stub.js';
import { MSG } from '../../src/shared/constants.js';
import { isResponse } from '../../src/shared/protocol.js';

// Mock the heavy engine + forensic/fusion deps before importing the module under test.
vi.mock('../../src/offscreen/inference-engine.js', () => ({
  loadSession: vi.fn(async () => ({ ep: 'wasm', variant: 'primary-int8', warmMs: 5 })),
  engineStatus: vi.fn(() => ({ initialized: true, ep: 'wasm', variant: 'primary-int8' })),
  analyzeImageBytes: vi.fn(async () => ({
    score: 0.9,
    width: 256,
    height: 256,
    latencyMs: 3,
    ep: 'wasm',
  })),
  unloadSession: vi.fn(async () => {}),
}));
vi.mock('../../src/shared/metadata/forensic-extractor.js', () => ({
  extractForensicSignals: vi.fn(async () => ({
    definitive: false,
    summary: [],
    features: {},
  })),
}));

let chromeStub;
let listener;

/** Dispatch a request envelope to the registered offscreen listener, await the response. */
function dispatch(message) {
  return new Promise((resolve) => {
    const keepOpen = listener(message, { id: 'test-ext-id' }, (response) => resolve(response));
    // For sync paths (PING) the listener may have already responded.
    expect(keepOpen === true || keepOpen === false).toBe(true);
  });
}

function makeRequest(type, payload = {}) {
  return { id: `t-${Math.random()}`, type, target: 'offscreen', payload };
}

beforeEach(async () => {
  chromeStub?.cleanup();
  chromeStub = installChromeStub();
  chromeStub.chrome.runtime.onMessage.addListener = (fn) => {
    listener = fn;
  };
  vi.resetModules();
  await import('../../src/offscreen/offscreen.js');
});

describe('offscreen orchestrator', () => {
  it('ignores messages not targeted at the offscreen document', () => {
    const other = { id: 'x', type: MSG.PING, target: 'content', payload: {} };
    const keepOpen = listener(other, {}, () => {});
    expect(keepOpen).toBe(false);
  });

  it('responds to PING with a well-formed response envelope', async () => {
    const res = await dispatch(makeRequest(MSG.PING));
    expect(isResponse(res)).toBe(true);
    expect(res.ok).toBe(true);
    expect(res.result.context).toBe('offscreen');
    expect(res.result.engine.initialized).toBe(true);
  });

  it('OFFSCREEN_ENSURE_READY warms the session and returns engine status', async () => {
    const manifest = { variants: [{ kind: 'wasm', key: 'primary-int8' }] };
    const res = await dispatch(makeRequest(MSG.OFFSCREEN_ENSURE_READY, { manifest }));
    expect(res.ok).toBe(true);
    expect(res.result.ep).toBe('wasm');
    expect(res.result.engine.variant).toBe('primary-int8');
  });

  it('OFFSCREEN_ANALYZE rejects empty/missing bytes with BAD_INPUT', async () => {
    const res = await dispatch(makeRequest(MSG.OFFSCREEN_ANALYZE, { bytes: null }));
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('BAD_INPUT');
  });

  it('OFFSCREEN_ANALYZE fuses forensic + neural into a verdict', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
    const res = await dispatch(makeRequest(MSG.OFFSCREEN_ANALYZE, { bytes }));
    expect(res.ok).toBe(true);
    expect(typeof res.result.score).toBe('number');
    expect(res.result.verdict).toBeDefined();
    expect(res.result.neuralScore).toBe(0.9);
    expect(res.result.ep).toBe('wasm');
  });

  it('surfaces engine errors as an error response (not a throw)', async () => {
    const engine = await import('../../src/offscreen/inference-engine.js');
    engine.analyzeImageBytes.mockRejectedValueOnce(new Error('decode failed'));
    const bytes = new Uint8Array([9, 9]).buffer;
    const res = await dispatch(makeRequest(MSG.OFFSCREEN_ANALYZE, { bytes }));
    expect(res.ok).toBe(false);
    expect(res.error.message).toMatch(/decode failed/);
  });

  it('ignores unknown message types so other listeners can handle them', () => {
    const res = { id: 'z', type: 'not-a-real-type', target: 'offscreen', payload: {} };
    const keepOpen = listener(res, {}, () => {});
    expect(keepOpen).toBe(false);
  });
});
