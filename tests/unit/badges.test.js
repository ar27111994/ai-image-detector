/**
 * Unit tests for the badge overlay component (src/content/badges.js) using a light DOM stub.
 * Verifies verdict->token mapping, aria labels, panel toggle, and teardown.
 */
import { describe, expect, it } from 'vitest';

// Minimal DOM/Element/ResizeObserver stubs sufficient for badges.js.
class StubClassList {
  constructor() {
    this._set = new Set();
  }
  add(c) {
    this._set.add(c);
  }
  remove(c) {
    this._set.delete(c);
  }
  contains(c) {
    return this._set.has(c);
  }
}

class StubElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.attributes = {};
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.classList = new StubClassList();
    this._listeners = {};
    this.shadowRoot = null;
    this.isConnected = true;
  }
  setAttribute(k, v) {
    this.attributes[k] = String(v);
  }
  getAttribute(k) {
    return this.attributes[k] ?? null;
  }
  removeAttribute(k) {
    delete this.attributes[k];
  }
  appendChild(c) {
    c._parent = this;
    this.children.push(c);
    return c;
  }
  querySelector(sel) {
    return (
      this.children.find(
        (c) => c.classList?.contains(sel.slice(1)) || c.className === sel.slice(1),
      ) ?? null
    );
  }
  attachShadow() {
    this.shadowRoot = new StubElement('shadowroot');
    return this.shadowRoot;
  }
  addEventListener(type, fn) {
    (this._listeners[type] ??= []).push(fn);
  }
  removeEventListener() {}
  dispatch(type, ev = {}) {
    const evt = { stopPropagation: () => {}, preventDefault: () => {}, ...ev };
    for (const fn of this._listeners[type] ?? []) fn(evt);
  }
  remove() {
    this.isConnected = false;
    // remove from parent children if present
    if (this._parent) {
      const i = this._parent.children.indexOf(this);
      if (i >= 0) this._parent.children.splice(i, 1);
    }
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 100, height: 100 };
  }
  set textContent(v) {
    this._text = v;
  }
  get textContent() {
    return this._text;
  }
  set title(v) {
    this._title = v;
  }
  get title() {
    return this._title;
  }
  setAttributeNS() {}
}

const body = new StubElement('body');
globalThis.document = {
  createElement: (tag) => new StubElement(tag),
  body,
};
globalThis.window = {
  addEventListener: () => {},
  removeEventListener: () => {},
  scrollX: 0,
  scrollY: 0,
};
const roInstances = [];
globalThis.ResizeObserver = class {
  constructor(cb) {
    this.cb = cb;
    this.disconnected = false;
    roInstances.push(this);
  }
  observe() {}
  disconnect() {
    this.disconnected = true;
  }
  trigger() {
    this.cb?.();
  }
};
const scrollListeners = [];
globalThis.window = globalThis.window ?? {};
globalThis.window.addEventListener = (type, fn) => scrollListeners.push({ type, fn });
globalThis.window.removeEventListener = (type, fn) => {
  const i = scrollListeners.findIndex((l) => l.type === type && l.fn === fn);
  if (i >= 0) scrollListeners.splice(i, 1);
};
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

const { setBadge, removeBadge } = await import('../../src/content/badges.js');

function makeImage() {
  const img = new StubElement('img');
  img.isConnected = true;
  return img;
}

