/**
 * Toolbar popup: model status, per-page scan stats, AI-threshold control, per-site toggle.
 * All styling comes from the shared design tokens (extension/pages/tokens.css). Fully keyboard
 * and screen-reader accessible.
 */
import { DEFAULT_SETTINGS, MSG, STORAGE_KEYS, TIMEOUTS } from '../shared/constants.js';
import { makeRequest, sendRequest } from '../shared/protocol.js';
import { isSiteEnabled } from '../shared/settings.js';

const root = document.getElementById('popup-root');

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
  root.appendChild(header());
  // Loading placeholder so the popup doesn't flash empty while the service worker responds.
  const loading = el('div', { class: 'popup-loading', role: 'status', 'aria-live': 'polite' });
  loading.appendChild(el('span', { class: 'skeleton skeleton-block' }, ''));
  loading.appendChild(el('span', { class: 'skeleton skeleton-block' }, ''));
  root.appendChild(loading);

  let status = null;
  let settings = { ...DEFAULT_SETTINGS };
  let tabStats;
  try {
    const [statusRes, settingsRes, statsRes] = await Promise.all([
      sendRequest(makeRequest(MSG.GET_STATUS, {}, null), { timeoutMs: TIMEOUTS.UI_QUERY_MS }),
      sendRequest(makeRequest(MSG.GET_SETTINGS, {}, null), { timeoutMs: TIMEOUTS.UI_QUERY_MS }),
      currentTabStats(),
    ]);
    loading.remove();
    if (statusRes?.ok) status = statusRes.result;
    if (settingsRes?.ok) settings = { ...settings, ...settingsRes.result };
    tabStats = statsRes;
  } catch (err) {
    loading.remove();
    const isTimeout = /timeout/i.test(String(err?.message ?? ''));
    root.appendChild(
      el(
        'p',
        { class: 'popup-error', role: 'alert' },
        isTimeout
          ? 'Background worker is busy or not responding (timeout). Try again in a moment.'
          : 'Extension error — try reloading the extension from chrome://extensions.',
      ),
    );
    return;
  }

  root.appendChild(statusSection(status));
  if (status?.ready) root.appendChild(statsSection(tabStats));
  root.appendChild(thresholdControl(settings));
  root.appendChild(siteToggle());
  root.appendChild(footer());
}

function header() {
  const h = el('header', { class: 'popup-header' });
  const img = el('img', { src: '../icons/icon-32.png', width: '24', height: '24', alt: '' });
  h.appendChild(img);
  h.appendChild(el('h1', {}, 'AI Image Detector'));
  return h;
}

function statusSection(status) {
  const box = el('section', { class: 'popup-section' });
  box.appendChild(el('h2', {}, 'Status'));
  const model = status?.model ?? { status: 'unknown' };
  const ready = status?.ready;

  const cls = ready ? 'ok' : model.status === 'downloading' ? 'busy' : 'warn';
  const badge = el('span', { class: `status-pill ${cls}`, role: 'status' });
  badge.textContent = ready
    ? 'Ready — running offline'
    : model.status === 'downloading'
      ? `Downloading model… ${Math.round((model.progress ?? 0) * 100)}%`
      : model.status === 'error'
        ? 'Setup error'
        : 'Setup required';
  box.appendChild(badge);

  if (!ready && model.status !== 'downloading') {
    box.appendChild(el('div', { class: 'opt-hint' }, ''));
    const setup = el('button', { class: 'btn btn-link' }, 'Open setup');
    setup.addEventListener('click', () =>
      chrome.tabs.create({ url: chrome.runtime.getURL('pages/onboarding.html') }),
    );
    box.appendChild(setup);
  }
  return box;
}

