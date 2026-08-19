/**
 * MV3 service worker: orchestration only (never holds the ONNX session — it can be killed).
 *
 * Responsibilities:
 *  - ensure exactly one offscreen document exists (it owns inference)
 *  - fetch cross-origin image bytes (host_permissions bypass page CORS)
 *  - LRU-cache analysis results by content hash
 *  - route content-script analysis requests to the offscreen doc
 *  - model setup: download/verify/store via model-manager; open onboarding on first install
 */
import {
  ANALYSIS_CACHE_MAX_ENTRIES,
  MAX_IMAGE_BYTES,
  MSG,
  OFFSCREEN_DOCUMENT_PATH,
  TIMEOUTS,
} from '../shared/constants.js';
import {
  isRequest,
  makeError,
  makeOk,
  nextId,
  sendRequest,
  withTimeout,
} from '../shared/protocol.js';
import { imageContentKey } from '../shared/hash.js';
import { LruCache } from '../shared/lru-cache.js';
import * as modelManager from './model-manager.js';
import { isSiteEnabled, loadSettings, setSiteEnabled } from '../shared/settings.js';

let creatingOffscreen = null;
let initializingSession = null;
let downloadingModel = null; // in-flight ensureModel promise (dedup concurrent download starts)
let resettingModel = null; // in-flight resetModelState promise (new starts must await it)
const analysisCache = new LruCache(ANALYSIS_CACHE_MAX_ENTRIES);
const inflightAnalysis = new Map(); // contentHash -> Promise<result> (dedup concurrent identical work)
let cachedManifest = null;

/* ---------------------------------- setup ---------------------------------- */

chrome.runtime.onInstalled.addListener(async (details) => {
  console.info('[ai-detector] installed:', details.reason);
  if (details.reason === 'install') {
    const ready = await modelManager.isModelReady().catch(() => false);
    if (!ready) {
      await chrome.tabs.create({ url: chrome.runtime.getURL('pages/onboarding.html') });
    }
  }
});

chrome.runtime.onStartup.addListener(() => {
  console.info('[ai-detector] browser startup');
});

/* ----------------------------- offscreen lifecycle ----------------------------- */

/**
 * Create the offscreen document exactly once; concurrent callers share the same promise.
 * The check-then-create is made atomic by assigning the in-flight promise synchronously before
 * the first await, so a second caller always sees `creatingOffscreen` set.
 */
async function ensureOffscreenDocument() {
  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }
  creatingOffscreen = (async () => {
    const url = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
    const existing = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [url],
    });
    if (existing.length > 0) return;
    await chrome.offscreen
      .createDocument({
        url: OFFSCREEN_DOCUMENT_PATH,
        reasons: ['BLOBS', 'WORKERS'],
        justification: 'Run local ONNX image-classification inference and image preprocessing',
      })
      .catch((err) => {
        // Tolerate a racing create that landed first.
        if (!/already exists/i.test(String(err?.message))) throw err;
      });
  })();
  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

/**
 * Force-recreate the offscreen document after a suspected crash/stale context. Closes any
 * existing (unresponsive) document first, then drops the cached manifest + session guards so the
 * next ensure-offscreen/warm-up starts completely fresh (a crashed document may have been serving
 * a stale manifest, and a rejected in-flight init promise must never be reused).
 * Closing a healthy document is safe — the next request just recreates it.
 */
async function recreateOffscreenDocument() {
  const url = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  try {
    await chrome.offscreen.closeDocument();
  } catch {
    /* no document to close — fine */
  }
  // Drop cached session state so the retry does a genuinely fresh warm-up.
  cachedManifest = null;
  initializingSession = null;
  // Re-verify none remains (best-effort; a lingering entry just means the next create is a no-op).
  await chrome.runtime
    .getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] })
    .catch(() => []);
}

/**
 * Warm the inference session inside the offscreen document (idempotent; dedupes concurrent
 * calls). If the warm-up fails because the offscreen document is gone or unresponsive (e.g. it
 * was killed), the document is recreated once and the warm-up retried before surfacing the error.
 * @returns {Promise<object>} the offscreen session status ({ ep, variant, warmMs, engine })
 */
async function ensureInferenceReady() {
  if (!(await modelManager.isModelReady())) {
    throw Object.assign(new Error('model not downloaded — complete setup first'), {
      code: 'MODEL_NOT_READY',
    });
  }
  await ensureOffscreenDocument();
  if (!cachedManifest) cachedManifest = await modelManager.loadManifest();
  try {
    return await warmSession();
  } catch (err) {
    // Recover from a crashed/stale offscreen document once: recreate (which also clears the
    // cached manifest + any rejected in-flight init) + warm again before surfacing the error.
    console.warn('[ai-detector] inference warm-up failed, recreating offscreen doc:', err?.message);
    await recreateOffscreenDocument();
    await ensureOffscreenDocument();
    cachedManifest = await modelManager.loadManifest();
    return await warmSession();
  }
}

