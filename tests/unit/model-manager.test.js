/**
 * Model manager: bundled-variant loading, mandatory SHA-256 enforcement, variant selection.
 * Mocks chrome.runtime.getURL + fetch + storage.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map();
let fetchImpl = async () => ({ ok: false, status: 404 });

globalThis.chrome = {
  runtime: {
    id: 'test-ext',
    getURL: (p) => `chrome-extension://test-ext/${p}`,
    sendMessage: vi.fn(async () => undefined),
  },
  storage: {
    local: {
      get: async (key) => (store.has(key) ? { [key]: store.get(key) } : {}),
      set: async (obj) => {
        for (const [k, v] of Object.entries(obj)) store.set(k, v);
      },
    },
  },
};

// Minimal IndexedDB stub (shared pattern with model-store.test.js) so downloadVariant's
// putModelBlob works.
const idbData = new Map();
globalThis.indexedDB = {
  open: vi.fn(() => {
    const req = { onsuccess: null, onupgradeneeded: null, onerror: null, onblocked: null };
    const db = {
      objectStoreNames: { contains: () => true },
      createObjectStore: () => ({}),
      transaction: () => {
        const t = { oncomplete: null, onerror: null, onabort: null };
        setTimeout(() => t.oncomplete?.(), 0);
        return Object.assign(t, {
          objectStore: () => ({
            put: (v, k) => {
              idbData.set(k, v);
              return { onsuccess: null };
            },
            get: (k) => {
              const r = { result: idbData.get(k), onsuccess: null, onerror: null };
              setTimeout(() => r.onsuccess?.(), 0);
              return r;
            },
            getAllKeys: () => {
              const r = { result: [...idbData.keys()], onsuccess: null, onerror: null };
              setTimeout(() => r.onsuccess?.(), 0);
              return r;
            },
          }),
        });
      },
      close: () => {},
    };
    req.result = db;
    setTimeout(() => {
      req.onupgradeneeded?.();
      req.onsuccess?.();
    }, 0);
    return req;
  }),
};
globalThis.fetch = vi.fn((...a) => fetchImpl(...a));

const { loadBundledVariant, pickVariant, downloadVariant, beginModelSetup, getModelState } =
  await import('../../src/background/model-manager.js');
const { sha256Hex } = await import('../../src/shared/hash.js');

const VARIANT = {
  kind: 'wasm',
  key: 'primary-int8',
  url: 'https://example.test/model.onnx',
  sha256: 'a'.repeat(64),
  sizeBytes: 3,
  inputSize: 256,
};

beforeEach(() => {
  store.clear();
  fetchImpl = async () => ({ ok: false, status: 404 });
});

describe('model-manager.loadBundledVariant', () => {
  it('returns null when the package has no bundled model (404)', async () => {
    expect(await loadBundledVariant(VARIANT)).toBeNull();
  });

  it('returns the blob when the bundled copy matches size + SHA-256', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const sha = await sha256Hex(bytes.buffer);
    const v = { ...VARIANT, sha256: sha, sizeBytes: 3 };
    fetchImpl = async () => ({ ok: true, blob: async () => new Blob([bytes]) });
    const blob = await loadBundledVariant(v);
    expect(blob).not.toBeNull();
    expect(blob.size).toBe(3);
  });

  it('rejects a bundled copy whose hash mismatches', async () => {
    const bytes = new Uint8Array([9, 9, 9]);
    const v = { ...VARIANT, sha256: 'b'.repeat(64), sizeBytes: 3 };
    fetchImpl = async () => ({ ok: true, blob: async () => new Blob([bytes]) });
    expect(await loadBundledVariant(v)).toBeNull();
  });

  it('rejects a bundled copy whose size mismatches the manifest', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]); // 5 bytes, manifest says 3
    const sha = await sha256Hex(new Uint8Array([1, 2, 3, 4, 5]).buffer);
    const v = { ...VARIANT, sha256: sha, sizeBytes: 3 };
    fetchImpl = async () => ({ ok: true, blob: async () => new Blob([bytes]) });
    expect(await loadBundledVariant(v)).toBeNull();
  });

  it('returns null when fetch throws (network/package error)', async () => {
    fetchImpl = async () => {
      throw new Error('boom');
    };
    expect(await loadBundledVariant(VARIANT)).toBeNull();
  });
});

describe('model-manager.downloadVariant integrity enforcement', () => {
  it('rejects a variant spec without a valid sha256 before any network call', async () => {
    await expect(downloadVariant({ key: 'x', url: 'https://x.test/m.onnx' })).rejects.toThrow(
      /sha256/i,
    );
    await expect(
      downloadVariant({ key: 'x', url: 'https://x.test/m.onnx', sha256: 'nothex' }),
    ).rejects.toThrow(/sha256/i);
  });

  it('rejects a variant spec missing key/url', async () => {
    await expect(
      downloadVariant({ url: 'https://x.test/m.onnx', sha256: 'a'.repeat(64) }),
    ).rejects.toThrow(/key\/url/i);
  });
});

describe('model-manager.pickVariant', () => {
  const manifest = {
    variants: [
      { kind: 'wasm', key: 'w' },
      { kind: 'webgpu', key: 'g' },
    ],
  };
  it('prefers wasm for wasm preference', () => {
    expect(pickVariant(manifest, 'wasm').key).toBe('w');
  });
  it('prefers webgpu for webgpu preference, falling back to wasm', () => {
    expect(pickVariant(manifest, 'webgpu').key).toBe('g');
    expect(pickVariant({ variants: [{ kind: 'wasm', key: 'w' }] }, 'webgpu').key).toBe('w');
  });
  it('throws on empty manifest', () => {
    expect(() => pickVariant({ variants: [] }, 'wasm')).toThrow();
  });
});

describe('model-manager.downloadVariant full flow', () => {
  /** A streaming fetch response delivering `bytes` in `chunks` pieces. */
  function streamResponse(bytes, chunks = 2) {
    const per = Math.ceil(bytes.length / chunks);
    const parts = [];
    for (let i = 0; i < bytes.length; i += per) parts.push(bytes.slice(i, i + per));
    return {
      ok: true,
      headers: { get: () => String(bytes.length) },
      body: {
        getReader: () => {
          let i = 0;
          return {
            read: async () =>
              i < parts.length
                ? { done: false, value: parts[i++] }
                : { done: true, value: undefined },
          };
        },
      },
    };
  }

  it('downloads, verifies SHA-256, and stores the blob on success', async () => {
    const bytes = new Uint8Array([10, 20, 30, 40, 50]);
    const sha = await sha256Hex(bytes.buffer);
    fetchImpl = async () => streamResponse(bytes, 3);
    const progress = [];
    const res = await downloadVariant(
      { key: 'm1', url: 'https://x.test/m.onnx', sha256: sha, sizeBytes: 5 },
      (s) => progress.push(s.status),
    );
    expect(res.verified).toBe(true);
    expect(res.bytes).toBe(5);
    expect(progress).toContain('downloading');
    expect(progress).toContain('ready');
  });

  it('fails on HTTP error and records error state', async () => {
    fetchImpl = async () => ({ ok: false, status: 500 });
    await expect(
      downloadVariant({ key: 'm2', url: 'https://x.test/m.onnx', sha256: 'a'.repeat(64) }),
    ).rejects.toThrow(/HTTP 500/);
    const state = store.get('model.state.v1');
    expect(state.status).toBe('error');
  });

  it('fails on SHA-256 mismatch and does not store', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    fetchImpl = async () => streamResponse(bytes, 1);
    await expect(
      downloadVariant({ key: 'm3', url: 'https://x.test/m.onnx', sha256: 'b'.repeat(64) }),
    ).rejects.toThrow(/integrity/i);
    const state = store.get('model.state.v1');
    expect(state.status).toBe('error');
    expect(state.error).toMatch(/sha256/i);
  });

  it('fails on network error', async () => {
    fetchImpl = async () => {
      throw new Error('socket hangup');
    };
    await expect(
      downloadVariant({ key: 'm4', url: 'https://x.test/m.onnx', sha256: 'a'.repeat(64) }),
    ).rejects.toThrow(/socket hangup/i);
    expect(store.get('model.state.v1').status).toBe('error');
  });

  it('a superseded (timed-out) attempt does not overwrite the current generation state', async () => {
    // Attempt A starts on generation gA and stalls mid-stream; a retry supersedes it (gB) and
    // completes to `ready`. When A's late network error then settles, it must NOT overwrite the
    // retry's ready state.
    const bytes = new Uint8Array([7, 7, 7, 7]);
    const sha = await sha256Hex(bytes.buffer);
    const variant = { key: 'm-gen', url: 'https://x.test/m.onnx', sha256: sha, sizeBytes: 4 };

    // Attempt A: a fetch stream that delivers one chunk then hangs forever (stalled connection).
    let releaseA;
    fetchImpl = async () => ({
      ok: true,
      headers: { get: () => String(bytes.length) },
      body: {
        getReader: () => {
          let delivered = false;
          return {
            read: () => {
              if (!delivered) {
                delivered = true;
                return Promise.resolve({ done: false, value: bytes.slice(0, 2) });
              }
              return new Promise((resolve, reject) => {
                releaseA = () => reject(new Error('late network failure'));
              });
            },
          };
        },
      },
    });

    const gA = beginModelSetup();
    const attemptA = downloadVariant(variant, undefined, gA);
    // Let A reach the stalled read, then supersede it with a newer generation.
    await new Promise((r) => setTimeout(r, 20));
    const gB = beginModelSetup();
    expect(gB).toBeGreaterThan(gA);

    // A's late settlement arrives after supersession: it must be swallowed (no error commit).
    releaseA();
    await expect(attemptA).rejects.toThrow(/late network failure/i);
    // The recorded state must NOT be A's error — the superseded attempt's commit was dropped.
    const state = await getModelState();
    expect(state.status).not.toBe('error');
  });

  it('beginModelSetup increments a monotonic generation token', () => {
    const a = beginModelSetup();
    const b = beginModelSetup();
    const c = beginModelSetup();
    expect(b).toBe(a + 1);
    expect(c).toBe(b + 1);
  });

  it('enforces the pinned size budget and cancels an overflowing stream', async () => {
    // Pinned sizeBytes is 3, so the budget is 3 + 1MB tolerance. A stream exceeding that must be
    // cancelled + rejected mid-read, not buffered whole then hash-rejected.
    const big = new Uint8Array(2 * 1024 * 1024); // 2MB > (3 + 1MB) budget
    let cancelled = false;
    fetchImpl = async () => {
      const r = streamResponse(big, 64);
      const rd = r.body.getReader();
      r.body.getReader = () => ({
        read: rd.read.bind(rd),
        cancel: async () => {
          cancelled = true;
        },
      });
      return r;
    };
    await expect(
      downloadVariant({
        key: 'm-big',
        url: 'https://x.test/m.onnx',
        sha256: 'a'.repeat(64),
        sizeBytes: 3,
      }),
    ).rejects.toThrow(/size budget/i);
    expect(cancelled).toBe(true);
    expect(store.get('model.state.v1').status).toBe('error');
  });

  it('rejects a final size mismatch (truncated/expanded body)', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]); // 5 bytes
    const sha = await sha256Hex(bytes.buffer);
    fetchImpl = async () => streamResponse(bytes, 5);
    await expect(
      downloadVariant({ key: 'm-sm', url: 'https://x.test/m.onnx', sha256: sha, sizeBytes: 3 }),
    ).rejects.toThrow(/size mismatch/i);
    expect(store.get('model.state.v1').status).toBe('error');
  });

  it('a superseded attempt does not publish ready even after its blob write resolves', async () => {
    // Regression for the post-write gap: supersede mid-`putModelBlob`, then let the write resolve.
    const bytes = new Uint8Array([9, 9, 9]);
    const sha = await sha256Hex(bytes.buffer);
    fetchImpl = async () => streamResponse(bytes, 1);

    // Make putModelBlob's IDB put controllable so we can supersede during the awaited write.
    const modelStore = await import('../../src/shared/model-store.js');
    let releasePut;
    const putSpy = vi.spyOn(modelStore, 'putModelBlob').mockImplementation(
      () =>
        new Promise((r) => {
          releasePut = r;
        }),
    );

    const gA = beginModelSetup();
    const attempt = downloadVariant(
      { key: 'm-pw', url: 'https://x.test/m.onnx', sha256: sha, sizeBytes: 3 },
      undefined,
      gA,
    );
    // Wait until the attempt is parked in the awaited put, then supersede + release the write.
    await new Promise((r) => setTimeout(r, 30));
    beginModelSetup(); // supersede
    releasePut();
    await expect(attempt).rejects.toThrow(/superseded/i);
    expect(store.get('model.state.v1')?.status).not.toBe('ready');
    putSpy.mockRestore();
  });
});

