import { beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory IndexedDB stub sufficient for model-store's usage pattern.
function makeIdb() {
  const data = new Map();
  const makeRequest = (result) => {
    const req = { result, onsuccess: null };
    // Fire onsuccess on the next microtask (IDB semantics: request completes, THEN the
    // transaction's oncomplete fires).
    queueMicrotask(() => req.onsuccess?.());
    return req;
  };
  const store = {
    put: (value, key) => {
      data.set(key, value);
      return makeRequest(undefined);
    },
    get: (key) => makeRequest(data.get(key)),
    delete: (key) => {
      data.delete(key);
      return makeRequest(undefined);
    },
    clear: () => {
      data.clear();
      return makeRequest(undefined);
    },
    getAllKeys: () => makeRequest([...data.keys()]),
  };
  return {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => store,
    transaction: () => {
      const t = { oncomplete: null, onerror: null, onabort: null };
      // oncomplete fires after all request onsuccess callbacks (microtask -> task).
      setTimeout(() => t.oncomplete?.(), 0);
      return Object.assign(t, { objectStore: () => store });
    },
    close: () => {},
    _data: data,
  };
}

let db;
globalThis.indexedDB = {
  open: vi.fn(() => {
    db ??= makeIdb(); // one shared store across open() calls (IDB persists)
    const req = { result: db, onsuccess: null, onupgradeneeded: null };
    setTimeout(() => {
      req.onupgradeneeded?.();
      req.onsuccess?.();
    }, 0);
    return req;
  }),
};

const store = await import('../../src/shared/model-store.js');

beforeEach(() => {
  db?._data.clear();
});

describe('model-store', () => {
  it('puts and gets a blob', async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])]);
    await store.putModelBlob('m1', blob);
    const got = await store.getModelBlob('m1');
    expect(got).toBe(blob);
  });

  it('returns undefined for missing key', async () => {
    expect(await store.getModelBlob('nope')).toBeUndefined();
  });

  it('lists keys', async () => {
    await store.putModelBlob('a', new Blob(['x']));
    await store.putModelBlob('b', new Blob(['y']));
    const keys = await store.listModelKeys();
    expect(keys.sort()).toEqual(['a', 'b']);
  });

  it('deletes a blob', async () => {
    await store.putModelBlob('a', new Blob(['x']));
    await store.deleteModelBlob('a');
    expect(await store.getModelBlob('a')).toBeUndefined();
  });

  it('clears the store', async () => {
    await store.putModelBlob('a', new Blob(['x']));
    await store.clearModelStore();
    expect(await store.listModelKeys()).toEqual([]);
  });

  it('overwrites an existing key (put is idempotent)', async () => {
    await store.putModelBlob('k', new Blob(['first']));
    const second = new Blob(['second-value']);
    await store.putModelBlob('k', second);
    expect(await store.getModelBlob('k')).toBe(second);
  });

  it('rejects when the database open is blocked (onblocked)', async () => {
    // Swap in an open() that reports "blocked" — a second tab holding the DB.
    const real = globalThis.indexedDB;
    globalThis.indexedDB = {
      open: vi.fn(() => {
        const req = { onsuccess: null, onupgradeneeded: null, onerror: null, onblocked: null };
        setTimeout(() => req.onblocked?.(), 0);
        return req;
      }),
    };
    try {
      await expect(store.listModelKeys()).rejects.toThrow(/blocked/i);
    } finally {
      globalThis.indexedDB = real;
    }
  });

  it('rejects when the database open errors (onerror)', async () => {
    const real = globalThis.indexedDB;
    globalThis.indexedDB = {
      open: vi.fn(() => {
        const req = {
          onsuccess: null,
          onupgradeneeded: null,
          onerror: null,
          onblocked: null,
          error: new Error('quota'),
        };
        setTimeout(() => req.onerror?.(), 0);
        return req;
      }),
    };
    try {
      await expect(store.listModelKeys()).rejects.toThrow(/quota/i);
    } finally {
      globalThis.indexedDB = real;
    }
  });

  it('times out a hung IndexedDB open (withTimeout bound)', async () => {
    // open() that never resolves — the withTimeout wrapper must reject.
    const real = globalThis.indexedDB;
    globalThis.indexedDB = {
      open: vi.fn(() => ({
        onsuccess: null,
        onupgradeneeded: null,
        onerror: null,
        onblocked: null,
      })),
    };
    try {
      await expect(store.listModelKeys()).rejects.toThrow(/timed out|indexedDB/i);
    } finally {
      globalThis.indexedDB = real;
    }
  }, 20000);
});
