/**
 * ONNX Runtime Web inference engine — runs inside the offscreen document.
 *
 * Lifecycle:
 *   1. configureOrt()        — set vendored wasm paths, single-thread (no SAB in extensions)
 *   2. loadSession(manifest) — adaptive EP selection: try webgpu (fp16) with a bounded self-test,
 *                              fall back to wasm (fp32); load weights from IndexedDB
 *   3. analyzeImage(bytes)   — decode -> preprocess -> infer -> { score, ... }
 *
 * All inference is local. No network access happens here.
 */
import * as ort from 'onnxruntime-web';
import { preprocessRgba } from '../shared/preprocess.js';
import { getModelBlob } from '../shared/model-store.js';
import { computeViewRects, meanLogits } from '../shared/tta.js';
import { clamp01, softmaxProbability } from '../shared/math.js';
import { sha256Hex } from '../shared/hash.js';
import { TIMEOUTS } from '../shared/constants.js';

/** Ordered EP preference; wasm is the guaranteed fallback. */
const EP_PREFERENCE = ['webgpu', 'wasm'];

/** Self-test time budget for the WebGPU probe (ms). If init+1 inference exceeds this, use WASM. */
const WEBGPU_PROBE_BUDGET_MS = TIMEOUTS.WEBGPU_PROBE_MS;

let configured = false;
let session = null;
let activeSpec = null;
let activeEp = null;
let initPromise = null;

/**
 * Point ORT at the vendored, version-locked wasm files. Must run before any session create.
 * Idempotent. @returns {void}
 */
export function configureOrt() {
  if (configured) return;
  const base = chrome.runtime.getURL('vendor/');
  ort.env.wasm.wasmPaths = {
    'ort-wasm-simd-threaded.jsep.wasm': `${base}ort-wasm-simd-threaded.jsep.wasm`,
    'ort-wasm-simd-threaded.wasm': `${base}ort-wasm-simd-threaded.wasm`,
    mjs: `${base}ort-wasm-simd-threaded.jsep.mjs`,
  };
  ort.env.wasm.numThreads = 1; // no SharedArrayBuffer in extension pages
  ort.env.wasm.proxy = false; // proxy workers use Blob URLs -> blocked by extension CSP
  ort.env.logLevel = 'warning';
  configured = true;
}

/**
 * Load (once) the model session. Adaptive EP: tries WebGPU first (fp16 variant), verifies with a
 * timed self-test, else WASM (fp32 variant). Concurrent callers share one init promise.
 *
 * @param {object} manifest models/manifest.json
 * @param {(ep:string) => Promise<object>} pickVariant returns manifest variant for an EP
 * @returns {Promise<{ ep: string, variant: string, warmMs: number }>}
 */
export async function loadSession(manifest, pickVariant) {
  if (session) return { ep: activeEp, variant: activeSpec.key, warmMs: 0 };
  if (initPromise) return await initPromise;
  initPromise = doLoad(manifest, pickVariant);
  try {
    return await initPromise;
  } finally {
    initPromise = null;
  }
}

async function doLoad(manifest, pickVariant) {
  configureOrt();
  let lastError = null;
  for (const ep of EP_PREFERENCE) {
    try {
      const variant = await pickVariant(ep);
      const blob = await getModelBlob(variant.key);
      if (!blob) throw new Error(`variant '${variant.key}' not downloaded`);
      const bytes = await blob.arrayBuffer();
      // Re-verify integrity at load (not just at download/persist): a corrupted or tampered
      // IndexedDB entry must never reach the inference session. The SHA-256 pin is authoritative.
      if (variant.sha256) {
        const actual = await sha256Hex(bytes);
        if (actual.toLowerCase() !== variant.sha256.toLowerCase()) {
          throw Object.assign(
            new Error(
              `model integrity check failed at load: expected ${variant.sha256}, got ${actual}`,
            ),
            { code: 'INTEGRITY' },
          );
        }
      }

      const t0 = performance.now();
      const created = await createSessionForEp(bytes, ep, variant);
      const warmMs = performance.now() - t0;
      session = created;
      activeSpec = variant;
      activeEp = ep;
      return { ep, variant: variant.key, warmMs: Math.round(warmMs) };
    } catch (err) {
      lastError = err;
      console.warn(`[inference] EP '${ep}' unavailable: ${err?.message ?? err}`);
      session = null;
      activeEp = null;
    }
  }
  throw new Error(`no usable execution provider (last error: ${lastError?.message})`);
}

