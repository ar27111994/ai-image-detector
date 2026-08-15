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

/** Ordered EP preference; wasm is the guaranteed fallback. */
const EP_PREFERENCE = ['webgpu', 'wasm'];

/** Self-test time budget for the WebGPU probe (ms). If init+1 inference exceeds this, use WASM. */
const WEBGPU_PROBE_BUDGET_MS = 8000;

let configured = false;
let session = null;
let activeSpec = null;
let activeEp = null;
let initPromise = null;

/** Point ORT at the vendored, version-locked wasm files. Must run before any session create. */
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
    // not be trusted for production.
    const size = variant.inputSize;
    const probe = new Float32Array(3 * size * size);
    const feeds = {
      [created.inputNames[0]]: new ort.Tensor('float32', probe, [1, 3, size, size]),
    };
    await runWithTimeout(created, feeds, WEBGPU_PROBE_BUDGET_MS);
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
    const scores = [];

    // Full-frame view (always).
    scores.push(await inferView(bitmap, 0, 0, width, height, size));

    // Patch grid when the source is large enough that downscaling would dominate.
    const minDim = Math.min(width, height);
    if (minDim >= size * 2) {
      const crop = Math.floor(minDim * 0.5); // 50% crops
      const halfW = Math.floor((crop * (width / minDim)) / 2) * 2;
      const halfH = Math.floor((crop * (height / minDim)) / 2) * 2;
      const offsets = [
        [0, 0],
        [width - halfW, 0],
        [0, height - halfH],
        [width - halfW, height - halfH],
        [Math.floor((width - halfW) / 2), Math.floor((height - halfH) / 2)],
      ];
      for (const [ox, oy] of offsets) {
        scores.push(await inferView(bitmap, ox, oy, halfW, halfH, size));
      }
    }

    const score = scores.reduce((a, b) => a + b, 0) / scores.length;
    return {
      score,
      rawOutput: scores,
      width,
      height,
      latencyMs: Math.round(performance.now() - t0),
      ep: activeEp,
      views: scores.length,
    };
  } finally {
    bitmap.close(); // always release GPU memory, even on error
  }
}

/** Render one source rect of the bitmap to the model input and run inference. */
async function inferView(bitmap, sx, sy, sw, sh, size) {
  if (!session || !activeSpec) throw new Error('inference session not initialized');
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('failed to acquire 2D canvas context');
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, size, size);
  const imageData = ctx.getImageData(0, 0, size, size);
  const tensor = preprocessRgba(imageData.data, size, size, activeSpec);
  const feeds = { [session.inputNames[0]]: new ort.Tensor('float32', tensor.data, tensor.dims) };
  const results = await session.run(feeds);
  const output = Array.from(results[session.outputNames[0]].data);
  return scoreFromOutput(output, activeSpec);
}

/**
 * Map raw model output to an AI-probability score using the model's declared semantics.
 * @param {number[]} output
 * @param {object} spec
 */
export function scoreFromOutput(output, spec) {
  if (spec.outputType === 'p_real') {
    return clamp01(1 - output[0]);
  }
  // 2-class logits; softmax the AI index.
  const aiIdx = spec.aiLogitIndex ?? 1;
  const otherIdx = aiIdx === 0 ? 1 : 0;
  const a = output[aiIdx];
  const b = output[otherIdx];
  const m = Math.max(a, b);
  const ea = Math.exp(a - m);
  const eb = Math.exp(b - m);
  return clamp01(ea / (ea + eb));
}

function clamp01(x) {
  return Math.min(1, Math.max(0, x));
}

/** Current engine status (for diagnostics / popup). */
export function engineStatus() {
  return {
    initialized: Boolean(session),
    ep: activeEp,
    variant: activeSpec?.key ?? null,
    inputSize: activeSpec?.inputSize ?? null,
  };
}

/** Release the session (used when resetting or switching models). */
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
