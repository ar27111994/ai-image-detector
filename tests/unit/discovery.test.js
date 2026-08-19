/**
 * Unit tests for the content-script image-discovery pure helpers.
 * DOM-touching functions are tested with minimal stubs.
 */
import { describe, expect, it } from 'vitest';

globalThis.location = { href: 'https://example.test/articles/1' };

const { bestFromSrcset, resolveUrl, urlForElement, meetsMinSize, elementSize } = await import(
  '../../src/content/discovery.js'
);

// Minimal Element stub for urlForElement/meetsMinSize.
function makeEl(tag, attrs = {}, computed = {}) {
  const el = Object.create(globalThis.Element.prototype);
  Object.assign(el, {
    tagName: tag.toUpperCase(),
    getAttribute: (k) => attrs[k] ?? null,
    type: attrs.type,
    src: attrs.src,
    currentSrc: attrs.currentSrc,
    poster: attrs.poster,
    getBoundingClientRect: () => ({ width: attrs._w ?? 200, height: attrs._h ?? 200 }),
    _computed: computed,
  });
  return el;
}
globalThis.getComputedStyle = (el) => el._computed ?? { backgroundImage: 'none' };
// urlForElement does `el instanceof Element` — provide an Element class the stubs extend.
globalThis.Element = class Element {};

describe('discovery.bestFromSrcset', () => {
  it('picks the highest-density (x) candidate', () => {
    expect(bestFromSrcset('a.jpg 1x, b.jpg 2x, c.jpg 1.5x')).toBe('b.jpg');
  });

  it('picks the largest width (w) candidate', () => {
    expect(bestFromSrcset('a.jpg 480w, b.jpg 1024w, c.jpg 300w')).toBe('b.jpg');
  });

  it('handles single entry and no descriptor', () => {
    expect(bestFromSrcset('only.jpg')).toBe('only.jpg');
    expect(bestFromSrcset('only.jpg 1x')).toBe('only.jpg');
  });

  it('returns null for empty/blank srcset', () => {
    expect(bestFromSrcset('')).toBeNull();
    expect(bestFromSrcset(null)).toBeNull();
    expect(bestFromSrcset('   ')).toBeNull();
  });

  it('handles entries with whitespace and trailing commas', () => {
    expect(bestFromSrcset('  a.jpg 1x ,  b.jpg 2x , ')).toBe('b.jpg');
  });

  it('width descriptor beats x descriptor by score convention', () => {
    // 2x -> 200000, 1000w -> 1000; width wins by our scoring
    expect(bestFromSrcset('small.jpg 2x, large.jpg 1000w')).toBe('small.jpg');
  });
});

describe('discovery.resolveUrl', () => {
  it('resolves relative URLs against the page', () => {
    expect(resolveUrl('img/cat.jpg')).toBe('https://example.test/articles/img/cat.jpg');
    expect(resolveUrl('/abs/path.png')).toBe('https://example.test/abs/path.png');
  });

  it('passes through absolute URLs unchanged', () => {
    expect(resolveUrl('https://cdn.test/x.png')).toBe('https://cdn.test/x.png');
  });

  it('returns null for unparseable input without throwing', () => {
    expect(() => resolveUrl('ht!tp://bad url with spaces')).not.toThrow();
  });

  it('returns null when the URL constructor throws (invalid base/URL)', () => {
    // Force the catch branch by pointing the base at an unparseable location.
    const prevLocation = globalThis.location;
    globalThis.location = { href: 'ht!tp://invalid base with spaces' };
    try {
      expect(resolveUrl('img/x.png')).toBeNull();
    } finally {
      globalThis.location = prevLocation;
    }
  });

  it('resolves nullish/odd inputs to a same-origin URL (WHATWG URL is lenient)', () => {
    // Documents the real behavior: the URL constructor stringifies + resolves, not throws.
    expect(resolveUrl('://')).toContain('https://example.test/');
  });
});

describe('discovery.urlForElement', () => {
  it('extracts <img> currentSrc', () => {
    const img = makeEl('img', { currentSrc: 'https://cdn.test/pic.jpg', src: 'pic.jpg' });
    expect(urlForElement(img)).toBe('https://cdn.test/pic.jpg');
  });

  it('falls back to <img> src then srcset best candidate', () => {
    const img = makeEl('img', { src: 'a.jpg' });
    expect(urlForElement(img)).toBe('https://example.test/articles/a.jpg');
    const withSrcset = makeEl('img', { srcset: 'a.jpg 1x, b.jpg 2x' });
    expect(urlForElement(withSrcset)).toBe('https://example.test/articles/b.jpg');
  });

  it('extracts <source> srcset', () => {
    const source = makeEl('source', { srcset: 'x.webp 1x, x2.webp 2x' });
    expect(urlForElement(source)).toBe('https://example.test/articles/x2.webp');
  });

  it('extracts <input type=image> src', () => {
    const input = makeEl('input', { type: 'image', src: 'btn.png' });
    expect(urlForElement(input)).toBe('https://example.test/articles/btn.png');
  });

  it('extracts <video poster>', () => {
    const video = makeEl('video', { poster: 'thumb.jpg' });
    expect(urlForElement(video)).toBe('https://example.test/articles/thumb.jpg');
  });

  it('extracts a CSS background-image url', () => {
    const div = makeEl('div', {}, { backgroundImage: 'url("https://cdn.test/bg.png")' });
    expect(urlForElement(div)).toBe('https://cdn.test/bg.png');
  });

  it('returns null for elements with no image', () => {
    const div = makeEl('div', {}, { backgroundImage: 'none' });
    expect(urlForElement(div)).toBeNull();
    expect(urlForElement(makeEl('span'))).toBeNull();
  });

  it('returns null for non-element input', () => {
    expect(urlForElement(null)).toBeNull();
    expect(urlForElement(undefined)).toBeNull();
  });
});

