/**
 * Options page: threshold, image-size/limits, badge behavior, per-site rules, model info, reset.
 * Uses shared design tokens. Every change announces success via an accessible toast + aria-live.
 */
import { DEFAULT_SETTINGS, STORAGE_KEYS } from '../shared/constants.js';
import { sanitizeSettings } from '../shared/settings.js';

const root = document.getElementById('options-root');

function el(tag, attrs = {}, text = null) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    // Skip ONLY absent attribute values (null/undefined/false) so callers can conditionally
    // include ARIA/etc. without rendering invalid markup like aria-describedby="null". Strict
    // comparison: falsy-but-meaningful values like 0 or '' must still be written.
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  if (text != null) node.textContent = text;
  return node;
}

async function loadAll() {
  const raw = await chrome.storage.local.get([
    STORAGE_KEYS.SETTINGS,
    STORAGE_KEYS.SITE_RULES,
    STORAGE_KEYS.MODEL_STATE,
  ]);
  return {
    settings: sanitizeSettings(raw[STORAGE_KEYS.SETTINGS] ?? DEFAULT_SETTINGS),
    rules: raw[STORAGE_KEYS.SITE_RULES] ?? {},
    modelState: raw[STORAGE_KEYS.MODEL_STATE] ?? { status: 'missing' },
  };
}

async function saveSettings(settings) {
  const clean = sanitizeSettings(settings);
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: clean });
  announce('Settings saved');
  return clean;
}

/** Accessible transient confirmation, announced to screen readers. */
let toastTimer = null;
function announce(message) {
  let toast = document.getElementById('save-toast');
  if (!toast) {
    toast = el('div', {
      id: 'save-toast',
      class: 'save-toast',
      role: 'status',
      'aria-live': 'polite',
    });
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 1800);
}

async function init() {
  const { settings, rules, modelState } = await loadAll();
  root.textContent = '';
  root.appendChild(el('h1', {}, 'AI Image Detector Settings'));
  root.appendChild(generalSection(settings));
  root.appendChild(sitesSection(rules));
  root.appendChild(modelSection(modelState));
  root.appendChild(aboutSection());
}