/**
 * Single warm-up attempt (dedupes concurrent callers via initializingSession).
 * @returns {Promise<object>} the offscreen session status
 */
async function warmSession() {
  if (initializingSession) return await initializingSession;
  initializingSession = sendRequest(
    {
      id: nextId('ensure'),
      type: MSG.OFFSCREEN_ENSURE_READY,
      target: 'offscreen',
      payload: { manifest: cachedManifest },
    },
    { timeoutMs: TIMEOUTS.INFERENCE_INIT_MS },
  )
    .then((response) => {
      if (!response?.ok) {
        throw Object.assign(new Error(response?.error?.message ?? 'offscreen init failed'), {
          code: response?.error?.code,
        });
      }
      return response.result;
    })
    .finally(() => {
      initializingSession = null;
    });
  return await initializingSession;
}

/* ------------------------------- image fetching ------------------------------- */

/**
 * Fetch cross-origin image bytes (host_permissions bypass page CORS), bounded by MAX_IMAGE_BYTES.
 * @param {string} url
 * @returns {Promise<ArrayBuffer>} the image bytes
 */
async function fetchImageBytes(url) {
  const response = await fetch(url, { credentials: 'omit', cache: 'force-cache' });
  if (!response.ok) throw new Error(`image fetch failed: HTTP ${response.status}`);
  const length = Number(response.headers.get('content-length')) || 0;
  if (length > MAX_IMAGE_BYTES) throw new Error(`image too large (${length} bytes)`);
  // Stream with a cumulative cap and cancel on overflow: `response.blob()` would buffer the
  // entire body before we could measure it, letting a chunked response without Content-Length
  // exceed the hard cap.
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_IMAGE_BYTES) {
      await reader.cancel().catch(() => {});
      throw Object.assign(new Error(`image too large (>${MAX_IMAGE_BYTES} bytes)`), {
        code: 'TOO_LARGE',
      });
    }
    chunks.push(value);
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out.buffer;
}

/* ------------------------------- message routing ------------------------------- */

/**
 * Only accept messages from this extension's own contexts (content scripts, pages, offscreen).
 * External pages/other extensions cannot drive analysis or mutate state.
 * @param {chrome.runtime.MessageSender} sender
 * @returns {boolean} true if the sender is one of this extension's own contexts
 */
function isExtensionContext(sender) {
  if (!sender) return false;
  if (sender.id && sender.id !== chrome.runtime.id) return false;
  const origin = sender.origin ?? sender.url;
  if (origin && !origin.startsWith(`chrome-extension://${chrome.runtime.id}`) && !sender.tab) {
    // A sender with a tab is a content script in a web page (allowed); anything else with a
    // foreign origin and no tab is not ours.
    return false;
  }
  return true;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isRequest(message)) return false;
  if (!isExtensionContext(sender)) {
    console.warn(
      '[ai-detector] rejected message from non-extension context:',
      sender?.origin ?? sender?.url,
    );
    sendResponse(makeError(message, 'unauthorized sender', 'FORBIDDEN'));
    return true;
  }

  const respond = (promise) => {
    promise
      .then((result) => sendResponse(makeOk(message, result)))
      .catch((err) => sendResponse(makeError(message, err?.message ?? String(err), err?.code)));
    return true;
  };

  switch (message.type) {
    case MSG.PING:
      sendResponse(makeOk(message, { context: 'background', ts: Date.now() }));
      return false;

    case MSG.GET_SETTINGS:
      return respond(loadSettings());

    case MSG.GET_STATUS:
      return respond(getStatus());

    case MSG.GET_TAB_STATS:
      return respond(Promise.resolve(getTabStats(sender.tab?.id ?? message.payload?.tabId)));

    case MSG.SET_SITE_ENABLED:
      return respond(setSiteEnabledFor(sender, message.payload));

    case MSG.MODEL_DOWNLOAD_START:
      return respond(startModelDownload());

    case MSG.MODEL_DOWNLOAD_STATUS:
      return respond(modelManager.getModelState());

    case MSG.MODEL_RESET:
      return respond(resetModel());

    case MSG.ANALYZE_IMAGE:
      return respond(analyzeByUrl(message.payload, sender));

    case MSG.ANALYZE_IMAGE_BYTES:
      return respond(analyzeByBytes(message.payload, sender));

    default:
      return false;
  }
});

/* --------------------------------- analysis --------------------------------- */

