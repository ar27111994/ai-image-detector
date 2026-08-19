/**
 * Shared constants for the AI Image Detector extension.
 * Single source of truth for message types, storage keys, and defaults.
 */

/** Message types used on the extension message bus (see protocol.js). */
export const MSG = Object.freeze({
  // content script -> service worker
  ANALYZE_IMAGE: 'analyze-image',
  ANALYZE_IMAGE_BYTES: 'analyze-image-bytes',
  GET_SETTINGS: 'get-settings',
  GET_STATUS: 'get-status',
  GET_TAB_STATS: 'get-tab-stats',
  SET_SITE_ENABLED: 'set-site-enabled',

  // service worker -> offscreen document
  OFFSCREEN_ENSURE_READY: 'offscreen-ensure-ready',
  OFFSCREEN_RUN_INFERENCE: 'offscreen-run-inference',
  OFFSCREEN_ANALYZE: 'offscreen-analyze',
  OFFSCREEN_SHUTDOWN: 'offscreen-shutdown',

  // onboarding / model manager
  MODEL_DOWNLOAD_START: 'model-download-start',
  MODEL_DOWNLOAD_PROGRESS: 'model-download-progress',
  MODEL_DOWNLOAD_STATUS: 'model-download-status',
  MODEL_RESET: 'model-reset',

  // responses / events
  ANALYSIS_RESULT: 'analysis-result',
  STATUS_CHANGED: 'status-changed',
  PING: 'ping',
  PONG: 'pong',
});

/** chrome.storage.local keys. */
export const STORAGE_KEYS = Object.freeze({
  SETTINGS: 'settings.v1',
  MODEL_STATE: 'model.state.v1',
  SITE_RULES: 'site.rules.v1',
  STATS: 'stats.v1',
});

/** Default user settings (options page edits these). */
export const DEFAULT_SETTINGS = Object.freeze({
  /** Confidence at/above which an image is labeled AI-generated. */
  threshold: 0.65,
  /** Images smaller than this (min dimension, CSS px) are skipped. */
  minImageSize: 64,
  /** Master switch for automatic scanning. */
  autoScan: true,
  /** Show badge overlays on analyzed images. */
  showBadges: true,
  /** Badge placement corner. */
  badgePosition: 'top-left',
  /** Analyze images only when visible in viewport (vs all discovered). */
  visibleOnly: true,
  /** Maximum images analyzed per page (0 = unlimited). */
  maxImagesPerPage: 200,
});

/** Verdict classes derived from the calibrated score and threshold. */
export const VERDICT = Object.freeze({
  AI: 'ai',
  REAL: 'real',
  UNCERTAIN: 'uncertain',
  ERROR: 'error',
  SKIPPED: 'skipped',
});

/**
 * Band edges around the threshold defining the "uncertain" zone.
 * score >= threshold -> AI; score < 1 - threshold -> REAL; else UNCERTAIN.
 * With the default threshold of 0.65 the uncertain band is [0.35, 0.65).
 */

/** IndexedDB database holding downloaded model weight blobs. */
export const MODEL_DB_NAME = 'ai-image-detector-models';
/** IndexedDB schema version (bump when the object-store layout changes). */
export const MODEL_DB_VERSION = 1;
/** Object store name for model blobs inside MODEL_DB_NAME. */
export const MODEL_STORE = 'models';

/** Offscreen document URL path (relative to extension root). */
export const OFFSCREEN_DOCUMENT_PATH = 'pages/offscreen.html';

/** Analysis cache: max entries keyed by content hash. */
export const ANALYSIS_CACHE_MAX_ENTRIES = 512;

/**
 * Timeout / size budget constants (ms / bytes). Centralized so latency and resource
 * bounds are tuned in one place. Each name encodes its unit.
 */
export const TIMEOUTS = Object.freeze({
  /** Generic message round-trip (content script <-> SW) default. */
  MESSAGE_MS: 120000,
  /** Quick UI reads (status/settings/stats) — should be near-instant. */
  UI_QUERY_MS: 15000,
  /** Fast pings + site toggles. */
  PING_MS: 10000,
  /** Offscreen session warm-up (model load + first inference can be slow). */
  INFERENCE_INIT_MS: 180000,
  /** One full image analysis (multi-view) inside the offscreen document. */
  ANALYZE_MS: 120000,
  /** One-time model download (hundreds of MB over a slow link). */
  MODEL_DOWNLOAD_MS: 600000,
  /** Bound on every IndexedDB operation so a hung store can't stall a worker. */
  IDB_MS: 10000,
  /** WebGPU probe self-test budget before falling back to WASM. */
  WEBGPU_PROBE_MS: 8000,
  /** MutationObserver debounce for image discovery. */
  OBSERVER_DEBOUNCE_MS: 400,
});

/** Hard safety cap (bytes) on a single fetched image — larger images are rejected before decode. */
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

/** Hard cap (bytes) on a single decompressed metadata payload (zTXt/iTXt) — a small compressed
 *  chunk can expand enormously (zip bomb), so decompression is capped well below the image cap. */
export const MAX_METADATA_BYTES = 4 * 1024 * 1024;