function generalSection(settings) {
  const s = el('section', { class: 'opt-section', 'aria-labelledby': 'detection-h' });
  s.appendChild(el('h2', { id: 'detection-h' }, 'Detection'));

  s.appendChild(
    numberField(
      'AI confidence threshold (%)',
      Math.round(settings.threshold * 100),
      5,
      95,
      'Score at/above which an image is flagged AI.',
      async (v) => {
        settings.threshold = v / 100;
        await saveSettings(settings);
      },
    ),
  );
  s.appendChild(
    numberField(
      'Minimum image size (px)',
      settings.minImageSize,
      8,
      1024,
      'Skip images smaller than this.',
      async (v) => {
        settings.minImageSize = v;
        await saveSettings(settings);
      },
    ),
  );
  s.appendChild(
    numberField(
      'Max images per page (0 = unlimited)',
      settings.maxImagesPerPage,
      0,
      5000,
      'Cap work on image-heavy pages.',
      async (v) => {
        settings.maxImagesPerPage = v;
        await saveSettings(settings);
      },
    ),
  );
  s.appendChild(
    checkboxField(
      'Automatically scan pages',
      settings.autoScan,
      'Turn detection on or off globally.',
      async (v) => {
        settings.autoScan = v;
        await saveSettings(settings);
      },
    ),
  );
  s.appendChild(
    checkboxField(
      'Show confidence badges on images',
      settings.showBadges,
      'Toggle the on-image score overlay.',
      async (v) => {
        settings.showBadges = v;
        await saveSettings(settings);
      },
    ),
  );
  s.appendChild(
    checkboxField(
      'Analyze only images near the viewport',
      settings.visibleOnly,
      'Defer offscreen images until scrolled into view.',
      async (v) => {
        settings.visibleOnly = v;
        await saveSettings(settings);
      },
    ),
  );

  const posRow = el('div', { class: 'opt-row' });
  const posLabel = el('label', { for: 'badge-position' }, 'Badge position');
  const sel = el('select', { id: 'badge-position', 'aria-describedby': 'badge-position-hint' });
  for (const p of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) {
    const o = el('option', { value: p }, p);
    if (p === settings.badgePosition) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener('change', async () => {
    settings.badgePosition = sel.value;
    await saveSettings(settings);
  });
  posRow.appendChild(posLabel);
  posRow.appendChild(sel);
  s.appendChild(posRow);
  s.appendChild(
    el(
      'p',
      { class: 'opt-hint', id: 'badge-position-hint' },
      'Where the confidence label appears on an image.',
    ),
  );
  return s;
}

function sitesSection(rules) {
  const s = el('section', { class: 'opt-section', 'aria-labelledby': 'sites-h' });
  s.appendChild(el('h2', { id: 'sites-h' }, 'Per-site rules'));
  const entries = Object.entries(rules);
  if (!entries.length) {
    s.appendChild(
      el(
        'p',
        { class: 'muted' },
        'No per-site overrides yet. Toggle a site from the toolbar popup while visiting it.',
      ),
    );
    return s;
  }
  const list = el('ul', { class: 'site-list' });
  for (const [host, enabled] of entries) {
    const li = el('li', {});
    li.appendChild(el('code', {}, host));
    li.appendChild(
      el(
        'span',
        { class: enabled ? 'status-pill ok' : 'status-pill warn' },
        enabled ? 'enabled' : 'disabled',
      ),
    );
    const remove = el(
      'button',
      { class: 'btn btn-link', 'aria-label': `Remove rule for ${host}` },
      'remove',
    );
    remove.addEventListener('click', async () => {
      if (!confirm(`Remove the detection rule for ${host}?`)) return;
      delete rules[host];
      await chrome.storage.local.set({ [STORAGE_KEYS.SITE_RULES]: rules });
      announce(`Removed ${host}`);
      li.remove();
    });
    li.appendChild(remove);
    list.appendChild(li);
  }
  s.appendChild(list);
  return s;
}

function modelSection(modelState) {
  const s = el('section', { class: 'opt-section', 'aria-labelledby': 'model-h' });
  s.appendChild(el('h2', { id: 'model-h' }, 'Model'));
  const card = el('dl', { class: 'model-card' });
  const add = (term, value) => {
    card.appendChild(el('dt', {}, term));
    card.appendChild(el('dd', {}, value));
  };
  add(
    'Status',
    modelState.status === 'ready' ? 'Downloaded & verified (offline)' : modelState.status,
  );
  if (modelState.variant) add('Variant', modelState.variant);
  if (modelState.downloadedBytes)
    add('Size', `${(modelState.downloadedBytes / 1e6).toFixed(0)} MB`);
  add('Detector', 'SwinV2 (haywoodsloan/ai-image-detector, Apache-2.0)');
  s.appendChild(card);

  const reset = el('button', { class: 'btn btn-danger' }, 'Re-download / reset model');
  reset.addEventListener('click', async () => {
    if (
      !confirm(
        'Remove the cached model and re-download it on next setup? This requires internet once.',
      )
    )
      return;
    await chrome.runtime.sendMessage({ type: 'model-reset', payload: {} }).catch(() => {});
    announce('Model reset — opening setup');
    chrome.tabs.create({ url: chrome.runtime.getURL('pages/onboarding.html') });
  });
  s.appendChild(reset);
  return s;
}

function aboutSection() {
  const s = el('section', { class: 'opt-section', 'aria-labelledby': 'privacy-h' });
  s.appendChild(el('h2', { id: 'privacy-h' }, 'Privacy'));
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

function numberField(label, value, min, max, hint, onChange) {
  const wrap = el('div', {});
  const row = el('div', { class: 'opt-row' });
  const id = `f-${label.replace(/\W+/g, '-').toLowerCase()}`;
  const lbl = el('label', { for: id }, label);
  const input = el('input', {
    type: 'number',
    id,
    min: String(min),
    max: String(max),
    'aria-describedby': `${id}-hint`,
  });
  input.value = String(value);
  input.addEventListener('change', async () => {
    await onChange(Number(input.value));
  });
  row.appendChild(lbl);
  row.appendChild(input);
  wrap.appendChild(row);
  if (hint) wrap.appendChild(el('p', { class: 'opt-hint', id: `${id}-hint` }, hint));
  return wrap;
}

function checkboxField(label, value, hint, onChange) {
  const wrap = el('div', {});
  const row = el('div', { class: 'opt-row' });
  const id = `f-${label.replace(/\W+/g, '-').toLowerCase()}`;
  const input = el('input', {
    type: 'checkbox',
    id,
    'aria-describedby': hint ? `${id}-hint` : null,
  });
  input.checked = Boolean(value);
  const lbl = el('label', { for: id }, ` ${label}`);
  input.addEventListener('change', async () => {
    await onChange(input.checked);
  });
  row.appendChild(input);
  row.appendChild(lbl);
  wrap.appendChild(row);
  if (hint) wrap.appendChild(el('p', { class: 'opt-hint', id: `${id}-hint` }, hint));
  return wrap;
}

init();
