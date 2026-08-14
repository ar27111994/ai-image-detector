/**
 * Options page: threshold, min image size, badge style/position, per-site rules, model info,
 * and reset. Writes to chrome.storage.local; the content script reacts via onChanged.
 */
import { DEFAULT_SETTINGS, STORAGE_KEYS } from '../shared/constants.js';
import { sanitizeSettings } from '../shared/settings.js';

const root = document.getElementById('options-root');

function el(tag, attrs = {}, text = null) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  if (text != null) node.textContent = text;
  return node;
}

async function loadAll() {
  const raw = await chrome.storage.local.get([STORAGE_KEYS.SETTINGS, STORAGE_KEYS.SITE_RULES]);
  return {
    settings: sanitizeSettings(raw[STORAGE_KEYS.SETTINGS] ?? DEFAULT_SETTINGS),
    rules: raw[STORAGE_KEYS.SITE_RULES] ?? {},
  };
}

async function saveSettings(settings) {
  const clean = sanitizeSettings(settings);
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: clean });
  return clean;
}

async function init() {
  const { settings, rules } = await loadAll();
  root.textContent = '';
  root.appendChild(el('h1', {}, 'AI Image Detector Settings'));

  root.appendChild(generalSection(settings));
  root.appendChild(sitesSection(rules));
  root.appendChild(modelSection());
  root.appendChild(aboutSection());
}

function generalSection(settings) {
  const s = el('section', { class: 'opt-section' });
  s.appendChild(el('h2', {}, 'Detection'));

  s.appendChild(
    numberField(
      'AI confidence threshold (%)',
      Math.round(settings.threshold * 100),
      5,
      95,
      async (v) => {
        settings.threshold = v / 100;
        await saveSettings(settings);
      },
    ),
  );
  s.appendChild(
    numberField('Minimum image size (px)', settings.minImageSize, 8, 1024, async (v) => {
      settings.minImageSize = v;
      await saveSettings(settings);
    }),
  );
  s.appendChild(
    numberField(
      'Max images per page (0 = unlimited)',
      settings.maxImagesPerPage,
      0,
      5000,
      async (v) => {
        settings.maxImagesPerPage = v;
        await saveSettings(settings);
      },
    ),
  );
  s.appendChild(
    checkboxField('Automatically scan pages', settings.autoScan, async (v) => {
      settings.autoScan = v;
      await saveSettings(settings);
    }),
  );
  s.appendChild(
    checkboxField('Show confidence badges on images', settings.showBadges, async (v) => {
      settings.showBadges = v;
      await saveSettings(settings);
    }),
  );
  s.appendChild(
    checkboxField('Analyze only images near the viewport', settings.visibleOnly, async (v) => {
      settings.visibleOnly = v;
      await saveSettings(settings);
    }),
  );

  const posLabel = el('label', { for: 'badge-position' }, 'Badge position ');
  const sel = el('select', { id: 'badge-position' });
  for (const p of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) {
    const o = el('option', { value: p }, p);
    if (p === settings.badgePosition) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener('change', async () => {
    settings.badgePosition = sel.value;
    await saveSettings(settings);
  });
  const posRow = el('div', { class: 'opt-row' });
  posRow.appendChild(posLabel);
  posRow.appendChild(sel);
  s.appendChild(posRow);
  return s;
}

function sitesSection(rules) {
  const s = el('section', { class: 'opt-section' });
  s.appendChild(el('h2', {}, 'Per-site rules'));
  const entries = Object.entries(rules);
  if (!entries.length) {
    s.appendChild(el('p', { class: 'muted' }, 'No per-site overrides yet.'));
    return s;
  }
  const list = el('ul', { class: 'site-list' });
  for (const [host, enabled] of entries) {
    const li = el('li', {});
    li.appendChild(el('code', {}, host));
    li.appendChild(
      el('span', { class: enabled ? 'ok' : 'warn' }, enabled ? ' enabled' : ' disabled'),
    );
    const remove = el('button', { class: 'link-btn' }, 'remove');
    remove.addEventListener('click', async () => {
      delete rules[host];
      await chrome.storage.local.set({ [STORAGE_KEYS.SITE_RULES]: rules });
      li.remove();
    });
    li.appendChild(remove);
    list.appendChild(li);
  }
  s.appendChild(list);
  return s;
}

function modelSection() {
  const s = el('section', { class: 'opt-section' });
  s.appendChild(el('h2', {}, 'Model'));
  const info = el('p', { class: 'muted' }, 'Model metadata is shown after setup completes.');
  s.appendChild(info);

  const reset = el('button', { class: 'danger-btn' }, 'Re-download / reset model');
  reset.addEventListener('click', async () => {
    if (!confirm('Remove the cached model and re-download it on next setup?')) return;
    await chrome.runtime.sendMessage({ type: 'model-reset', payload: {} }).catch(() => {});
    chrome.tabs.create({ url: chrome.runtime.getURL('pages/onboarding.html') });
  });
  s.appendChild(reset);
  return s;
}

function aboutSection() {
  const s = el('section', { class: 'opt-section' });
  s.appendChild(el('h2', {}, 'Privacy'));
  s.appendChild(
    el(
      'p',
      { class: 'muted' },
      'All image analysis runs entirely on your device. After a one-time model download, the extension makes no network requests for inference and never uploads image data.',
    ),
  );
  return s;
}

/* ------------------------------- field helpers ------------------------------- */

function numberField(label, value, min, max, onChange) {
  const row = el('div', { class: 'opt-row' });
  const id = `f-${label.replace(/\W+/g, '-').toLowerCase()}`;
  const lbl = el('label', { for: id }, label);
  const input = el('input', { type: 'number', id, min: String(min), max: String(max) });
  input.value = String(value);
  input.addEventListener('change', async () => {
    await onChange(Number(input.value));
  });
  row.appendChild(lbl);
  row.appendChild(input);
  return row;
}

function checkboxField(label, value, onChange) {
  const row = el('div', { class: 'opt-row' });
  const id = `f-${label.replace(/\W+/g, '-').toLowerCase()}`;
  const input = el('input', { type: 'checkbox', id });
  input.checked = Boolean(value);
  input.addEventListener('change', async () => {
    await onChange(input.checked);
  });
  row.appendChild(input);
  row.appendChild(el('label', { for: id }, ` ${label}`));
  return row;
}

init();