function statsSection(stats) {
  const box = el('section', { class: 'popup-section', 'aria-label': 'This page' });
  box.appendChild(el('h2', {}, 'This page'));
  const grid = el('div', { class: 'stats-grid' });
  const items = [
    ['total', 'Analyzed', stats?.analyzed ?? 0],
    ['ai', 'AI', stats?.ai ?? 0],
    ['real', 'Real', stats?.real ?? 0],
    ['uncertain', 'Unclear', (stats?.uncertain ?? 0) + (stats?.error ?? 0)],
  ];
  for (const [cls, label, value] of items) {
    const cell = el('div', { class: `stat ${cls}` });
    cell.appendChild(el('span', { class: 'stat-value' }, String(value)));
    cell.appendChild(el('span', { class: 'stat-label' }, label));
    grid.appendChild(cell);
  }
  box.appendChild(grid);
  return box;
}

function thresholdControl(settings) {
  const section = el('section', { class: 'popup-section' });
  section.appendChild(el('h2', {}, 'Detection'));
  const row = el('div', { class: 'threshold-row' });
  const label = el('label', { for: 'threshold' }, 'AI threshold');
  const output = el('output', { id: 'threshold-value', for: 'threshold', 'aria-live': 'polite' });
  output.textContent = `${Math.round(settings.threshold * 100)}%`;
  const slider = el('input', {
    type: 'range',
    id: 'threshold',
    min: '5',
    max: '95',
    step: '1',
    'aria-describedby': 'threshold-hint',
  });
  slider.value = String(Math.round(settings.threshold * 100));
  slider.addEventListener('input', () => {
    output.textContent = `${slider.value}%`;
  });
  slider.addEventListener('change', async () => {
    await chrome.storage.local.set({
      [STORAGE_KEYS.SETTINGS]: { ...settings, threshold: Number(slider.value) / 100 },
    });
  });
  row.appendChild(label);
  row.appendChild(slider);
  row.appendChild(output);
  section.appendChild(row);
  section.appendChild(
    el(
      'p',
      { class: 'opt-hint', id: 'threshold-hint' },
      'Images at or above this score are flagged as AI.',
    ),
  );
  return section;
}

function siteToggle() {
  const section = el('section', { class: 'popup-section' });
  section.appendChild(el('h2', {}, 'This site'));
  chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
    const url = tabs[0]?.url;
    let host = null;
    try {
      const u = new URL(url);
      // URL.protocol includes the trailing colon ("https:").
      host = u.protocol === 'https:' || u.protocol === 'http:' ? u.hostname : null;
    } catch {
      host = null;
    }
    if (!host) {
      section.appendChild(el('p', { class: 'muted' }, 'Not available on this page.'));
      return;
    }
    const enabled = await isSiteEnabled(host);
    const row = el('div', { class: 'site-row' });
    const cb = el('input', { type: 'checkbox', id: 'site-toggle' });
    cb.checked = enabled;
    const lbl = el('label', { for: 'site-toggle' }, ` Scan images on ${host}`);
    cb.addEventListener('change', async () => {
      cb.disabled = true;
      try {
        await sendRequest(
          makeRequest(MSG.SET_SITE_ENABLED, { hostname: host, enabled: cb.checked }, null),
          { timeoutMs: TIMEOUTS.PING_MS },
        );
      } finally {
        cb.disabled = false;
      }
    });
    row.appendChild(cb);
    row.appendChild(lbl);
    section.appendChild(row);
  });
  return section;
}

async function currentTabStats() {
  return await new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tabId = tabs[0]?.id;
      if (tabId == null) return resolve(null);
      try {
        const res = await sendRequest(makeRequest(MSG.GET_TAB_STATS, { tabId }, null), {
          timeoutMs: TIMEOUTS.PING_MS,
        });
        resolve(res?.ok ? res.result : null);
      } catch {
        resolve(null);
      }
    });
  });
}

function footer() {
  const f = el('footer', { class: 'popup-footer' });
  const opts = el('button', { class: 'btn btn-link' }, 'Settings');
  opts.addEventListener('click', () => chrome.runtime.openOptionsPage());
  f.appendChild(opts);
  f.appendChild(el('span', { class: 'muted' }, 'All analysis runs on-device.'));
  return f;
}

init();
