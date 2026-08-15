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

const { loadBundledVariant, pickVariant, downloadVariant } = await import(
  '../../src/background/model-manager.js'
);
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
});
