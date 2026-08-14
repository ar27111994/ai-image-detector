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
});