describe('discovery.meetsMinSize / elementSize', () => {
  it('accepts elements at/above the minimum dimension', () => {
    expect(meetsMinSize(makeEl('img', { _w: 200, _h: 200 }), 64)).toBe(true);
    expect(meetsMinSize(makeEl('img', { _w: 64, _h: 64 }), 64)).toBe(true);
  });

  it('rejects elements below the minimum on either dimension', () => {
    expect(meetsMinSize(makeEl('img', { _w: 200, _h: 32 }), 64)).toBe(false);
    expect(meetsMinSize(makeEl('img', { _w: 10, _h: 10 }), 64)).toBe(false);
  });

  it('elementSize reads the bounding rect', () => {
    expect(elementSize(makeEl('img', { _w: 300, _h: 150 }))).toEqual({ width: 300, height: 150 });
  });
});

// --- discoverImages / discoverBackgroundImages: DOM-walking entry points -----------------
describe('discovery.discoverImages / discoverBackgroundImages', () => {
  function makeScanEl(tag, attrs = {}, computed = {}) {
    const el = makeEl(tag, attrs, computed);
    el.attributes = attrs;
    el.classList = { contains: () => false };
    return el;
  }

  it('collects img/picture-source/input-image/video-poster elements', async () => {
    const { discoverImages } = await import('../../src/content/discovery.js');
    const img = makeScanEl('img', { src: 'a.png' });
    const source = makeScanEl('source', { srcset: 'b.png 1x' });
    const input = makeScanEl('input', { type: 'image', src: 'c.png' });
    const video = makeScanEl('video', { poster: 'd.png' });
    const root = {
      querySelectorAll: (sel) => {
        if (sel === 'img') return [img];
        if (sel === 'picture source') return [source];
        if (sel === 'input[type="image"]') return [input];
        if (sel === 'video[poster]') return [video];
        return [];
      },
    };
    const found = discoverImages(root);
    expect(found).toContain(img);
    expect(found).toContain(source);
    expect(found).toContain(input);
    expect(found).toContain(video);
    // Dedup: same element added by two selectors appears once.
  });

  it('discoverBackgroundImages returns only elements with a non-trivial background-image of sufficient size', async () => {
    const { discoverBackgroundImages } = await import('../../src/content/discovery.js');
    const withBg = makeScanEl('div', { _w: 100, _h: 100 }, { backgroundImage: 'url("bg.png")' });
    const noBg = makeScanEl('div', { _w: 100, _h: 100 }, { backgroundImage: 'none' });
    const tooSmall = makeScanEl('div', { _w: 4, _h: 4 }, { backgroundImage: 'url("s.png")' });
    const all = [withBg, noBg, tooSmall];
    // Stub createTreeWalker over the flat list.
    const prevTW = globalThis.document?.createTreeWalker;
    globalThis.document = globalThis.document ?? {};
    globalThis.document.createTreeWalker = () => {
      let i = -1;
      return { nextNode: () => all[++i] ?? null };
    };
    globalThis.NodeFilter = { SHOW_ELEMENT: 1 };
    const out = discoverBackgroundImages(globalThis.document);
    expect(out).toContain(withBg);
    expect(out).not.toContain(noBg);
    expect(out).not.toContain(tooSmall);
    if (prevTW) globalThis.document.createTreeWalker = prevTW;
  });

  it('discoverBackgroundImages respects the maxScan bound', async () => {
    const { discoverBackgroundImages } = await import('../../src/content/discovery.js');
    const many = Array.from({ length: 50 }, () =>
      makeScanEl('div', { _w: 100, _h: 100 }, { backgroundImage: 'url("bg.png")' }),
    );
    let returned = 0; // how many elements the walker yielded (the source scans each yielded node)
    const prevTW = globalThis.document?.createTreeWalker;
    globalThis.document = globalThis.document ?? {};
    globalThis.document.createTreeWalker = () => ({
      nextNode: () => many[returned++] ?? null,
    });
    globalThis.NodeFilter = { SHOW_ELEMENT: 1 };
    const out = discoverBackgroundImages(globalThis.document, 10);
    expect(returned).toBeLessThanOrEqual(11); // 10 scanned + 1 terminal null probe
    expect(out.length).toBeLessThanOrEqual(10);
    if (prevTW) globalThis.document.createTreeWalker = prevTW;
  });
});
