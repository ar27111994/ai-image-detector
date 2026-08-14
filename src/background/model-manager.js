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

const MANIFEST_URL = 'models/manifest.json';

/** @returns {Promise<object>} parsed model manifest (bundled resource) */
export async function loadManifest() {
  const url = chrome.runtime.getURL(MANIFEST_URL);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`model manifest fetch failed: HTTP ${res.status}`);
  return await res.json();
}

/** @returns {Promise<object>} persisted model state */
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

/** True when the required variant blob is present in IndexedDB. */
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
 */
export async function downloadVariant(variantSpec, onProgress) {
  const { key, url, sha256, sizeBytes } = variantSpec;
  if (!key || !url) throw new Error('variant spec missing key/url');

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

  if (sha256) {
    const actual = await sha256Hex(blob);
    if (actual !== sha256) {
      await setModelState({
        status: 'error',
        error: 'sha256 mismatch — aborting (possible corruption)',
      });
      throw new Error(`model integrity check failed: expected ${sha256}, got ${actual}`);
    }
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
  chrome.runtime.sendMessage({ type: MSG.MODEL_DOWNLOAD_PROGRESS, payload: state }).catch(() => {});
}

/** Load a model variant blob from IndexedDB (throws if absent). */
export async function loadVariantBlob(key) {
  const blob = await getModelBlob(key);
  if (!blob) throw new Error(`model variant '${key}' not found in local store`);
  return blob;
}

/** Full setup: ensure the variant for `epPreference` is downloaded and verified. */
export async function ensureModel(epPreference, onProgress) {
  if (await isModelReady()) return { alreadyReady: true };
  const manifest = await loadManifest();
  const variant = pickVariant(manifest, epPreference);
  return await downloadVariant(variant, onProgress);
}

/** Choose the manifest variant for an execution-provider preference. */
export function pickVariant(manifest, epPreference) {
  const variants = manifest?.variants;
  if (!variants?.length) throw new Error('model manifest has no variants');
  const wanted = epPreference === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm', 'webgpu'];
  for (const kind of wanted) {
    const hit = variants.find((v) => v.kind === kind);
    if (hit) return hit;
  }
  return variants[0];
}
