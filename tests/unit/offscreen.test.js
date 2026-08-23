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
const neural = { score: 0.9 }; // tests can reassign before dispatching
vi.mock('../../src/offscreen/inference-engine.js', () => ({
  loadSession: vi.fn(async () => ({ ep: 'wasm', variant: 'primary-int8', warmMs: 5 })),
  engineStatus: vi.fn(() => ({ initialized: true, ep: 'wasm', variant: 'primary-int8' })),
  analyzeImageBytes: vi.fn(async () => ({
    score: neural.score,
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
  neural.score = 0.9; // reset any per-test override
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

  it('a definitive forensic signal short-circuits neural inference (no analyzeImageBytes call)', async () => {
    const engine = await import('../../src/offscreen/inference-engine.js');
    const { extractForensicSignals } =
      await import('../../src/shared/metadata/forensic-extractor.js');
    extractForensicSignals.mockResolvedValueOnce({
      definitive: true,
      summary: ['c2pa:manifest-store present'],
      features: { c2paPresent: true },
    });
    engine.analyzeImageBytes.mockClear();
    const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
    const res = await dispatch(makeRequest(MSG.OFFSCREEN_ANALYZE, { bytes }));
    expect(res.ok).toBe(true);
    expect(res.result.verdict).toBe('ai'); // definitive forensic verdict
    expect(res.result.score).toBe(0.99);
    expect(res.result.forensicOnly).toBe(true);
    expect(engine.analyzeImageBytes).not.toHaveBeenCalled(); // neural inference skipped
    // Consumers must handle the absent neural fields (null, not undefined-missing).
    expect(res.result.neuralScore).toBeNull();
    expect(res.result.ep).toBeNull();
  });

  it('OFFSCREEN_ANALYZE applies the user-configurable threshold to the verdict', async () => {
    const { CALIBRATION } = await import('../../src/shared/fusion/calibration.js');
    const { verdictFor } = await import('../../src/shared/fusion/fuse.js');
    const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
    // The calibration curve is recall-heavy; neural 0.1 calibrates to ~0.868, which is 'ai' at the
    // default 0.65 but 'uncertain' at a raised 0.95 threshold — a genuinely flippable point.
    neural.score = 0.1;
    const calibrateScore = (n) =>
      1 / (1 + Math.exp(-(CALIBRATION.a * Math.log(n / (1 - n)) + CALIBRATION.b)));
    const score = calibrateScore(0.1);
    expect(verdictFor(score, 0.65)).toBe('ai');
    expect(verdictFor(score, 0.95)).not.toBe('ai');

    const dflt = await dispatch(makeRequest(MSG.OFFSCREEN_ANALYZE, { bytes }));
    expect(dflt.result.score).toBeCloseTo(score, 6);
    expect(dflt.result.verdict).toBe('ai'); // default 0.65

    const res = await dispatch(makeRequest(MSG.OFFSCREEN_ANALYZE, { bytes, threshold: 0.95 }));
    expect(res.ok).toBe(true);
    expect(res.result.score).toBeCloseTo(score, 6);
    expect(res.result.verdict).toBe(verdictFor(score, 0.95));
    expect(res.result.verdict).not.toBe(dflt.result.verdict); // threshold actually applied
  });

  it('OFFSCREEN_ANALYZE accepts the structured-clone { data: number[] } byte relay form', async () => {
    // The content->SW relay sends { data: number[] }; the offscreen must reconstruct a buffer from
    // it (the analysis path must not depend on ArrayBuffer surviving message transport).
    const res = await dispatch(
      makeRequest(MSG.OFFSCREEN_ANALYZE, { bytes: { data: [1, 2, 3, 4] } }),
    );
    expect(res.ok).toBe(true);
    expect(res.result.score).toBeDefined();
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
