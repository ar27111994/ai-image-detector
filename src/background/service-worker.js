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
  STORAGE_KEYS,
  TIMEOUTS,
} from '../shared/constants.js';
import { isRequest, makeError, makeOk, nextId, sendRequest } from '../shared/protocol.js';
import { imageContentKey } from '../shared/hash.js';
import { LruCache } from '../shared/lru-cache.js';
import * as modelManager from './model-manager.js';
import { isSiteEnabled, loadSettings, setSiteEnabled } from '../shared/settings.js';

let creatingOffscreen = null;
let initializingSession = null;
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
 * existing (unresponsive) document first so the next ensure-offscreen call starts clean.
 * Closing a healthy document is safe — the next request just recreates it.
 */
async function recreateOffscreenDocument() {
  const url = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  try {
    await chrome.offscreen.closeDocument();
  } catch {
    /* no document to close — fine */
  }
  // Re-verify none remains, then drop the cached-manifest/session guards so a fresh create
  // + warm-up happens on the next ensure call.
  const existing = await chrome.runtime
    .getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] })
    .catch(() => []);
  if (existing.length === 0) return;
}

/**
 * Warm the inference session inside the offscreen document (idempotent; dedupes concurrent
 * calls). If the warm-up fails because the offscreen document is gone or unresponsive (e.g. it
 * was killed), the document is recreated once and the warm-up retried before surfacing the error.
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
    // Recover from a crashed/stale offscreen document once: recreate + warm again.
    console.warn('[ai-detector] inference warm-up failed, recreating offscreen doc:', err?.message);
    await recreateOffscreenDocument();
    await ensureOffscreenDocument();
    return await warmSession();
  }
}

/** Single warm-up attempt (dedupes concurrent callers via initializingSession). */
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

async function fetchImageBytes(url) {
  const response = await fetch(url, { credentials: 'omit', cache: 'force-cache' });
  if (!response.ok) throw new Error(`image fetch failed: HTTP ${response.status}`);
  const length = Number(response.headers.get('content-length')) || 0;
  if (length > MAX_IMAGE_BYTES) throw new Error(`image too large (${length} bytes)`);
  const blob = await response.blob();
  if (blob.size > MAX_IMAGE_BYTES) throw new Error(`image too large (${blob.size} bytes)`);
  return await blob.arrayBuffer();
}

/* ------------------------------- message routing ------------------------------- */

/**
 * Only accept messages from this extension's own contexts (content scripts, pages, offscreen).
 * External pages/other extensions cannot drive analysis or mutate state.
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
  const host = sender?.url ? safeHostname(sender.url) : null;
  if (host && !(await isSiteEnabled(host))) {
    return { skipped: true, reason: 'site-disabled' };
  }

  if (url.startsWith('data:') || url.startsWith('blob:')) {
    return { skipped: true, reason: 'bytes-required' };
  }

  const bytes = await fetchImageBytes(url);
  const result = await analyzeBytes(bytes, url, minSize ?? settings.minImageSize);
  recordTabVerdict(sender?.tab?.id, result);
  return result;
}

async function analyzeByBytes(payload, sender) {
  const { bytes, minSize } = payload ?? {};
  const buffer = normalizeBytes(bytes);
  if (!buffer) throw Object.assign(new Error('bytes required'), { code: 'BAD_INPUT' });
  const settings = await loadSettings();
  const result = await analyzeBytes(buffer, null, minSize ?? settings.minImageSize);
  recordTabVerdict(sender?.tab?.id, result);
  return result;
}

function normalizeBytes(bytes) {
  if (bytes instanceof ArrayBuffer) return bytes;
  if (bytes?.data && Array.isArray(bytes.data)) return Uint8Array.from(bytes.data).buffer;
  return null;
}

function safeHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

async function analyzeBytes(bytes, sourceUrl, minSize) {
  const key = await imageContentKey(bytes);
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
        payload: { contentHash: key, bytes, minSize },
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
    inflightAnalysis.delete(key);
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
  // ensureModel prefers a bundled copy (zero download) and falls back to a verified download.
  return await modelManager.ensureModel('wasm'); // safe default; EP re-selected at inference
}

async function resetModel() {
  const { clearModelStore } = await import('../shared/model-store.js');
  await clearModelStore();
  await chrome.storage.local.set({
    [STORAGE_KEYS.MODEL_STATE]: { status: 'missing', progress: 0, error: null },
  });
  return { reset: true };
}
