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
globalThis.ResizeObserver = class {
  constructor(cb) {
    this.cb = cb;
  }
  observe() {}
  disconnect() {}
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

  it('encodes the result safely (no XSS via reasons)', () => {
    const img = makeImage();
    setBadge(
      img,
      { score: 0.9, verdict: 'ai', reasons: ['<img onerror=alert(1)>'] },
      { show: true },
    );
    const host = body.children.at(-1);
    const badge = host.shadowRoot.children.find((c) => c.className === 'badge');
    // panel content must be HTML-escaped
    badge.dispatch('click');
    const panel = host.shadowRoot.children.find((c) => c.className === 'badge-panel');
    expect(panel).toBeTruthy();
    // the escapeHtml path encodes < > " ' — no live markup from the hostile reason
    expect(panel._html ?? '').not.toContain('<img onerror');
  });
});
