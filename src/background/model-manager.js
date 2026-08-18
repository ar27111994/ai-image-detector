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

// Monotonic generation token for model setup. The service worker wraps ensureModel in an
// abandonable timeout: when a download stalls and times out, the underlying operation keeps
// running in the background while a retry starts a newer generation. Stale generations must not
// commit state/blob writes, or a superseded download's late error/ready would overwrite the
// retry's result.
let currentGeneration = 0;

/**
 * Begin a new setup generation; returns its token. Any prior in-flight attempt is superseded.
 * @returns {number} the new generation token
 */
export function beginModelSetup() {
  return ++currentGeneration;
}

/**
 * True while `gen` is the latest setup generation (not superseded by a retry/reset).
 * @param {number} gen generation token to test
 * @returns {boolean} whether `gen` is still the current generation
 */
function isActive(gen) {
  return gen === currentGeneration;
}

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
 * @param {number|null} [gen] setup generation token; when set, state/blob commits are dropped
 *   once this generation is superseded by a newer one
 * @returns {Promise<{ key: string, bytes: number, verified: boolean }>}
 */
export async function downloadVariant(variantSpec, onProgress, gen = null) {
  const { key, url, sha256, sizeBytes } = variantSpec;
  if (!key || !url) throw new Error('variant spec missing key/url');
  // SHA-256 is mandatory: without it a tampered download would be trusted. Never proceed unsigned.
  if (!sha256 || typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(sha256)) {
    throw Object.assign(new Error('variant spec must include a valid sha256 (64 hex chars)'), {
      code: 'MISSING_INTEGRITY',
    });
  }

  // Commit a state/blob write only while this attempt is still the current generation. A stale
  // (superseded) attempt is a no-op so its late settlement can't overwrite a newer retry.
  const commitState = async (patch) => {
    if (gen != null && !isActive(gen)) return null; // superseded — drop the write
    return await setModelState(patch);
  };
  const throwIfSuperseded = () => {
    if (gen != null && !isActive(gen)) {
      throw Object.assign(new Error('superseded by a newer model download'), {
        code: 'SUPERSEDED',
      });
    }
  };

  await commitState({
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
    await commitState({ status: 'error', error: `network: ${err.message}` });
    throw err;
  }
  if (!response.ok) {
    await commitState({ status: 'error', error: `HTTP ${response.status}` });
    throw new Error(`model download failed: HTTP ${response.status}`);
  }

  // Enforce the pinned size budget while streaming: a missing or false Content-Length (or a
  // hostile endpoint) must not let the service worker retain an arbitrarily large response
  // before integrity rejection. Cancel the stream the moment the cap is exceeded.
  const MAX_MODEL_BYTES = (sizeBytes ?? 0) + 1024 * 1024; // pinned size + 1MB tolerance
  const total = Number(response.headers.get('content-length')) || sizeBytes || 0;
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  let lastReport = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_MODEL_BYTES) {
      await reader.cancel().catch(() => {});
      await commitState({ status: 'error', error: 'download exceeded size budget' });
      throw Object.assign(new Error('model download exceeded the pinned size budget'), {
        code: 'SIZE_OVERFLOW',
      });
    }
    chunks.push(value);
    const now = Date.now();
    if (now - lastReport > 250) {
      lastReport = now;
      const state = await commitState({
        downloadedBytes: received,
        totalBytes: total,
        progress: total ? received / total : 0,
      });
      if (state) {
        onProgress?.(state);
        broadcastProgress(state);
      }
    }
  }

  // Final size must match the pinned size exactly (defends against a truncated/expanded body).
  if (sizeBytes && received !== sizeBytes) {
    await commitState({ status: 'error', error: `size mismatch: ${received} != ${sizeBytes}` });
    throw Object.assign(new Error(`model size mismatch: expected ${sizeBytes}, got ${received}`), {
      code: 'SIZE_MISMATCH',
    });
  }

  const blob = new Blob(chunks, { type: 'application/octet-stream' });

  // Integrity is mandatory (enforced above).
  const actual = await sha256Hex(blob);
  if (actual.toLowerCase() !== sha256.toLowerCase()) {
    await commitState({
      status: 'error',
      error: 'sha256 mismatch — aborting (possible corruption)',
    });
    throw new Error(`model integrity check failed: expected ${sha256}, got ${actual}`);
  }

  throwIfSuperseded(); // don't persist a stale blob over a newer attempt
  await putModelBlob(key, blob);
  // Revalidate after the awaited write: a reset/replacement may have advanced the generation
  // while the blob write was pending. A superseded attempt must not publish `ready` over the
  // newer state even though its blob was already written.
  throwIfSuperseded();
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
 * @param {number|null} [gen] setup generation token; when set, state/blob commits are dropped
 *   once this generation is superseded by a newer one
 * @returns {Promise<{ alreadyReady?: boolean, key?: string, bytes?: number, bundled?: boolean, verified?: boolean }>}
 */
export async function ensureModel(epPreference, onProgress, gen = null) {
  if (await isModelReady()) return { alreadyReady: true };
  const manifest = await loadManifest();
  const variant = pickVariant(manifest, epPreference);

  // Self-contained package: load the embedded model without any network call.
  const bundled = await loadBundledVariant(variant);
  if (bundled) {
    // A stale (superseded) attempt must not persist its blob/state over a newer one.
    if (gen != null && !isActive(gen)) {
      throw Object.assign(new Error('superseded by a newer model download'), {
        code: 'SUPERSEDED',
      });
    }
    await putModelBlob(variant.key, bundled);
    // Revalidate after the awaited write before publishing ready.
    if (gen != null && !isActive(gen)) {
      throw Object.assign(new Error('superseded by a newer model download'), {
        code: 'SUPERSEDED',
      });
    }
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

  return await downloadVariant(variant, onProgress, gen);
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