describe('model-manager.ensureModel bundled fast path', () => {
  it('loads a bundled model without downloading when present and valid', async () => {
    const { ensureModel } = await import('../../src/background/model-manager.js');
    const bytes = new Uint8Array([1, 2, 3]);
    const sha = await sha256Hex(bytes.buffer);
    fetchImpl = async (url) => {
      const u = String(url);
      if (u.endsWith('models/manifest.json')) {
        return {
          ok: true,
          json: async () => ({
            variants: [
              {
                kind: 'wasm',
                key: 'primary-int8',
                url: 'https://x.test/m.onnx',
                sha256: sha,
                sizeBytes: 3,
                inputSize: 256,
              },
            ],
          }),
        };
      }
      if (u.includes('/models/primary-int8.onnx')) {
        return { ok: true, blob: async () => new Blob([bytes]) };
      }
      return { ok: false, status: 404 };
    };
    const res = await ensureModel('wasm');
    expect(res.bundled).toBe(true);
    expect(res.verified).toBe(true);
  });

  it('short-circuits when the model is already ready (no fetch, no download)', async () => {
    const { ensureModel } = await import('../../src/background/model-manager.js');
    // isModelReady() true: state ready + variant blob present in the store.
    store.set('model.state.v1', { status: 'ready', variant: 'primary-int8' });
    idbData.set('primary-int8', new Blob([new Uint8Array([1])]));
    let fetchCalled = false;
    fetchImpl = async () => {
      fetchCalled = true;
      return { ok: false, status: 404 };
    };
    const res = await ensureModel('wasm');
    expect(res.alreadyReady).toBe(true);
    expect(fetchCalled).toBe(false);
  });

  it('isModelReady returns false when state is not ready', async () => {
    store.set('model.state.v1', { status: 'missing', variant: null });
    const { isModelReady } = await import('../../src/background/model-manager.js');
    expect(await isModelReady()).toBe(false);
  });

  it('isModelReady returns false when the variant blob is absent from the store', async () => {
    store.set('model.state.v1', { status: 'ready', variant: 'not-stored' });
    idbData.clear();
    const { isModelReady } = await import('../../src/background/model-manager.js');
    expect(await isModelReady()).toBe(false);
  });

  it('loadVariantBlob returns the stored blob', async () => {
    const { loadVariantBlob } = await import('../../src/background/model-manager.js');
    const blob = new Blob([new Uint8Array([9, 9])]);
    idbData.set('variant-x', blob);
    expect(await loadVariantBlob('variant-x')).toBe(blob);
  });

  it('loadVariantBlob throws a clear error when the variant is absent', async () => {
    const { loadVariantBlob } = await import('../../src/background/model-manager.js');
    idbData.clear();
    await expect(loadVariantBlob('missing-variant')).rejects.toThrow(/not found in local store/);
  });

  it('pickVariant falls back to the first variant when no EP matches', async () => {
    const { pickVariant } = await import('../../src/background/model-manager.js');
    const manifest = { variants: [{ kind: 'exotic', key: 'only-one' }] };
    expect(pickVariant(manifest, 'webgpu').key).toBe('only-one');
    expect(pickVariant(manifest, 'wasm').key).toBe('only-one');
  });

  it('pickVariant prefers the matching EP and falls back webgpu->wasm', async () => {
    const { pickVariant } = await import('../../src/background/model-manager.js');
    const manifest = {
      variants: [
        { kind: 'wasm', key: 'wasm-var' },
        { kind: 'webgpu', key: 'webgpu-var' },
      ],
    };
    expect(pickVariant(manifest, 'webgpu').key).toBe('webgpu-var');
    expect(pickVariant(manifest, 'wasm').key).toBe('wasm-var');
  });

  it('pickVariant throws a clear error for an empty manifest', async () => {
    const { pickVariant } = await import('../../src/background/model-manager.js');
    expect(() => pickVariant({ variants: [] }, 'wasm')).toThrow(/no variants/);
  });
});