describe('badges.setBadge', () => {
  it('renders an AI verdict badge with correct text + aria-label', () => {
    const img = makeImage();
    setBadge(
      img,
      { score: 0.92, verdict: 'ai', reasons: ['c2pa'] },
      { position: 'top-left', show: true },
    );
    const host = body.children.find((c) => c.getAttribute('data-ai-detector-badge'));
    expect(host).toBeTruthy();
    const badge = host.shadowRoot.children.find((c) => c.className === 'badge');
    expect(badge.textContent).toContain('92%');
    expect(badge.textContent).toContain('AI');
    expect(badge.attributes['aria-label']).toMatch(/confidence 92 percent/i);
    expect(badge.dataset.verdict).toBe('ai');
  });

  it('falls back to the error token for an unknown verdict string', () => {
    const img = makeImage();
    setBadge(img, { score: 0.5, verdict: 'not-a-real-verdict' }, { show: true });
    const badge = body.children.at(-1).shadowRoot.children.find((c) => c.className === 'badge');
    expect(badge.dataset.verdict).toBe('not-a-real-verdict'); // recorded as-is
    // ...but rendered with the error presentation token (gray N/A fallback).
    expect(badge.textContent).toContain('50%');
  });

  it('derives the verdict from the score when verdict is omitted (null score -> error)', () => {
    const img = makeImage();
    setBadge(img, { score: null }, { show: true });
    const badge = body.children.at(-1).shadowRoot.children.find((c) => c.className === 'badge');
    expect(badge.textContent).toContain('N/A');
  });

  it('derives an uncertain verdict when verdict is omitted but a score exists', () => {
    const img = makeImage();
    setBadge(img, { score: 0.5 }, { show: true });
    const badge = body.children.at(-1).shadowRoot.children.find((c) => c.className === 'badge');
    expect(badge.textContent).toContain('50%');
  });

  it('renders a real verdict badge', () => {
    const img = makeImage();
    setBadge(img, { score: 0.05, verdict: 'real' }, { show: true });
    const badge = body.children.at(-1).shadowRoot.children.find((c) => c.className === 'badge');
    expect(badge.textContent).toContain('Real');
    expect(badge.dataset.verdict).toBe('real');
  });

  it('renders N/A (no score) for an error verdict', () => {
    const img = makeImage();
    setBadge(img, { score: null, verdict: 'error' }, { show: true });
    const badge = body.children.at(-1).shadowRoot.children.find((c) => c.className === 'badge');
    expect(badge.textContent).toContain('N/A');
  });

  it('removes the badge when show=false', () => {
    const img = makeImage();
    setBadge(img, { score: 0.9, verdict: 'ai' }, { show: true });
    // find THIS image's host (the one most recently appended)
    const host = body.children.at(-1);
    expect(host.getAttribute('data-ai-detector-badge')).toBe('1');
    const before = body.children.length;
    removeBadge(img);
    expect(body.children.length).toBe(before - 1); // host detached from body
    expect(host.isConnected).toBe(false);
    expect(img.getAttribute('data-ai-detector-wrapped')).toBeNull();
  });

  it('click toggles the detail panel and updates aria-expanded', () => {
    const img = makeImage();
    setBadge(
      img,
      { score: 0.88, verdict: 'ai', ep: 'wasm', latencyMs: 42, reasons: ['c2pa'] },
      { show: true },
    );
    const host = body.children.at(-1);
    const badge = host.shadowRoot.children.find((c) => c.className === 'badge');
    expect(badge.attributes['aria-expanded']).toBe('false');
    badge.dispatch('click');
    expect(badge.attributes['aria-expanded']).toBe('true');
    const panel = host.shadowRoot.children.find((c) => c.className === 'badge-panel');
    expect(panel).toBeTruthy();
    badge.dispatch('click');
    expect(badge.attributes['aria-expanded']).toBe('false');
  });

  it('Escape closes the panel', () => {
    const img = makeImage();
    setBadge(img, { score: 0.9, verdict: 'ai' }, { show: true });
    const host = body.children.at(-1);
    const badge = host.shadowRoot.children.find((c) => c.className === 'badge');
    badge.dispatch('click');
    expect(badge.attributes['aria-expanded']).toBe('true');
    badge.dispatch('keydown', { key: 'Escape', preventDefault: () => {} });
    expect(badge.attributes['aria-expanded']).toBe('false');
  });

  it('renders hostile reasons as inert text (no XSS via the detail panel)', () => {
    const img = makeImage();
    setBadge(
      img,
      { score: 0.9, verdict: 'ai', reasons: ['<img onerror=alert(1)>'] },
      { show: true },
    );
    const host = body.children.at(-1);
    const badge = host.shadowRoot.children.find((c) => c.className === 'badge');
    badge.dispatch('click');
    const panel = host.shadowRoot.children.find((c) => c.className === 'badge-panel');
    expect(panel).toBeTruthy();
    // The panel is built with textContent (no innerHTML): the hostile string must appear as
    // literal text and no element markup must be created from it.
    const walk = (n, acc = []) => {
      acc.push(n);
      for (const c of n.children ?? []) walk(c, acc);
      return acc;
    };
    const nodes = walk(panel);
    const dd = nodes.find((n) => n.tagName === 'DD' && (n._text ?? '').includes('onerror'));
    expect(dd).toBeTruthy();
    expect(dd._text).toContain('<img onerror=alert(1)>');
    expect(nodes.some((n) => n.tagName === 'IMG')).toBe(false);
  });

  it('repositions the badge host to follow the image rect', () => {
    const img = makeImage();
    img.getBoundingClientRect = () => ({ left: 40, top: 60, width: 200, height: 100 });
    setBadge(img, { score: 0.9, verdict: 'ai' }, { show: true });
    const host = body.children.at(-1);
    // positionHost ran on attach: host is positioned over the image rect.
    expect(host.style.left).toBe('40px');
    expect(host.style.top).toBe('60px');
    expect(host.style.width).toBe('200px');
    expect(host.style.height).toBe('100px');
  });

  it('reuses the existing badge host when setBadge is called again (no duplicate hosts)', () => {
    const img = makeImage();
    setBadge(img, { score: 0.5, verdict: 'uncertain' }, { show: true });
    const before = body.children.length;
    setBadge(img, { score: 0.9, verdict: 'ai' }, { show: true }); // update in place
    expect(body.children.length).toBe(before); // no new host appended
    const badge = body.children.at(-1).shadowRoot.children.find((c) => c.className === 'badge');
    expect(badge.dataset.verdict).toBe('ai');
  });

  it('positions the badge in each corner per the position option', () => {
    for (const pos of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) {
      const img = makeImage();
      setBadge(img, { score: 0.9, verdict: 'ai' }, { show: true, position: pos });
      const badge = body.children.at(-1).shadowRoot.children.find((c) => c.className === 'badge');
      const style = badge.getAttribute('style');
      const [corner, edge] = pos.split('-');
      expect(style).toContain(`${corner === 'top' ? 'top' : 'bottom'}:4px`);
      expect(style).toContain(`${edge === 'left' ? 'left' : 'right'}:4px`);
    }
  });

  it('removing a badge tears down its observers so a detached element leaves no host', () => {
    const img = makeImage();
    setBadge(img, { score: 0.9, verdict: 'ai' }, { show: true });
    const host = body.children.at(-1);
    removeBadge(img);
    expect(host.isConnected).toBe(false);
    // A second remove is a safe no-op.
    expect(() => removeBadge(img)).not.toThrow();
  });

  it('repositions the badge when the image resizes (ResizeObserver)', async () => {
    const img = makeImage();
    img.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 });
    setBadge(img, { score: 0.9, verdict: 'ai' }, { show: true });
    const host = body.children.at(-1);
    expect(host.style.width).toBe('100px');
    // Simulate a resize: image moves/grows, observer fires, rAF applies the new position.
    img.getBoundingClientRect = () => ({ left: 50, top: 70, width: 300, height: 200 });
    roInstances.at(-1).trigger();
    await new Promise((r) => setTimeout(r, 10)); // rAF is setTimeout(0) in the stub
    expect(host.style.width).toBe('300px');
    expect(host.style.left).toBe('50px');
  });

  it('tears down the badge when the element leaves the DOM during a resize', async () => {
    const img = makeImage();
    setBadge(img, { score: 0.9, verdict: 'ai' }, { show: true });
    const host = body.children.at(-1);
    const ro = roInstances.at(-1);
    img.isConnected = false; // element removed from the page
    ro.trigger(); // observer fires; reposition sees !isConnected -> teardown
    await new Promise((r) => setTimeout(r, 10));
    expect(host.isConnected).toBe(false);
    expect(ro.disconnected).toBe(true);
  });

  it('repositions on window scroll (passive listener)', async () => {
    // A fresh image at a known rect; the scroll handler re-reads the rect on each event.
    const img = makeImage();
    img.getBoundingClientRect = () => ({ left: 7, top: 9, width: 40, height: 40 });
    setBadge(img, { score: 0.9, verdict: 'ai' }, { show: true });
    const host = body.children.at(-1);
    expect(host.style.left).toBe('7px');
    // The badge registers a window 'scroll' listener; capture the one for THIS host.
    const scroll = scrollListeners.filter((l) => l.type === 'scroll').at(-1);
    expect(scroll).toBeTruthy();
    // Move the image and fire scroll; rAF coalesces the reposition.
    img.getBoundingClientRect = () => ({ left: 42, top: 24, width: 40, height: 40 });
    scroll.fn();
    await new Promise((r) => setTimeout(r, 20));
    expect(host.style.left).toBe('42px');
    expect(host.style.top).toBe('24px');
  });
});
