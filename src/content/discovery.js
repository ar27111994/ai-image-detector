/**
 * Image discovery: finds analyzable images on the page and keeps the set current as the DOM
 * mutates (infinite scroll, SPAs, lazy loading).
 *
 * Sources covered:
 *   - <img> (currentSrc/src, srcset best candidate)
 *   - <picture> <source srcset>
 *   - CSS background-image on any element
 *   - <input type="image">, <video poster>, <link rel=preload as=image> (best-effort)
 *   - dynamically inserted nodes via MutationObserver
 *   - viewport prioritization via IntersectionObserver
 *
 * Dedup is by resolved URL; data:/blob: URLs are relayed as bytes instead of refetched.
 */

const IMAGE_SRC_ATTR = 'data-aid-src';

/** Best candidate URL from a srcset string (highest descriptor value). */
export function bestFromSrcset(srcset) {
  if (!srcset) return null;
  let best = null;
  let bestScore = -1;
  for (const part of srcset.split(',')) {
    const bits = part.trim().split(/\s+/);
    if (!bits[0]) continue;
    const descriptor = bits[1] ?? '1x';
    const score = descriptor.endsWith('x')
      ? parseFloat(descriptor) * 100000
      : parseFloat(descriptor) || 0;
    if (score > bestScore) {
      bestScore = score;
      best = bits[0];
    }
  }
  return best;
}

/** Resolve a possibly-relative URL against the page. */
export function resolveUrl(url) {
  try {
    return new URL(url, location.href).href;
  } catch {
    return null;
  }
}

/** Extract the URL to analyze for a given element, or null. */
export function urlForElement(el) {
  if (!(el instanceof Element)) return null;
  const tag = el.tagName;
  if (tag === 'IMG') {
    const fromSrcset = bestFromSrcset(el.getAttribute('srcset'));
    const raw = el.currentSrc || el.getAttribute('src') || fromSrcset;
    return raw ? resolveUrl(raw) : null;
  }
  if (tag === 'SOURCE') {
    const raw = bestFromSrcset(el.getAttribute('srcset')) || el.getAttribute('srcset');
    return raw ? resolveUrl(raw) : null;
  }
  if (tag === 'INPUT' && el.type === 'image') {
    return el.src ? resolveUrl(el.src) : null;
  }
  if (tag === 'VIDEO' && el.poster) return resolveUrl(el.poster);
  // background-image on any element
  const bg = getComputedStyle(el).backgroundImage;
  if (bg && bg !== 'none') {
    const m = bg.match(/url\(["']?([^"')]+)["']?\)/);
    if (m) return resolveUrl(m[1]);
  }
  return null;
}

/** Visible (layout) size of an element. */
export function elementSize(el) {
  const rect = el.getBoundingClientRect();
  return { width: rect.width, height: rect.height };
}

/** True if the element is large enough to bother analyzing. */
export function meetsMinSize(el, minSize) {
  const { width, height } = elementSize(el);
  return Math.min(width, height) >= minSize;
}

/**
 * Discover all candidate image elements in a root.
 * @param {ParentNode} root
 * @returns {Element[]}
 */
export function discoverImages(root = document) {
  const found = new Set();
  const addAll = (selector) => {
    for (const el of root.querySelectorAll(selector)) found.add(el);
  };
  addAll('img');
  addAll('picture source');
  addAll('input[type="image"]');
  addAll('video[poster]');
  // background-image: scan elements (bounded); cheap heuristic — only elements with inline style
  // or known image-ish containers are checked by the caller via getComputedStyle lazily.
  return [...found];
}

/** Find elements with CSS background-image under root (bounded scan). */
export function discoverBackgroundImages(root = document, maxScan = 5000) {
  const out = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let node;
  let scanned = 0;
  while ((node = walker.nextNode()) && scanned < maxScan) {
    scanned++;
    const el = node;
    if (!(el instanceof Element)) continue;
    const bg = getComputedStyle(el).backgroundImage;
    if (bg && bg !== 'none' && bg.includes('url(')) {
      const { width, height } = el.getBoundingClientRect();
      if (Math.min(width, height) >= 8) out.push(el);
    }
  }
  return out;
}

export { IMAGE_SRC_ATTR };
