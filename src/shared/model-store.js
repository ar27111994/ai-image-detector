/**
 * IndexedDB-backed store for model weight blobs. Works in service workers, offscreen
 * documents, and pages. Zero dependencies.
 *
 * Weights are downloaded ONCE at first-run setup, SHA-256 verified, and stored here as Blobs.
 * All subsequent inference loads from IDB — the extension is fully offline afterwards.
 */
import { MODEL_DB_NAME, MODEL_DB_VERSION, MODEL_STORE } from './constants.js';
import { withTimeout } from './protocol.js';

/** Bound on every IndexedDB operation so a hung/blocked store can't stall the service worker. */
const IDB_TIMEOUT_MS = 10000;

/** @returns {Promise<IDBDatabase>} */
function openDb() {
  return withTimeout(
    new Promise((resolve, reject) => {
      const req = indexedDB.open(MODEL_DB_NAME, MODEL_DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(MODEL_STORE)) {
          db.createObjectStore(MODEL_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('IndexedDB blocked (another tab upgrading?)'));
    }),
    IDB_TIMEOUT_MS,
    'indexedDB.open',
  );
}

function tx(db, mode, fn) {
  return withTimeout(
    new Promise((resolve, reject) => {
      const t = db.transaction(MODEL_STORE, mode);
      const store = t.objectStore(MODEL_STORE);
      const request = fn(store);
      let requestResult;
      // Capture the operation's own result (fires before the transaction completes).
      if (request && typeof request === 'object') {
        request.onsuccess = () => {
          requestResult = request.result;
        };
      }
      t.oncomplete = () => resolve(requestResult);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error ?? new Error('transaction aborted'));
    }),
    IDB_TIMEOUT_MS,
    'indexedDB.transaction',
  );
}

/** @param {string} key @param {Blob} blob */
export async function putModelBlob(key, blob) {
  const db = await openDb();
  try {
    await tx(db, 'readwrite', (store) => store.put(blob, key));
  } finally {
    db.close();
  }
}

/** @param {string} key @returns {Promise<Blob|undefined>} */
export async function getModelBlob(key) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const req = db.transaction(MODEL_STORE, 'readonly').objectStore(MODEL_STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/** @param {string} key */
export async function deleteModelBlob(key) {
  const db = await openDb();
  try {
    await tx(db, 'readwrite', (store) => store.delete(key));
  } finally {
    db.close();
  }
}

/** @returns {Promise<string[]>} all stored model keys */
export async function listModelKeys() {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const req = db.transaction(MODEL_STORE, 'readonly').objectStore(MODEL_STORE).getAllKeys();
      req.onsuccess = () => resolve(req.result.map(String));
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/** Drop every stored model (used by "reset" in options). */
export async function clearModelStore() {
  const db = await openDb();
  try {
    await tx(db, 'readwrite', (store) => store.clear());
  } finally {
    db.close();
  }
}
