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

/** Verdict presentation tokens (WCAG AA contrast: fg on bg >= 4.5:1). */
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
 * @param {Element} el
 * @param {{ score: number|null, verdict: string, reasons?: string[], cached?: boolean, ep?: string, latencyMs?: number, neuralScore?: number }} result
 * @param {{ position?: string, show?: boolean }} [opts]
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

/** Remove a badge if present. */
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

/** The badge host is an absolutely-positioned span placed relative to the image. */
function ensureBadgeHost(el) {
  const existing = findBadgeHost(el);
  if (existing) return existing;

  const host = document.createElement('span');
  host.setAttribute(BADGE_ATTR, '1');
  host.style.cssText = 'all:initial;position:absolute;pointer-events:none;z-index:2147483646;';
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    .badge:focus-visible { outline: 2px solid #fff; outline-offset: 1px; box-shadow: 0 0 0 3px #4f46e5; }
    .badge-panel { all: initial; position: absolute; top: calc(100% + 6px); left: 0; z-index: 2147483647;
      background: #16181d; color: #e6e8eb; border-radius: 8px; padding: 10px 12px;
      font: 400 12px/1.5 system-ui, sans-serif; box-shadow: 0 4px 16px rgba(0,0,0,0.5);
      border: 1px solid rgba(255,255,255,0.12); min-width: 200px; max-width: 280px; }
    .badge-panel h3 { margin: 0 0 6px; font-size: 12px; font-weight: 600; }
    .badge-panel dl { margin: 0; } .badge-panel dt { font-weight: 600; }
    .badge-panel dd { margin: 0 0 4px; color: rgba(230,232,235,0.75); }
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
  const rows = [];
  if (data.score != null)
    rows.push(`<dt>AI confidence</dt><dd>${Math.round(data.score * 100)}%</dd>`);
  if (data.verdict) rows.push(`<dt>Verdict</dt><dd>${escapeHtml(String(data.verdict))}</dd>`);
  if (data.ep) rows.push(`<dt>Engine</dt><dd>${escapeHtml(String(data.ep))}</dd>`);
  if (data.latencyMs != null) rows.push(`<dt>Latency</dt><dd>${data.latencyMs} ms</dd>`);
  if (data.reasons?.length) {
    rows.push(`<dt>Signals</dt><dd>${data.reasons.map(escapeHtml).join('<br>')}</dd>`);
  }
  panel.innerHTML = `<h3>Detection details</h3><dl>${rows.join('')}</dl>`;
  shadow.appendChild(panel);
  badge.setAttribute('aria-expanded', 'true');
}

function closePanel(shadow, badge) {
  shadow.querySelector('.badge-panel')?.remove();
  badge.setAttribute('aria-expanded', 'false');
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
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
