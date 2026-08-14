/**
 * Content script entry: discovers images, requests analysis from the service worker, and
 * renders confidence badges. Runs in the page's isolated world (no WASM here — all inference
 * happens in the offscreen document).
 */
import { DEFAULT_SETTINGS, MSG, VERDICT } from '../shared/constants.js';
import { makeRequest, sendRequest } from '../shared/protocol.js';
import {
  discoverBackgroundImages,
  discoverImages,
  meetsMinSize,
  urlForElement,
} from './discovery.js';
import { removeBadge, setBadge } from './badges.js';

const MAX_CONCURRENT_ANALYSES = 3;
const OBSERVER_DEBOUNCE_MS = 400;

let settings = { ...DEFAULT_SETTINGS };
let running = false;
let observer = null;
let io = null;
let inFlight = 0;
const queue = [];
const analyzed = new WeakSet();
const urlToElements = new Map(); // url -> Set<Element>

/* --------------------------------- bootstrap --------------------------------- */

async function init() {
  try {
    const pong = await sendRequest(makeRequest(MSG.PING, {}, null), { timeoutMs: 10000 });
    if (!pong?.ok) return;
  } catch {
    return; // extension context invalidated
  }
  document.documentElement.setAttribute('data-ai-detector-connected', 'true');

  try {
    const res = await sendRequest(makeRequest(MSG.GET_SETTINGS, {}, null));
    if (res?.ok && res.result) settings = { ...settings, ...res.result };
  } catch {
    /* defaults are fine */
  }

  if (!settings.autoScan) return;
  start();
}

function start() {
  if (running) return;
  running = true;
  scan();
  observeDom();
}

function stop() {
  running = false;
  observer?.disconnect();
  io?.disconnect();
  observer = null;
  io = null;
  queue.length = 0;
}

/* --------------------------------- discovery --------------------------------- */

function scan() {
  if (!running) return;
  const elements = [...discoverImages(), ...discoverBackgroundImages()];
  let enqueued = 0;
  for (const el of elements) {
    if (analyzed.has(el)) continue;
    if (!meetsMinSize(el, settings.minImageSize)) continue;
    const url = urlForElement(el);
    if (!url) continue;
    analyzed.add(el);
    register(el, url);
    enqueue(el, url);
    if (++enqueued >= settings.maxImagesPerPage && settings.maxImagesPerPage > 0) break;
  }
  pump();
}

function register(el, url) {
  if (!urlToElements.has(url)) urlToElements.set(url, new Set());
  urlToElements.get(url).add(el);
  if (settings.visibleOnly && io) io.observe(el);
}

function observeDom() {
  observer = new MutationObserver(debounce(() => scan(), OBSERVER_DEBOUNCE_MS));
  observer.observe(document.documentElement, { childList: true, subtree: true });

  io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) prioritize(entry.target);
      }
    },
    { rootMargin: '200px' },
  );
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/* --------------------------------- queueing --------------------------------- */

function enqueue(el, url, { front = false } = {}) {
  const item = { el, url };
  if (front) queue.unshift(item);
  else queue.push(item);
}

function prioritize(el) {
  const idx = queue.findIndex((item) => item.el === el);
  if (idx > 0) {
    const [item] = queue.splice(idx, 1);
    queue.unshift(item);
    pump();
  }
}

function pump() {
  while (running && inFlight < MAX_CONCURRENT_ANALYSES && queue.length) {
    const item = queue.shift();
    if (!item.el.isConnected) continue;
    inFlight++;
    analyze(item)
      .catch(() => {})
      .finally(() => {
        inFlight--;
        pump();
      });
  }
}

/* --------------------------------- analysis --------------------------------- */

async function analyze({ el, url }) {
  try {
    const response = await sendRequest(
      makeRequest(MSG.ANALYZE_IMAGE, { url, minSize: settings.minImageSize }, null),
      { timeoutMs: 120000 },
    );
    if (!response?.ok) {
      showResult(el, {
        verdict: VERDICT.ERROR,
        score: null,
        reasons: [response?.error?.message ?? 'failed'],
      });
      return;
    }
    const result = response.result;
    if (result.skipped) return;
    // Fan the result out to every element showing the same image.
    for (const target of urlToElements.get(url) ?? [el]) {
      showResult(target, result);
    }
  } catch (err) {
    showResult(el, {
      verdict: VERDICT.ERROR,
      score: null,
      reasons: [String(err?.message ?? err)],
    });
  }
}

function showResult(el, result) {
  if (!el.isConnected) return;
  setBadge(el, result, { position: settings.badgePosition, show: settings.showBadges });
}

/* --------------------------- settings changes (live) --------------------------- */

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const next = changes['settings.v1']?.newValue;
  if (next) {
    const wasScanning = running;
    settings = { ...settings, ...next };
    if (!settings.showBadges) {
      for (const els of urlToElements.values()) {
        for (const el of els) removeBadge(el);
      }
    }
    if (settings.autoScan && !wasScanning) start();
    if (!settings.autoScan && wasScanning) stop();
  }
});

init();
