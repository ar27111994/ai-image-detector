/**
 * Shared minimal DOM + browser-API stubs for unit-testing extension UI modules in Node
 * (vitest, environment: 'node'). Extracted so every UI test reuses one stub instead of
 * re-declaring it (DRY). Install via installDomStub(); remove via the returned cleanup.
 *
 * This is intentionally NOT a full DOM — just enough surface (createElement, classList,
 * listeners, shadow root, observers, timers) for the content/page scripts to run.
 */

export class StubClassList {
  constructor() {
    this._set = new Set();
  }
  add(...cs) {
    for (const c of cs) this._set.add(c);
  }
  remove(...cs) {
    for (const c of cs) this._set.delete(c);
  }
  contains(c) {
    return this._set.has(c);
  }
  toggle(c, force) {
    const want = force === undefined ? !this._set.has(c) : force;
    if (want) this._set.add(c);
    else this._set.delete(c);
    return want;
  }
}

export class StubElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.attributes = {};
    this.children = [];
    this.style = {};
    this.dataset = {};
    this._className = '';
    this.classList = new StubClassList();
    this._listeners = {};
    this.shadowRoot = null;
    this.isConnected = true;
    this._parent = null;
    this._text = '';
    this.value = '';
    this.checked = false;
  }
  setAttribute(k, v) {
    const str = String(v);
    this.attributes[k] = str;
    // Keep className/classList in sync when code sets class via setAttribute.
    if (k === 'class') this.className = str;
  }
  get className() {
    return this._className;
  }
  set className(v) {
    this._className = String(v ?? '');
    this.classList = new StubClassList();
    this.classList.add(...this._className.split(/\s+/).filter(Boolean));
  }
  getAttribute(k) {
    return this.attributes[k] ?? null;
  }
  removeAttribute(k) {
    delete this.attributes[k];
  }
  appendChild(c) {
    if (c._parent) c.remove();
    c._parent = this;
    this.children.push(c);
    return c;
  }
  _walk(out = []) {
    for (const c of this.children) {
      out.push(c);
      c._walk(out);
    }
    return out;
  }
  _matches(sel) {
    if (sel.startsWith('.')) return this.classList.contains(sel.slice(1));
    if (sel.startsWith('#')) return this.attributes.id === sel.slice(1);
    return this.tagName === sel.toUpperCase();
  }
  querySelector(sel) {
    return this._walk().find((c) => c._matches(sel)) ?? null;
  }
  querySelectorAll(sel) {
    return this._walk().filter((c) => c._matches(sel));
  }
  attachShadow() {
    this.shadowRoot = new StubElement('shadowroot');
    return this.shadowRoot;
  }
  addEventListener(type, fn) {
    (this._listeners[type] ??= []).push(fn);
  }
  removeEventListener(type, fn) {
    const l = this._listeners[type];
    if (!l) return;
    const i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
  }
  dispatch(type, ev = {}) {
    const evt = { stopPropagation: () => {}, preventDefault: () => {}, ...ev };
    for (const fn of [...(this._listeners[type] ?? [])]) fn(evt);
  }
  click() {
    this.dispatch('click');
  }
  remove() {
    this.isConnected = false;
    if (this._parent) {
      const i = this._parent.children.indexOf(this);
      if (i >= 0) this._parent.children.splice(i, 1);
      this._parent = null;
    }
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100 };
  }
  set textContent(v) {
    this._text = v;
    this.children = [];
  }
  get textContent() {
    if (this.children.length) return this.children.map((c) => c.textContent).join('');
    return this._text;
  }
  set title(v) {
    this._title = v;
  }
  get title() {
    return this._title;
  }
  set innerHTML(v) {
    this._html = v;
  }
  get innerHTML() {
    return this._html ?? '';
  }
  setAttributeNS() {}
}

/**
 * Install the DOM/browser stubs on globalThis. Returns a cleanup function that restores
 * whatever was there before (or deletes the globals).
 */
export function installDomStub() {
  const prev = {};
  const keys = [
    'document',
    'window',
    'ResizeObserver',
    'IntersectionObserver',
    'MutationObserver',
    'requestAnimationFrame',
    'cancelAnimationFrame',
  ];
  for (const k of keys) prev[k] = globalThis[k];

  const body = new StubElement('body');
  const byId = new Map();
  globalThis.document = {
    createElement: (tag) => new StubElement(tag),
    body,
    documentElement: new StubElement('html'),
    getElementById: (id) => {
      if (byId.has(id)) return byId.get(id);
      const hit = body._walk().find((c) => c.attributes?.id === id);
      return hit ?? null;
    },
    querySelector: (sel) => body.querySelector(sel),
    addEventListener: () => {},
    // Test helper: register an element retrievable by id.
    __register: (el) => {
      if (el.attributes?.id) byId.set(el.attributes.id, el);
      return el;
    },
  };
  globalThis.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    scrollX: 0,
    scrollY: 0,
    close: () => {},
    location: { href: 'https://example.test/' },
  };
  globalThis.ResizeObserver = class {
    constructor(cb) {
      this.cb = cb;
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  globalThis.IntersectionObserver = class {
    constructor(cb) {
      this.cb = cb;
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  globalThis.MutationObserver = class {
    constructor(cb) {
      this.cb = cb;
    }
    observe() {}
    disconnect() {}
  };
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

  return function cleanup() {
    for (const k of keys) {
      if (prev[k] === undefined) delete globalThis[k];
      else globalThis[k] = prev[k];
    }
  };
}

/**
 * Install a minimal in-memory chrome.* mock (storage.local, runtime messaging, tabs).
 * Returns { chrome, storage, cleanup, sentMessages } for assertions.
 */
export function installChromeStub() {
  const prev = globalThis.chrome;
  const storage = new Map();
  const listeners = { message: [], changed: [] };
  const sentMessages = [];
  const chrome = {
    runtime: {
      id: 'test-ext-id',
      getURL: (p) => `chrome-extension://test-ext-id/${p}`,
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      sendMessage: async (msg) => {
        sentMessages.push(msg);
        return { ok: true, result: {} };
      },
      openOptionsPage: () => {},
      lastError: null,
    },
    storage: {
      local: {
        get: async (keys) => {
          if (keys == null) return Object.fromEntries(storage);
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of list) if (storage.has(k)) out[k] = storage.get(k);
          return out;
        },
        set: async (obj) => {
          for (const [k, v] of Object.entries(obj)) storage.set(k, v);
        },
        remove: async (keys) => {
          for (const k of Array.isArray(keys) ? keys : [keys]) storage.delete(k);
        },
        clear: async () => storage.clear(),
      },
      onChanged: { addListener: (fn) => listeners.changed.push(fn) },
    },
    tabs: {
      create: async () => ({}),
      query: async (_q, cb) => cb?.([{ id: 1, url: 'https://example.test/' }]),
      onRemoved: { addListener: () => {} },
      onUpdated: { addListener: () => {} },
    },
  };
  globalThis.chrome = chrome;
  return {
    chrome,
    storage,
    sentMessages,
    listeners,
    cleanup() {
      if (prev === undefined) delete globalThis.chrome;
      else globalThis.chrome = prev;
    },
  };
}