async function analyzeByUrl(payload, sender) {
  const { url, minSize } = payload ?? {};
  if (!url || typeof url !== 'string') {
    throw Object.assign(new Error('url required'), { code: 'BAD_INPUT' });
  }

  const settings = await loadSettings();
  const host = siteRuleHostname(sender);
  if (host && !(await isSiteEnabled(host))) {
    return { skipped: true, reason: 'site-disabled' };
  }

  if (url.startsWith('data:') || url.startsWith('blob:')) {
    return { skipped: true, reason: 'bytes-required' };
  }

  const bytes = await fetchImageBytes(url);
  const result = await analyzeBytes(
    bytes,
    url,
    minSize ?? settings.minImageSize,
    settings.threshold,
  );
  recordTabVerdict(sender?.tab?.id, result);
  return result;
}

async function analyzeByBytes(payload, sender) {
  const { bytes, minSize } = payload ?? {};
  // Enforce the per-site disable rule on the byte-relay path too: content scripts still discover
  // data:/blob: images on a disabled page and route them here, so they must be skipped like
  // URL-backed images.
  const host = siteRuleHostname(sender);
  if (host && !(await isSiteEnabled(host))) {
    return { skipped: true, reason: 'site-disabled' };
  }
  const buffer = normalizeBytes(bytes);
  if (!buffer) throw Object.assign(new Error('bytes required'), { code: 'BAD_INPUT' });
  const settings = await loadSettings();
  const result = await analyzeBytes(
    buffer,
    null,
    minSize ?? settings.minImageSize,
    settings.threshold,
  );
  recordTabVerdict(sender?.tab?.id, result);
  return result;
}

function normalizeBytes(bytes) {
  // Reject oversized inputs BEFORE copying: a raw ArrayBuffer is already sized, and a
  // { data: number[] } reports its length without allocating — `Uint8Array.from` would otherwise
  // copy an arbitrarily large page/JS-supplied array before analysis.
  if (bytes instanceof ArrayBuffer) {
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      throw Object.assign(new Error(`image too large (${bytes.byteLength} bytes)`), {
        code: 'TOO_LARGE',
      });
    }
    return bytes;
  }
  if (bytes?.data && Array.isArray(bytes.data)) {
    if (bytes.data.length > MAX_IMAGE_BYTES) {
      throw Object.assign(new Error(`image too large (${bytes.data.length} bytes)`), {
        code: 'TOO_LARGE',
      });
    }
    return Uint8Array.from(bytes.data).buffer;
  }
  return null;
}

function safeHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * The hostname whose per-site rule governs a content-script request. With `all_frames`, each
 * iframe runs its own content script and reports its own `sender.url`; the user's per-site rule
 * is keyed on the top-level tab's hostname, so prefer `sender.tab.url` (main frame) over the
 * frame's own URL. This keeps cross-origin iframes subject to the page the user disabled.
 * @param {chrome.runtime.MessageSender} sender
 * @returns {string|null}
 */
function siteRuleHostname(sender) {
  return safeHostname(sender?.tab?.url) ?? (sender?.url ? safeHostname(sender.url) : null);
}

async function analyzeBytes(bytes, sourceUrl, minSize, threshold) {
  // The cache key must include the decision threshold: the verdict is threshold-dependent, so a
  // result classified at one threshold must not be served for a request using a different one.
  const key = `${await imageContentKey(bytes)}|t=${threshold}`;
  const hit = analysisCache.get(key);
  if (hit) return { ...hit, cached: true };

  // Deduplicate concurrent analyses of identical bytes (cache stampede protection).
  if (inflightAnalysis.has(key)) {
    const shared = await inflightAnalysis.get(key);
    return { ...shared, cached: true };
  }

  const work = (async () => {
    await ensureInferenceReady();
    const response = await sendRequest(
      {
        id: nextId('analyze'),
        type: MSG.OFFSCREEN_ANALYZE,
        target: 'offscreen',
        payload: { contentHash: key, bytes, minSize, threshold },
      },
      { timeoutMs: TIMEOUTS.ANALYZE_MS },
    );
    if (!response?.ok) {
      throw Object.assign(new Error(response?.error?.message ?? 'analysis failed'), {
        code: response?.error?.code,
      });
    }
    return { ...response.result, sourceUrl: sourceUrl ?? null };
  })();

  inflightAnalysis.set(key, work);
  try {
    const result = await work;
    analysisCache.set(key, result);
    return result;
  } finally {
    // Identity-guarded cleanup: a newer analysis may have installed a fresh promise under this key
    // (e.g. after a reset cleared the map); deleting unconditionally would clobber it and allow a
    // duplicate inference stampede.
    if (inflightAnalysis.get(key) === work) inflightAnalysis.delete(key);
  }
}

/* ---------------------------------- status ---------------------------------- */

/** Per-tab analysis tallies for the popup. Reset when a tab navigates/closes. */
const tabStats = new Map(); // tabId -> { ai, real, uncertain, error, analyzed }

