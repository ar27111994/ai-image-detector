/**
 * Offscreen document orchestrator: owns the inference engine and the analysis pipeline.
 * Only chrome.runtime messaging is available here (no other extension APIs).
 *
 * Messages handled (target='offscreen'):
 *   OFFSCREEN_ENSURE_READY  { manifest, variantKeys } -> warm session
 *   OFFSCREEN_ANALYZE       { contentHash, bytes(ArrayBuffer), mime } -> full analysis
 *   PING                    -> PONG
 */
import { MSG } from '../shared/constants.js';
import { isRequest, makeError, makeOk } from '../shared/protocol.js';
import * as engine from './inference-engine.js';
import { extractForensicSignals } from '../shared/metadata/forensic-extractor.js';
import { fuseSignals } from '../shared/fusion/fuse.js';

const OFFSCREEN_TARGET = 'offscreen';

function pickVariantFor(manifest) {
  return async (ep) => {
    const order = ep === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm', 'webgpu'];
    for (const kind of order) {
      const hit = manifest.variants.find((v) => v.kind === kind);
      if (hit) return hit;
    }
    return manifest.variants[0];
  };
}

async function ensureReady(payload) {
  const { manifest } = payload;
  const status = await engine.loadSession(manifest, pickVariantFor(manifest));
  return { ...status, engine: engine.engineStatus() };
}

async function analyze(payload) {
  const { bytes } = payload;
  if (!(bytes instanceof ArrayBuffer) || bytes.byteLength === 0) {
    throw Object.assign(new Error('analyze requires non-empty ArrayBuffer bytes'), {
      code: 'BAD_INPUT',
    });
  }
  // 1. Forensic/metadata layer (no neural cost). May short-circuit with a definitive verdict.
  const forensic = await extractForensicSignals(bytes);

  // 2. Neural inference.
  const neural = await engine.analyzeImageBytes(bytes);

  // 3. Fuse into a calibrated score.
  const fused = fuseSignals({ neuralScore: neural.score, forensic });

  return {
    score: fused.score,
    verdict: fused.verdict,
    reasons: fused.reasons,
    neuralScore: neural.score,
    forensic: forensic.summary,
    width: neural.width,
    height: neural.height,
    latencyMs: neural.latencyMs,
    ep: neural.ep,
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isRequest(message) || message.target !== OFFSCREEN_TARGET) return false;

  const respond = (promise) => {
    promise
      .then((result) => sendResponse(makeOk(message, result)))
      .catch((err) => {
        console.warn('[offscreen] handler error:', err?.message ?? err);
        sendResponse(makeError(message, err?.message ?? String(err), err?.code));
      });
    return true;
  };

  switch (message.type) {
    case MSG.PING:
      sendResponse(makeOk(message, { context: 'offscreen', engine: engine.engineStatus() }));
      return false;
    case MSG.OFFSCREEN_ENSURE_READY:
      return respond(ensureReady(message.payload));
    case MSG.OFFSCREEN_ANALYZE:
      return respond(analyze(message.payload));
    case MSG.OFFSCREEN_SHUTDOWN:
      return respond(engine.unloadSession().then(() => ({ unloaded: true })));
    default:
      return false;
  }
});
