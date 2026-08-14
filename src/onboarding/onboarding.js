/**
 * Onboarding: one-time model download with progress + integrity verification, then ready state.
 * The download runs in the service worker (model-manager); this page triggers it and renders
 * progress from storage + progress messages.
 */
import { MSG, STORAGE_KEYS } from '../shared/constants.js';
import { makeRequest, sendRequest } from '../shared/protocol.js';

const root = document.getElementById('onboarding-root');

function el(tag, attrs = {}, text = null) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  if (text != null) node.textContent = text;
  return node;
}

async function init() {
  root.textContent = '';
  root.appendChild(el('h1', {}, 'AI Image Detector — Setup'));
  root.appendChild(
    el(
      'p',
      { class: 'muted' },
      'A one-time download of the detection model is required. After this, the extension works entirely offline — no image ever leaves your device.',
    ),
  );

  const statusBox = el('section', { id: 'status' });
  root.appendChild(statusBox);

  const state = await getState();
  render(state);

  // Live updates while the SW reports progress.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === MSG.MODEL_DOWNLOAD_PROGRESS) render(msg.payload);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STORAGE_KEYS.MODEL_STATE]) {
      render(changes[STORAGE_KEYS.MODEL_STATE].newValue);
    }
  });
}

async function getState() {
  try {
    const res = await sendRequest(makeRequest(MSG.MODEL_DOWNLOAD_STATUS, {}, null), {
      timeoutMs: 15000,
    });
    if (res?.ok) return res.result;
  } catch {
    /* fall through */
  }
  const raw = await chrome.storage.local.get(STORAGE_KEYS.MODEL_STATE);
  return raw[STORAGE_KEYS.MODEL_STATE] ?? { status: 'missing', progress: 0 };
}

function render(state) {
  const box = document.getElementById('status');
  box.textContent = '';
  const status = state?.status ?? 'missing';

  if (status === 'ready') {
    box.appendChild(el('p', { class: 'status-pill ok' }, 'Model ready — you can browse now.'));
    box.appendChild(el('p', { class: 'muted' }, 'Images on pages will be analyzed automatically.'));
    const close = el('button', { class: 'primary-btn' }, 'Done');
    close.addEventListener('click', () => window.close());
    box.appendChild(close);
    return;
  }

  if (status === 'downloading') {
    const pct = Math.round((state.progress ?? 0) * 100);
    const mb = ((state.downloadedBytes ?? 0) / 1e6).toFixed(0);
    const totalMb = state.totalBytes ? (state.totalBytes / 1e6).toFixed(0) : '?';
    box.appendChild(el('p', {}, `Downloading model… ${pct}% (${mb} / ${totalMb} MB)`));
    const bar = el('progress', { max: '100', value: String(pct) });
    box.appendChild(bar);
    return;
  }

  if (status === 'error') {
    box.appendChild(
      el('p', { class: 'status-pill warn' }, `Download failed: ${state.error ?? 'unknown error'}`),
    );
    const retry = el('button', { class: 'primary-btn' }, 'Retry');
    retry.addEventListener('click', startDownload);
    box.appendChild(retry);
    return;
  }

  // missing
  box.appendChild(
    el(
      'p',
      {},
      'The detection model (~a few hundred MB) will be downloaded once and stored locally.',
    ),
  );
  const start = el('button', { class: 'primary-btn' }, 'Download model');
  start.addEventListener('click', startDownload);
  box.appendChild(start);
}

async function startDownload() {
  const box = document.getElementById('status');
  box.textContent = '';
  box.appendChild(el('p', {}, 'Starting download…'));
  try {
    await sendRequest(makeRequest(MSG.MODEL_DOWNLOAD_START, {}, null), { timeoutMs: 600000 });
  } catch (err) {
    box.textContent = '';
    box.appendChild(el('p', { class: 'status-pill warn' }, `Failed: ${err?.message ?? err}`));
  }
}

init();
