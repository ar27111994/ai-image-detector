/**
 * Onboarding: one-time model download with progress + integrity verification, then a ready
 * state with next steps. Progress is announced accessibly; errors offer retry.
 */
import { MSG, STORAGE_KEYS, TIMEOUTS } from '../shared/constants.js';
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
  root.appendChild(hero());

  const statusBox = el('section', { id: 'status', 'aria-live': 'polite' });
  root.appendChild(statusBox);

  const state = await getState();
  render(state);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === MSG.MODEL_DOWNLOAD_PROGRESS) render(msg.payload);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STORAGE_KEYS.MODEL_STATE]) {
      render(changes[STORAGE_KEYS.MODEL_STATE].newValue);
    }
  });
}

function hero() {
  const hero = el('div', { class: 'onboarding-hero' });
  hero.appendChild(el('img', { src: '../icons/icon-128.png', alt: '', width: '64', height: '64' }));
  hero.appendChild(el('h1', {}, 'AI Image Detector'));
  hero.appendChild(
    el(
      'p',
      {},
      'A one-time download of the detection model is required. After setup, the extension works entirely offline — no image ever leaves your device.',
    ),
  );
  return hero;
}

async function getState() {
  try {
    const res = await sendRequest(makeRequest(MSG.MODEL_DOWNLOAD_STATUS, {}, null), {
      timeoutMs: TIMEOUTS.UI_QUERY_MS,
    });
    if (res?.ok) return res.result;
  } catch {
    /* fall through to storage */
  }
  const raw = await chrome.storage.local.get(STORAGE_KEYS.MODEL_STATE);
  return raw[STORAGE_KEYS.MODEL_STATE] ?? { status: 'missing', progress: 0 };
}

function render(state) {
  const box = document.getElementById('status');
  if (!box) return;
  box.textContent = '';
  const status = state?.status ?? 'missing';

  if (status === 'ready') {
    const pill = el('p', { class: 'status-pill ok', role: 'status' }, 'Model ready');
    box.appendChild(pill);
    const steps = el('div', { class: 'next-steps' });
    steps.appendChild(el('h2', {}, "You're all set"));
    const ol = el('ol', {});
    for (const step of [
      'Browse any website — images are analyzed automatically.',
      'Look for the colored confidence badge on each image; click it for a breakdown.',
      'Use the toolbar icon to adjust the threshold or pause a specific site.',
    ]) {
      ol.appendChild(el('li', {}, step));
    }
    steps.appendChild(ol);
    box.appendChild(steps);
    const actions = el('div', { class: 'setup-actions' });
    const done = el('button', { class: 'btn btn-primary' }, 'Start browsing');
    done.addEventListener('click', () => window.close());
    actions.appendChild(done);
    box.appendChild(actions);
    return;
  }

  if (status === 'downloading') {
    const pct = Math.round((state.progress ?? 0) * 100);
    const mb = ((state.downloadedBytes ?? 0) / 1e6).toFixed(0);
    const totalMb = state.totalBytes ? (state.totalBytes / 1e6).toFixed(0) : '?';
    const wrap = el('div', { class: 'progress-wrap' });
    const lbl = el('div', { class: 'progress-label' });
    lbl.appendChild(el('span', { id: 'dl-label' }, 'Downloading detection model'));
    lbl.appendChild(el('span', {}, `${pct}% (${mb} / ${totalMb} MB)`));
    wrap.appendChild(lbl);
    const bar = el('progress', {
      max: '100',
      value: String(pct),
      role: 'progressbar',
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-valuenow': String(pct),
      'aria-labelledby': 'dl-label',
    });
    wrap.appendChild(bar);
    box.appendChild(wrap);
    return;
  }

  if (status === 'error') {
    box.appendChild(
      el(
        'p',
        { class: 'status-pill warn', role: 'alert' },
        `Download failed: ${state.error ?? 'unknown error'}`,
      ),
    );
    const actions = el('div', { class: 'setup-actions' });
    const retry = el('button', { class: 'btn btn-primary' }, 'Retry download');
    retry.addEventListener('click', startDownload);
    actions.appendChild(retry);
    box.appendChild(actions);
    return;
  }

  // missing
  box.appendChild(
    el(
      'p',
      { class: 'muted' },
      'The detection model (a few hundred MB) is downloaded once, verified, and stored locally.',
    ),
  );
  const actions = el('div', { class: 'setup-actions' });
  const start = el('button', { class: 'btn btn-primary' }, 'Download model');
  start.addEventListener('click', startDownload);
  actions.appendChild(start);
  box.appendChild(actions);
}

async function startDownload() {
  const box = document.getElementById('status');
  box.textContent = '';
  const wrap = el('div', { class: 'progress-wrap' });
  wrap.appendChild(el('p', { class: 'muted' }, 'Starting download…'));
  box.appendChild(wrap);
  try {
    await sendRequest(makeRequest(MSG.MODEL_DOWNLOAD_START, {}, null), {
      timeoutMs: TIMEOUTS.MODEL_DOWNLOAD_MS,
    });
  } catch (err) {
    box.textContent = '';
    box.appendChild(
      el(
        'p',
        { class: 'status-pill warn', role: 'alert' },
        `Failed to start: ${err?.message ?? err}`,
      ),
    );
  }
}

init();