async function createSessionForEp(bytes, ep, variant) {
  const opts = {
    executionProviders: [ep],
    graphOptimizationLevel: 'all',
    intraOpNumThreads: 1,
    freeDimensionOverrides: { batch_size: 1 },
  };
  const created = await ort.InferenceSession.create(bytes, opts);
  if (ep === 'webgpu') {
    // Self-test: one inference on a zero tensor, bounded in time. A GPU that hangs here must
    // not be trusted for production. If the probe rejects or times out, `created` is a live
    // session that is never assigned to the global `session` — release it here so the failed
    // WebGPU context doesn't leak GPU/native resources before we fall through to WASM.
    const size = variant.inputSize;
    const probe = new Float32Array(3 * size * size);
    const feeds = {
      [created.inputNames[0]]: new ort.Tensor('float32', probe, [1, 3, size, size]),
    };
    try {
      await runWithTimeout(created, feeds, WEBGPU_PROBE_BUDGET_MS);
    } catch (err) {
      await created.release().catch(() => {}); // release errors are non-fatal
      throw err;
    }
  }
  return created;
}

function runWithTimeout(sess, feeds, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`webgpu probe exceeded ${ms}ms`)), ms);
    sess.run(feeds).then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Decode + preprocess + run inference on image bytes.
 *
 * Patch aggregation: for images meaningfully larger than the model input, we score the full
 * frame AND a center + 4-corner crop grid, then average. Downscaling a large AI image to 224/256
 * washes out the high-frequency artifacts the detector relies on; crop patches preserve them.
 * (Robustness technique — see docs/ARCHITECTURE.md.)
 *
 * @param {ArrayBuffer} bytes encoded image (jpeg/png/webp/gif/avif)
 * @returns {Promise<{ score: number, rawOutput: number[], width: number, height: number, latencyMs: number, ep: string }>}
 */
export async function analyzeImageBytes(bytes) {
  if (!session || !activeSpec) throw new Error('inference session not initialized');
  const t0 = performance.now();

  const blob = new Blob([bytes]);
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch (err) {
    throw new Error(`image decode failed: ${err?.message ?? err}`);
  }

  try {
    const width = bitmap.width;
    const height = bitmap.height;

    const size = activeSpec.inputSize;
    // Multi-view TTA: full frame + center/corner crop grid for large images (shared logic).
    const rects = computeViewRects(width, height, size);
    const viewsLogits = [];
    for (const r of rects) {
      viewsLogits.push(await inferViewLogits(bitmap, r.sx, r.sy, r.sw, r.sh, size));
    }
    const mean = meanLogits(viewsLogits);
    const score = scoreFromOutput(mean, activeSpec);
    return {
      score,
      rawOutput: mean,
      width,
      height,
      latencyMs: Math.round(performance.now() - t0),
      ep: activeEp,
      views: rects.length,
    };
  } finally {
    bitmap.close(); // always release GPU memory, even on error
  }
}

/**
 * Render one source rect of the bitmap to the model input and return raw logits (NOT softmaxed).
 * Callers average logits across views, then map to a probability once via scoreFromOutput.
 * @param {ImageBitmap} bitmap decoded source image
 * @param {number} sx source-rect x
 * @param {number} sy source-rect y
 * @param {number} sw source-rect width
 * @param {number} sh source-rect height
 * @param {number} size model input edge (px)
 * @returns {Promise<number[]>} raw logits
 */
async function inferViewLogits(bitmap, sx, sy, sw, sh, size) {
  if (!session || !activeSpec) throw new Error('inference session not initialized');
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('failed to acquire 2D canvas context');
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, size, size);
  const imageData = ctx.getImageData(0, 0, size, size);
  const tensor = preprocessRgba(imageData.data, size, size, activeSpec);
  const feeds = { [session.inputNames[0]]: new ort.Tensor('float32', tensor.data, tensor.dims) };
  const results = await session.run(feeds);
  return Array.from(results[session.outputNames[0]].data);
}

/**
 * Map raw model output to an AI-probability score using the model's declared semantics.
 * @param {number[]} output raw model output (logits or a calibrated p_real scalar)
 * @param {object} spec model variant spec ({ outputType?, aiLogitIndex? })
 * @returns {number} AI probability in [0, 1]
 */
export function scoreFromOutput(output, spec) {
  if (spec.outputType === 'p_real') {
    return clamp01(1 - output[0]);
  }
  // 2-class logits; softmax the AI index (shared, numerically-stable implementation).
  return clamp01(softmaxProbability(output, spec.aiLogitIndex ?? 1));
}

/**
 * Current engine status (for diagnostics / popup).
 * @returns {{ initialized: boolean, ep: string|null, variant: string|null, inputSize: number|null }}
 */
export function engineStatus() {
  return {
    initialized: Boolean(session),
    ep: activeEp,
    variant: activeSpec?.key ?? null,
    inputSize: activeSpec?.inputSize ?? null,
  };
}

/**
 * Release the session (used when resetting or switching models). Safe to call when no session
 * is loaded. @returns {Promise<void>}
 */
export async function unloadSession() {
  if (session) {
    try {
      await session.release();
    } catch {
      /* release errors are non-fatal */
    }
  }
  session = null;
  activeSpec = null;
  activeEp = null;
}
