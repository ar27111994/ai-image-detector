/**
 * Unit tests for the inference-engine ORT session lifecycle: configureOrt, loadSession
 * (adaptive EP selection + WebGPU self-test + WASM fallback + concurrent dedup),
 * analyzeImageBytes (decode -> preprocess -> infer -> score), engineStatus, unloadSession.
 *
 * onnxruntime-web, OffscreenCanvas, createImageBitmap, and the model store are mocked so the
 * full orchestration runs in Node without a browser/GPU.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeStub } from '../helpers/dom-stub.js';

// ---- Mock onnxruntime-web ------------------------------------------------
// A controllable fake InferenceSession. `sessionBehavior` lets a test make specific
// EPs fail or hang (WebGPU probe timeout) to exercise the fallback path.
const sessionBehavior = { create: null, runOutput: [5, -5], failOn: new Set(), hangProbe: false };
vi.mock('onnxruntime-web', () => {
  const env = { wasm: {}, logLevel: null };
  class FakeTensor {
    constructor(type, data, dims) {
      this.type = type;
      this.data = data;
      this.dims = dims;
    }
  }
  class FakeSession {
    constructor(bytes, opts) {
      this.opts = opts;
      this.inputNames = ['input'];
      this.outputNames = ['output'];
      this.released = false;
    }
    async run(_feeds) {
      const ep = this.opts.executionProviders[0];
      if (sessionBehavior.failOn.has(ep)) throw new Error(`${ep} boom`);
      if (sessionBehavior.hangProbe && ep === 'webgpu') {
        return new Promise(() => {}); // never resolves — triggers the probe timeout
      }
      return { output: { data: Float32Array.from(sessionBehavior.runOutput) } };
    }
    async release() {
      this.released = true;
    }
  }
  return {
    env,
    Tensor: FakeTensor,
    __FakeSession: FakeSession, // exposed so tests can inspect/track created instances
    InferenceSession: {
      create: vi.fn(async (bytes, opts) => {
        const ep = opts.executionProviders[0];
        if (sessionBehavior.failOn.has(ep)) throw new Error(`${ep} init failed`);
        const s = new FakeSession(bytes, opts);
        sessionBehavior.created?.push(s); // opt-in instance tracking
        return s;
      }),
    },
  };
});

// ---- Mock the model store (IndexedDB) ------------------------------------
const modelBlobs = new Map();
vi.mock('../../src/shared/model-store.js', () => ({
  getModelBlob: vi.fn(async (key) => modelBlobs.get(key) ?? null),
}));

// ---- Mock browser decode/canvas ------------------------------------------
class FakeImageData {
  constructor(w, h) {
    this.width = w;
    this.height = h;
    this.data = new Uint8ClampedArray(w * h * 4).fill(128);
  }
}
globalThis.OffscreenCanvas = class {
  constructor(w, h) {
    this.width = w;
    this.height = h;
  }
  getContext() {
    return {
      drawImage: () => {},
      getImageData: (x, y, w, h) => new FakeImageData(w, h),
    };
  }
};
globalThis.createImageBitmap = vi.fn(async (blob) => ({
  width: blob?.__w ?? 512,
  height: blob?.__h ?? 512,
  close: vi.fn(),
}));
// performance.now is available in Node.

let chromeStub;
const SPEC = {
  key: 'primary-int8',
  kind: 'wasm',
  inputSize: 256,
  mean: [0.485, 0.456, 0.406],
  std: [0.229, 0.224, 0.225],
  aiLogitIndex: 0,
};
const MANIFEST = { variants: [SPEC] };
const pickVariant = async () => SPEC;

async function freshEngine() {
  vi.resetModules();
  return await import('../../src/offscreen/inference-engine.js');
}

beforeEach(() => {
  chromeStub?.cleanup();
  chromeStub = installChromeStub();
  modelBlobs.clear();
  modelBlobs.set('primary-int8', { arrayBuffer: async () => new ArrayBuffer(8) });
  sessionBehavior.failOn = new Set();
  sessionBehavior.hangProbe = false;
  sessionBehavior.runOutput = [5, -5];
  sessionBehavior.created = null; // null = don't track; a test opts in by setting an array
});

describe('inference-engine lifecycle', () => {
  it('configureOrt points ORT at vendored wasm and is idempotent', async () => {
    const engine = await freshEngine();
    const ort = await import('onnxruntime-web');
    engine.configureOrt();
    expect(ort.env.wasm.numThreads).toBe(1);
    expect(ort.env.wasm.proxy).toBe(false);
    expect(String(ort.env.wasm.wasmPaths['ort-wasm-simd-threaded.wasm'])).toContain(
      'chrome-extension://',
    );
    engine.configureOrt(); // idempotent — must not throw
  });

  it('loadSession warms a session and reports the chosen EP + variant', async () => {
    const engine = await freshEngine();
    const status = await engine.loadSession(MANIFEST, pickVariant);
    expect(status.variant).toBe('primary-int8');
    expect(['webgpu', 'wasm']).toContain(status.ep);
    expect(engine.engineStatus().initialized).toBe(true);
    expect(engine.engineStatus().variant).toBe('primary-int8');
  });

  it('loadSession dedupes concurrent calls into one init', async () => {
    const engine = await freshEngine();
    const ort = await import('onnxruntime-web');
    // Two concurrent callers must share a single doLoad() (the second awaits the in-flight
    // init promise). Count loadBlob reads as a proxy for "one pipeline run" — each doLoad
    // reads the blob once per EP attempt; with WebGPU available, exactly one read happens.
    const { getModelBlob } = await import('../../src/shared/model-store.js');
    const before = getModelBlob.mock.calls.length;
    const [a, b] = await Promise.all([
      engine.loadSession(MANIFEST, pickVariant),
      engine.loadSession(MANIFEST, pickVariant),
    ]);
    expect(a.variant).toBe(b.variant);
    expect(a).toEqual(b); // identical result object => shared init
    // Exactly one doLoad pipeline ran for both callers (webgpu path reads the blob once).
    expect(getModelBlob.mock.calls.length - before).toBe(1);
    expect(ort.InferenceSession.create.mock.calls.length).toBeGreaterThan(0);
  });

  it('falls back to WASM when WebGPU session creation fails', async () => {
    sessionBehavior.failOn.add('webgpu');
    const engine = await freshEngine();
    const status = await engine.loadSession(MANIFEST, pickVariant);
    expect(status.ep).toBe('wasm'); // fell back
  });

  it('falls back to WASM when the WebGPU probe hangs (timeout)', async () => {
    sessionBehavior.hangProbe = true; // webgpu run() never resolves
    const engine = await freshEngine();
    const status = await engine.loadSession(MANIFEST, pickVariant);
    expect(status.ep).toBe('wasm');
  }, 15000);

  it('releases the WebGPU session when its probe times out (no GPU resource leak)', async () => {
    sessionBehavior.created = []; // opt-in instance tracking
    sessionBehavior.hangProbe = true; // webgpu run() never resolves -> probe times out
    const engine = await freshEngine();
    const status = await engine.loadSession(MANIFEST, pickVariant);
    expect(status.ep).toBe('wasm'); // fell back after the probe timed out

    const webgpu = sessionBehavior.created.find((s) => s.opts.executionProviders[0] === 'webgpu');
    const wasm = sessionBehavior.created.find((s) => s.opts.executionProviders[0] === 'wasm');
    expect(webgpu).toBeDefined();
    // The failed WebGPU session was created but never assigned to the global `session`, so the
    // old code leaked it; it must now be released. The live WASM fallback must NOT be released.
    expect(webgpu.released).toBe(true);
    expect(wasm?.released).toBe(false);
  }, 15000);

  it('releases the WebGPU session when its probe rejects (not just on timeout)', async () => {
    sessionBehavior.created = [];
    const engine = await freshEngine();
    // Make the WebGPU probe's run() reject immediately (distinct from create() failing).
    const ort = await import('onnxruntime-web');
    const baseCreate = ort.InferenceSession.create.getMockImplementation();
    ort.InferenceSession.create.mockImplementation(async (bytes, opts) => {
      const s = await baseCreate(bytes, opts);
      if (opts.executionProviders[0] === 'webgpu') {
        s.run = async () => {
          throw new Error('webgpu probe rejected');
        };
      }
      return s;
    });

    const status = await engine.loadSession(MANIFEST, pickVariant);
    expect(status.ep).toBe('wasm');
    const webgpu = sessionBehavior.created.find((s) => s.opts.executionProviders[0] === 'webgpu');
    expect(webgpu?.released).toBe(true);
  });

  it('throws when no EP is usable', async () => {
    sessionBehavior.failOn = new Set(['webgpu', 'wasm']);
    const engine = await freshEngine();
    await expect(engine.loadSession(MANIFEST, pickVariant)).rejects.toThrow(
      /no usable execution provider/,
    );
  });

  it('analyzeImageBytes decodes, infers, and returns a calibrated score + metadata', async () => {
    const engine = await freshEngine();
    await engine.loadSession(MANIFEST, pickVariant);
    const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
    const result = await engine.analyzeImageBytes(bytes);
    expect(typeof result.score).toBe('number');
    expect(result.score).toBeCloseTo(0.99995, 3); // runOutput [5,-5], aiLogitIndex 0
    expect(result.width).toBe(512);
    expect(result.height).toBe(512);
    expect(result.ep).toBeDefined();
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.views).toBeGreaterThanOrEqual(1);
  });

  it('analyzeImageBytes throws a clean error when the image cannot be decoded', async () => {
    const engine = await freshEngine();
    await engine.loadSession(MANIFEST, pickVariant);
    globalThis.createImageBitmap.mockRejectedValueOnce(new Error('bad image'));
    await expect(engine.analyzeImageBytes(new ArrayBuffer(4))).rejects.toThrow(/decode failed/);
  });

  it('analyzeImageBytes throws when no session is loaded', async () => {
    const engine = await freshEngine();
    await expect(engine.analyzeImageBytes(new ArrayBuffer(4))).rejects.toThrow(/not initialized/);
  });

  it('engineStatus reports uninitialized before loadSession', async () => {
    const engine = await freshEngine();
    const s = engine.engineStatus();
    expect(s.initialized).toBe(false);
    expect(s.ep).toBeNull();
  });

  it('unloadSession releases the session and resets status', async () => {
    const engine = await freshEngine();
    await engine.loadSession(MANIFEST, pickVariant);
    expect(engine.engineStatus().initialized).toBe(true);
    await engine.unloadSession();
    expect(engine.engineStatus().initialized).toBe(false);
    expect(engine.engineStatus().ep).toBeNull();
    // Safe to call again (no session).
    await engine.unloadSession();
  });

  it('loadSession throws a clear error when the variant blob is missing from the store', async () => {
    modelBlobs.clear(); // nothing stored
    const engine = await freshEngine();
    await expect(engine.loadSession(MANIFEST, pickVariant)).rejects.toThrow(
      /no usable execution provider|not downloaded/,
    );
  });
});
