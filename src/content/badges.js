/**
 * Badge overlay renderer. Attaches an accessible Shadow-DOM badge to each analyzed image,
 * color-coded by verdict, click/keyboard-activatable for a detail breakdown, and kept positioned
 * as the page scrolls/resizes/mutates.
 *
 * Badges are non-destructive: absolutely-positioned overlays appended to <body> (no layout
 * impact on the host page). Colors come from the shared verdict token table.
 */

const BADGE_ATTR = 'data-ai-detector-badge';
const WRAPPED_ATTR = 'data-ai-detector-wrapped';

/**
 * Verdict presentation tokens (WCAG AA contrast: fg on bg >= 4.5:1). These mirror the
 * --color-ai / --color-real / --color-uncertain / --color-neutral tokens in
 * extension/pages/tokens.css; they are inlined here because the content script cannot
 * @import the extension stylesheet into the page's shadow DOM.
 */
const VERDICT_TOKENS = {
  ai: { bg: 'rgb(198, 40, 40)', fg: '#ffffff', label: 'AI', icon: '⚠' },
  real: { bg: 'rgb(46, 125, 50)', fg: '#ffffff', label: 'Real', icon: '✓' },
  uncertain: { bg: 'rgb(245, 171, 53)', fg: '#1f1a00', label: 'Unclear', icon: '?' },
  error: { bg: 'rgb(97, 97, 97)', fg: '#ffffff', label: 'N/A', icon: '—' },
  skipped: { bg: 'rgb(97, 97, 97)', fg: '#ffffff', label: 'Skipped', icon: '·' },
};

const POSITION_STYLES = {
  'top-left': 'top:4px;left:4px;',
  'top-right': 'top:4px;right:4px;',
  'bottom-left': 'bottom:4px;left:4px;',
  'bottom-right': 'bottom:4px;right:4px;',
};

/**
 * Attach or update a badge on an image element.
 * @param {Element} el the image to badge
 * @param {{ score: number|null, verdict: string, reasons?: string[], cached?: boolean, ep?: string, latencyMs?: number, neuralScore?: number }} result analysis result
 * @param {{ position?: string, show?: boolean }} [opts] position = badge corner; show=false removes the badge
 * @returns {void}
 */
export function setBadge(el, result, opts = {}) {
  if (!opts.show) {
    removeBadge(el);
    return;
  }
  const host = ensureBadgeHost(el);
  if (!host) return;
  const shadow = host.shadowRoot;
  const badge = shadow.querySelector('.badge');
  const verdict = result.verdict ?? (result.score == null ? 'error' : 'uncertain');
  const c = VERDICT_TOKENS[verdict] ?? VERDICT_TOKENS.error;

  const pct = result.score == null ? '' : `${Math.round(result.score * 100)}%`;
  const text =
    result.score == null ? c.label : `${pct} ${c.label === 'Unclear' ? '' : c.label}`.trim();

  badge.textContent = `${c.icon} ${text}`.trim();
  badge.setAttribute('style', badgeStyle(c, opts.position ?? 'top-left'));
  badge.dataset.verdict = verdict;
  badge.setAttribute('aria-label', ariaLabel(result, c));
  badge.title = ariaLabel(result, c); // tooltip fallback for sighted users
  badge.dataset.result = encodeURIComponent(
    JSON.stringify({
      score: result.score,
      verdict,
      reasons: result.reasons ?? [],
      ep: result.ep,
      latencyMs: result.latencyMs,
    }),
  );
}

/**
 * Remove a badge (and its observers) if present.
 * @param {Element} el
 * @returns {void}
 */
export function removeBadge(el) {
  const host = findBadgeHost(el);
  if (host) host.remove();
  badgeHosts.delete(el);
  el.removeAttribute(WRAPPED_ATTR);
}

function ariaLabel(result, token) {
  const parts = [`AI image detection: ${token.label}`];
  if (result.score != null) parts.push(`confidence ${Math.round(result.score * 100)} percent`);
  if (result.reasons?.length) parts.push(`signals: ${result.reasons.slice(0, 3).join(', ')}`);
  return parts.join('. ');
}

function badgeStyle(colors, position) {
  return [
    'all:initial;',
    'display:inline-flex;',
    'align-items:center;',
    'gap:4px;',
    'font:600 11px/1.4 system-ui,sans-serif;',
    'padding:2px 7px;',
    'border-radius:6px;',
    'pointer-events:auto;',
    'cursor:pointer;',
    'z-index:2147483647;',
    `background:${colors.bg};`,
    `color:${colors.fg};`,
    'box-shadow:0 2px 6px rgba(0,0,0,0.4),0 0 1px rgba(0,0,0,0.2);',
    'white-space:nowrap;',
    'border:1px solid rgba(255,255,255,0.25);',
    POSITION_STYLES[position] ?? POSITION_STYLES['top-left'],
    'position:absolute;',
    'user-select:none;',
  ].join('');
}

/**
 * The badge host is an absolutely-positioned span placed relative to the image.
 * @param {Element} el
 * @returns {HTMLElement|null} the badge host element (shadow root attached), or null
 */