function recordTabVerdict(tabId, result) {
  if (tabId == null || result == null || result.skipped) return;
  const s = tabStats.get(tabId) ?? { ai: 0, real: 0, uncertain: 0, error: 0, analyzed: 0 };
  const v = result.verdict;
  if (v === 'ai') s.ai++;
  else if (v === 'real') s.real++;
  else if (v === 'uncertain') s.uncertain++;
  else s.error++;
  s.analyzed++;
  tabStats.set(tabId, s);
}

function getTabStats(tabId) {
  if (tabId != null && tabStats.has(tabId)) return { tabId, ...tabStats.get(tabId) };
  // Aggregate across tabs when no specific tab is known.
  const totals = { ai: 0, real: 0, uncertain: 0, error: 0, analyzed: 0 };
  for (const s of tabStats.values()) {
    totals.ai += s.ai;
    totals.real += s.real;
    totals.uncertain += s.uncertain;
    totals.error += s.error;
    totals.analyzed += s.analyzed;
  }
  return { tabId: tabId ?? null, ...totals };
}

// Drop stats for closed tabs so the map doesn't grow unbounded.
chrome.tabs.onRemoved.addListener((tabId) => tabStats.delete(tabId));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') tabStats.delete(tabId); // fresh page -> fresh stats
});

async function getStatus() {
  const model = await modelManager.getModelState();
  return {
    model,
    ready: await modelManager.isModelReady(),
    cacheSize: analysisCache.size,
  };
}

async function setSiteEnabledFor(sender, payload) {
  const host = payload?.hostname ?? (sender?.url ? safeHostname(sender.url) : null);
  if (!host) throw Object.assign(new Error('hostname required'), { code: 'BAD_INPUT' });
  return await setSiteEnabled(host, Boolean(payload?.enabled));
}

async function startModelDownload() {
  // Dedup concurrent starts: a timed-out onboarding request does NOT cancel the underlying
  // download (sendRequest's timeout only detaches the caller), so a retry would otherwise fire a
  // second ensureModel that passes the not-yet-ready check and downloads + hashes the ~311MB
  // model twice, racing setModelState into out-of-order downloading/error/ready writes. Sharing
  // the in-flight promise makes every caller wait for the same operation.
  //
  // The dedup entry is ABANDONABLE, not permanent: the underlying download can stall forever
  // (fetch/reader.read() carry no abort signal here), so we race it against a deadline. On
  // timeout the promise rejects and the finally clears the entry, so the next start begins a
  // fresh download instead of awaiting the stuck one until the service worker restarts. Each
  // attempt carries a generation token: a superseded (timed-out) attempt keeps running in the
  // background, but model-manager drops its late state/blob commits so it can't overwrite the
  // retry's result.
  // A reset in flight must be a barrier: a start that begins after the reset bumped the generation
  // carries a NEWER token (so it is not superseded), and without awaiting the reset it could read
  // the pre-clear `ready` state and report alreadyReady for a model reset is about to remove.
  if (resettingModel) await resettingModel.catch(() => {});
  if (downloadingModel) return await downloadingModel;
  const gen = modelManager.beginModelSetup();
  const mine = withTimeout(
    modelManager.ensureModel('wasm', undefined, gen), // safe default; EP re-selected at inference
    TIMEOUTS.MODEL_DOWNLOAD_MS,
    'model download',
  );
  downloadingModel = mine;
  try {
    return await mine;
  } finally {
    // Clear the handle only if it still refers to THIS invocation's promise — a reset may have
    // already cleared it and a replacement may have populated it; clearing unconditionally would
    // clobber the still-active replacement's dedup handle.
    if (downloadingModel === mine) downloadingModel = null;
  }
}

async function resetModel() {
  // Advance the generation FIRST so any in-flight or just-starting ensureModel is superseded
  // (its early supersession check fires before it can report a stale pre-reset `ready`). Then drop
  // the dedup handle so a post-reset MODEL_DOWNLOAD_START starts a fresh attempt, and run the reset
  // (clear blobs + persist `missing`) through the model-manager's serialized write queue.
  modelManager.beginModelSetup();
  downloadingModel = null;
  const mine = modelManager.resetModelState();
  resettingModel = mine;
  try {
    const result = await mine;
    // After the persisted reset completes, drop in-memory state that could serve the old model:
    // recreate the offscreen document (unloads the ONNX session + clears the cached manifest) and
    // clear the analysis cache, so a re-download under the same key can't reuse stale weights or
    // verdicts computed by the removed model.
    await recreateOffscreenDocument().catch(() => {});
    analysisCache.clear();
    inflightAnalysis.clear();
    return result;
  } finally {
    if (resettingModel === mine) resettingModel = null;
  }
}
