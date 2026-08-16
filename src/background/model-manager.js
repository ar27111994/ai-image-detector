/**
 * Model download manager (runs in the service worker).
 *
 * Responsibilities:
 *  - load models/manifest.json (bundled, pinned URLs + SHA-256)
 *  - download each required variant ONCE, streaming progress to listeners
 *  - verify SHA-256 before persisting; persist to IndexedDB
 *  - report state: { status: 'missing'|'downloading'|'ready'|'error', progress, error }
 *
 * After a successful first run the extension is fully offline: the SW loads weights from
 * IndexedDB and never touches the network for inference assets again.
 */
import { MSG, STORAGE_KEYS } from '../shared/constants.js';
import { sha256Hex } from '../shared/hash.js';
import { getModelBlob, listModelKeys, putModelBlob } from '../shared/model-store.js';
import { pickVariantForEp } from '../shared/model-variant.js';

const MANIFEST_URL = 'models/manifest.json';

/**
 * Load the bundled model manifest.
 * @returns {Promise<{ variants: Array<object> }>} parsed models/manifest.json
 */
export async function loadManifest() {
  const url = chrome.runtime.getURL(MANIFEST_URL);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`model manifest fetch failed: HTTP ${res.status}`);
  return await res.json();
}

/**
 * Load the persisted model state (status/progress/error/variant).
 * @returns {Promise<{ status: string, progress: number, downloadedBytes: number, totalBytes: number, error: string|null, ep: string|null, variant: string|null }>}
 */
export async function getModelState() {
  const raw = await chrome.storage.local.get(STORAGE_KEYS.MODEL_STATE);
  return (
    raw[STORAGE_KEYS.MODEL_STATE] ?? {
      status: 'missing',
      progress: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      error: null,
      ep: null,
      variant: null,
    }
  );
}

async function setModelState(patch) {
  const state = { ...(await getModelState()), ...patch };
  await chrome.storage.local.set({ [STORAGE_KEYS.MODEL_STATE]: state });
  return state;
}

/**
 * True when the required variant blob is present in IndexedDB and state is 'ready'.
 * @returns {Promise<boolean>}
 */
export async function isModelReady() {
  const state = await getModelState();
  if (state.status !== 'ready') return false;
  const keys = await listModelKeys();
  return keys.includes(state.variant);
}

/**
 * Download + verify + store a model variant. Progress is reported via
 * chrome.runtime.sendMessage (best-effort; onboarding page also polls state).
 *
 * @param {object} variantSpec manifest entry: { key, url, sha256, sizeBytes }
 * @param {(state:object) => void} [onProgress]
 * @returns {Promise<{ key: string, bytes: number, verified: boolean }>}
 */
export async function downloadVariant(variantSpec, onProgress) {
  const { key, url, sha256, sizeBytes } = variantSpec;
  if (!key || !url) throw new Error('variant spec missing key/url');
  // SHA-256 is mandatory: without it a tampered download would be trusted. Never proceed unsigned.
  if (!sha256 || typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(sha256)) {
    throw Object.assign(new Error('variant spec must include a valid sha256 (64 hex chars)'), {
      code: 'MISSING_INTEGRITY',
    });
  }

  await setModelState({
    status: 'downloading',
    progress: 0,
    downloadedBytes: 0,
    totalBytes: sizeBytes ?? 0,
    error: null,
    variant: key,
  });

  let response;
  try {
    response = await fetch(url, { cache: 'no-store' });
  } catch (err) {
    await setModelState({ status: 'error', error: `network: ${err.message}` });
    throw err;
  }
  if (!response.ok) {
    await setModelState({ status: 'error', error: `HTTP ${response.status}` });
    throw new Error(`model download failed: HTTP ${response.status}`);
  }

  const total = Number(response.headers.get('content-length')) || sizeBytes || 0;
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  let lastReport = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    const now = Date.now();
    if (now - lastReport > 250) {
      lastReport = now;
      const state = await setModelState({
        downloadedBytes: received,
        totalBytes: total,
        progress: total ? received / total : 0,
      });
      onProgress?.(state);
      broadcastProgress(state);
    }
  }

  const blob = new Blob(chunks, { type: 'application/octet-stream' });

  // Integrity is mandatory (enforced above).
  const actual = await sha256Hex(blob);
  if (actual.toLowerCase() !== sha256.toLowerCase()) {
    await setModelState({
      status: 'error',
      error: 'sha256 mismatch — aborting (possible corruption)',
    });
    throw new Error(`model integrity check failed: expected ${sha256}, got ${actual}`);
  }

  await putModelBlob(key, blob);
  const state = await setModelState({
    status: 'ready',
    progress: 1,
    downloadedBytes: received,
    error: null,
  });
  onProgress?.(state);
  broadcastProgress(state);
  return { key, bytes: received, verified: Boolean(sha256) };
}