function ensureBadgeHost(el) {
  const existing = findBadgeHost(el);
  if (existing) return existing;

  const host = document.createElement('span');
  host.setAttribute(BADGE_ATTR, '1');
  host.style.cssText = 'all:initial;position:absolute;pointer-events:none;z-index:2147483646;';
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  // Theme-aware via prefers-color-scheme: the panel tracks the user's system theme so it
  // stays legible on both light and dark pages. Colors mirror tokens.css.
  style.textContent = `
    :host { color-scheme: light dark; }
    .badge {
      box-sizing: border-box;
      min-height: 24px; /* WCAG 2.5.8 minimum pointer target */
      padding: 3px 8px;
    }
    .badge:focus-visible { outline: 2px solid #fff; outline-offset: 1px; box-shadow: 0 0 0 3px #4f46e5; }
    .badge-panel { all: initial; position: absolute; top: calc(100% + 6px); left: 0; z-index: 2147483647;
      background: #ffffff; color: #1a1d21; border-radius: 8px; padding: 10px 12px;
      font: 400 12px/1.5 system-ui, sans-serif; box-shadow: 0 4px 16px rgba(0,0,0,0.18);
      border: 1px solid rgba(26,29,33,0.14); min-width: 200px; max-width: 280px; }
    .badge-panel h3 { margin: 0 0 6px; font-size: 12px; font-weight: 600; }
    .badge-panel dl { margin: 0; } .badge-panel dt { font-weight: 600; }
    .badge-panel dd { margin: 0 0 4px; color: rgba(26,29,33,0.66); }
    @media (prefers-color-scheme: dark) {
      .badge-panel { background: #16181d; color: #e6e8eb;
        box-shadow: 0 4px 16px rgba(0,0,0,0.5); border-color: rgba(255,255,255,0.12); }
      .badge-panel dd { color: rgba(230,232,235,0.75); }
    }
  `;
  shadow.appendChild(style);

  const badge = document.createElement('button');
  badge.type = 'button';
  badge.className = 'badge';
  badge.setAttribute('aria-haspopup', 'true');
  badge.setAttribute('aria-expanded', 'false');
  shadow.appendChild(badge);

  // Click/keyboard opens a detail panel inside the shadow root.
  badge.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePanel(shadow, badge);
  });
  badge.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      togglePanel(shadow, badge);
    }
    if (e.key === 'Escape') closePanel(shadow, badge);
  });

  positionHost(host, el);
  document.body.appendChild(host);
  el.setAttribute(WRAPPED_ATTR, '1');
  observeElement(el, host);
  return host;
}

function togglePanel(shadow, badge) {
  const existing = shadow.querySelector('.badge-panel');
  if (existing) {
    closePanel(shadow, badge);
    return;
  }
  const data = badge.dataset.result ? JSON.parse(decodeURIComponent(badge.dataset.result)) : {};
  const panel = document.createElement('div');
  panel.className = 'badge-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Detection details');

  // Built with DOM + textContent (never innerHTML) so forensic metadata strings — which are
  // attacker-controlled via crafted image EXIF/XMP/PNG text — can never inject markup.
  const title = document.createElement('h3');
  title.textContent = 'Detection details';
  panel.appendChild(title);
  const dl = document.createElement('dl');
  const addRow = (term, value) => {
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dl.appendChild(dt);
    dl.appendChild(dd);
  };
  if (data.score != null) addRow('AI confidence', `${Math.round(data.score * 100)}%`);
  if (data.verdict) addRow('Verdict', String(data.verdict));
  if (data.ep) addRow('Engine', String(data.ep));
  if (data.latencyMs != null) addRow('Latency', `${data.latencyMs} ms`);
  if (data.reasons?.length) addRow('Signals', data.reasons.map(String).join(' · '));
  panel.appendChild(dl);
  shadow.appendChild(panel);
  badge.setAttribute('aria-expanded', 'true');
}

function closePanel(shadow, badge) {
  shadow.querySelector('.badge-panel')?.remove();
  badge.setAttribute('aria-expanded', 'false');
}

function findBadgeHost(el) {
  return badgeHosts.get(el) ?? null;
}

const badgeHosts = new WeakMap();
const observed = new WeakSet();

function observeElement(el, host) {
  badgeHosts.set(el, host);
  if (observed.has(el)) return;
  observed.add(el);

  let rafId = 0;
  const reposition = () => {
    if (rafId) return; // already scheduled — coalesce (no layout thrash)
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      if (!el.isConnected) {
        teardown();
        return;
      }
      positionHost(host, el);
    });
  };
  const teardown = () => {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    host.remove();
    badgeHosts.delete(el);
    ro.disconnect();
    window.removeEventListener('scroll', reposition, { capture: true });
  };
  const ro = new ResizeObserver(reposition);
  ro.observe(el);
  window.addEventListener('scroll', reposition, { passive: true, capture: true });
}

function positionHost(host, el) {
  const rect = el.getBoundingClientRect();
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  host.style.left = `${rect.left + scrollX}px`;
  host.style.top = `${rect.top + scrollY}px`;
  host.style.width = `${rect.width}px`;
  host.style.height = `${rect.height}px`;
}
