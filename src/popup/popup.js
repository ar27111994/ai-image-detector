/**
 * Toolbar popup: model status, threshold control, site toggle. Read-mostly; writes settings
 * straight to chrome.storage (the SW is the source of truth via GET_SETTINGS).
 */
import { DEFAULT_SETTINGS, MSG, STORAGE_KEYS } from '../shared/constants.js';
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

  let status = null;
  let settings = { ...DEFAULT_SETTINGS };
  try {
    const [statusRes, settingsRes] = await Promise.all([
      sendRequest(makeRequest(MSG.GET_STATUS, {}, null), { timeoutMs: 15000 }),
      sendRequest(makeRequest(MSG.GET_SETTINGS, {}, null), { timeoutMs: 15000 }),
    ]);
    if (statusRes?.ok) status = statusRes.result;
    if (settingsRes?.ok) settings = { ...settings, ...settingsRes.result };
  } catch {
    root.appendChild(el('p', { class: 'popup-error' }, 'Background worker unavailable.'));
    return;
  }

  root.appendChild(statusSection(status));
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
  const box = el('section', { class: 'popup-status' });
  const model = status?.model ?? { status: 'unknown' };
  const ready = status?.ready;

  const cls = ready ? 'ok' : model.status === 'downloading' ? 'busy' : 'warn';
  const badge = el('span', { class: `status-pill ${cls}` });
  badge.textContent = ready
    ? 'Ready — running offline'
    : model.status === 'downloading'
      ? `Downloading model… ${Math.round((model.progress ?? 0) * 100)}%`
      : model.status === 'error'
        ? 'Setup error'
        : 'Setup required';
  box.appendChild(badge);

  if (!ready && model.status !== 'downloading') {
    const setup = el('button', { class: 'link-btn' }, 'Open setup');
    setup.addEventListener('click', () =>
      chrome.tabs.create({ url: chrome.runtime.getURL('pages/onboarding.html') }),
    );
    box.appendChild(setup);
  }
  return box;
}

function thresholdControl(settings) {
  const section = el('section', { class: 'popup-threshold' });
  const label = el(
    'label',
    { for: 'threshold' },
    `AI threshold: ${Math.round(settings.threshold * 100)}%`,
  );
  const slider = el('input', { type: 'range', id: 'threshold', min: '5', max: '95', step: '1' });
  slider.value = String(Math.round(settings.threshold * 100));
  slider.addEventListener('input', () => {
    label.textContent = `AI threshold: ${slider.value}%`;
  });
  slider.addEventListener('change', async () => {
    await chrome.storage.local.set({
      [STORAGE_KEYS.SETTINGS]: { ...settings, threshold: Number(slider.value) / 100 },
    });
  });
  section.appendChild(label);
  section.appendChild(slider);
  return section;
}

function siteToggle() {
  const section = el('section', { class: 'popup-site' });
  chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
    const url = tabs[0]?.url;
    let host = null;
    try {
      const u = new URL(url);
      host = /^https?$/.test(u.protocol) ? u.hostname : null;
    } catch {
      host = null;
    }
    if (!host) {
      section.appendChild(el('p', { class: 'muted' }, 'Not available on this page.'));
      return;
    }
    const enabled = await isSiteEnabled(host);
    const cb = el('input', { type: 'checkbox', id: 'site-toggle' });
    cb.checked = enabled;
    cb.addEventListener('change', async () => {
      await sendRequest(
        makeRequest(MSG.SET_SITE_ENABLED, { hostname: host, enabled: cb.checked }, null),
      );
    });
    const row = el('div', { class: 'site-row' });
    row.appendChild(cb);
    row.appendChild(el('label', { for: 'site-toggle' }, ` Enabled on ${host}`));
    section.appendChild(row);
  });
  return section;
}

function footer() {
  const f = el('footer', { class: 'popup-footer' });
  const opts = el('button', { class: 'link-btn' }, 'Settings');
  opts.addEventListener('click', () => chrome.runtime.openOptionsPage());
  f.appendChild(opts);
  f.appendChild(el('span', { class: 'muted' }, 'All analysis runs on-device.'));
  return f;
}

init();