function broadcastProgress(state) {
  chrome.runtime.sendMessage({ type: MSG.MODEL_DOWNLOAD_PROGRESS, payload: state }).catch((err) =>
    // No listener is expected unless the onboarding page is open; log at debug so genuine
    // delivery failures are diagnosable without breaking the download.
    console.debug('[model-manager] progress broadcast had no receiver:', err?.message ?? err),
  );
}

/**
 * Load a model variant blob from IndexedDB.
 * @param {string} key
 * @returns {Promise<Blob>}
 * @throws when the variant is absent from the local store
 */
export async function loadVariantBlob(key) {
  const blob = await getModelBlob(key);
  if (!blob) throw new Error(`model variant '${key}' not found in local store`);
  return blob;
}

/**
 * Try to load a model variant that was bundled into the extension package itself
 * (dist/models/<key>.onnx). Returns the verified Blob, or null when the package has no bundle.
 * Bundled copies are integrity-checked against the manifest pin exactly like downloads.
 * @param {object} variant manifest variant ({ key, sha256, sizeBytes, ... })
 * @returns {Promise<Blob|null>} the verified blob, or null when the package has no bundle
 */
export async function loadBundledVariant(variant) {
  const url = chrome.runtime.getURL(`models/${variant.key}.onnx`);
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    if (variant.sizeBytes && blob.size !== variant.sizeBytes) return null;
    const actual = await sha256Hex(blob);
    if (variant.sha256 && actual.toLowerCase() !== variant.sha256.toLowerCase()) return null;
    return blob;
  } catch {
    return null; // no bundled model in this package
  }
}

/**
 * Full setup: prefer a bundled copy (zero download); else download once and verify.
 * @param {string} epPreference 'webgpu' | 'wasm'
 * @param {(state:object) => void} [onProgress]
 * @returns {Promise<{ alreadyReady?: boolean, key?: string, bytes?: number, bundled?: boolean, verified?: boolean }>}
 */
export async function ensureModel(epPreference, onProgress) {
  if (await isModelReady()) return { alreadyReady: true };
  const manifest = await loadManifest();
  const variant = pickVariant(manifest, epPreference);

  // Self-contained package: load the embedded model without any network call.
  const bundled = await loadBundledVariant(variant);
  if (bundled) {
    await putModelBlob(variant.key, bundled);
    const state = await setModelState({
      status: 'ready',
      progress: 1,
      downloadedBytes: bundled.size,
      error: null,
      variant: variant.key,
    });
    onProgress?.(state);
    return { key: variant.key, bytes: bundled.size, bundled: true, verified: true };
  }

  return await downloadVariant(variant, onProgress);
}

/**
 * Choose the manifest variant for an execution-provider preference.
 * Delegates to the shared implementation so the service worker (download path) and the
 * offscreen document (load path) pick identical variants.
 * @param {object} manifest models/manifest.json
 * @param {string} epPreference 'webgpu' | 'wasm'
 * @returns {object} the chosen variant
 */
export function pickVariant(manifest, epPreference) {
  return pickVariantForEp(manifest, epPreference);
}
