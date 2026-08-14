/**
 * Badge overlay renderer. Attaches a Shadow-DOM badge to each analyzed image, color-coded by
 * verdict, and keeps it positioned as the page scrolls/resizes/mutates.
 *
 * Badges are non-destructive: absolutely-positioned overlays inside a positioned wrapper that
 * does not alter the image's own layout (we wrap only when the image is not already in a
 * positioned/flowed container that can host an overlay).
 */

const BADGE_ATTR = 'data-ai-detector-badge';
const WRAPPED_ATTR = 'data-ai-detector-wrapped';

const COLORS = {
  ai: { bg: 'rgba(198, 40, 40, 0.92)', fg: '#fff', label: 'AI' },
  real: { bg: 'rgba(46, 125, 50, 0.92)', fg: '#fff', label: 'Real' },
  uncertain: { bg: 'rgba(249, 168, 37, 0.92)', fg: '#212121', label: 'Unclear' },
  error: { bg: 'rgba(97, 97, 97, 0.85)', fg: '#fff', label: 'N/A' },
  skipped: { bg: 'rgba(97, 97, 97, 0.7)', fg: '#fff', label: 'Skipped' },
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
 * @param {{ score: number|null, verdict: string, reasons?: string[], cached?: boolean }} result
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
  const c = COLORS[verdict] ?? COLORS.error;

  const pct = result.score == null ? '' : `${Math.round(result.score * 100)}%`;
  const text =
    result.score == null ? c.label : `${pct} ${c.label === 'Unclear' ? '' : c.label}`.trim();

  badge.textContent = text;
  badge.setAttribute('style', badgeStyle(c, opts.position ?? 'top-left'));
  badge.title = buildTooltip(result);
}

/** Remove a badge if present. */
export function removeBadge(el) {
  const host = findBadgeHost(el);
  if (host) host.remove();
  el.removeAttribute(WRAPPED_ATTR);
}

function buildTooltip(result) {
  const lines = [];
  if (result.score != null) lines.push(`AI confidence: ${Math.round(result.score * 100)}%`);
  if (result.reasons?.length) lines.push(`Signals: ${result.reasons.slice(0, 4).join('; ')}`);
  if (result.ep) lines.push(`Engine: ${result.ep}`);
  return lines.join('\n');
}

function badgeStyle(colors, position) {
  return [
    'all:initial;',
    'display:inline-block;',
    'font:600 11px/1.4 system-ui,sans-serif;',
    'padding:2px 7px;',
    'border-radius:6px;',
    'pointer-events:auto;',
    'cursor:default;',
    'z-index:2147483647;',
    `background:${colors.bg};`,
    `color:${colors.fg};`,
    'box-shadow:0 1px 3px rgba(0,0,0,0.35);',
    'white-space:nowrap;',
    POSITION_STYLES[position] ?? POSITION_STYLES['top-left'],
    'position:absolute;',
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
  const badge = document.createElement('span');
  badge.className = 'badge';
  shadow.appendChild(badge);

  positionHost(host, el);
  document.body.appendChild(host);
  el.setAttribute(WRAPPED_ATTR, '1');
  observeElement(el, host);
  return host;
}

function findBadgeHost(el) {
  // Badge hosts are tracked in a WeakMap via the wrapping attribute.
  return badgeHosts.get(el) ?? null;
}

const badgeHosts = new WeakMap();
const observed = new WeakSet();

function observeElement(el, host) {
  badgeHosts.set(el, host);
  if (observed.has(el)) return;
  observed.add(el);
  // Reposition on scroll/resize (rAF-throttled) and drop if the element leaves the DOM.
  const reposition = () => {
    if (!el.isConnected) {
      host.remove();
      badgeHosts.delete(el);
      return;
    }
    positionHost(host, el);
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
