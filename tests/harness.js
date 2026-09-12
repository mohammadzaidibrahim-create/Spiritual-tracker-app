// Loads the real application script out of index.html and evaluates it against
// a minimal DOM + localStorage stub, so tests exercise the shipped code rather
// than a copy of it. Everything below the INIT banner is page-boot side effects
// and is intentionally not executed.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INDEX = path.join(__dirname, '..', 'index.html');
const INIT_BANNER = '//  INIT';

/** Walks from the `{` after `startIdx` to its match, ignoring braces in
 *  strings, template literals and comments. */
function matchBrace(src, startIdx) {
  let i = src.indexOf('{', startIdx), depth = 0;
  for (; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') { i = src.indexOf('\n', i); if (i === -1) break; continue; }
    if (c === '/' && n === '*') { i = src.indexOf('*/', i) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      for (i++; i < src.length; i++) {
        if (src[i] === '\\') { i++; continue; }
        if (src[i] === q) break;
      }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
  }
  throw new Error('unbalanced braces from index ' + startIdx);
}

function appScript() {
  const src = fs.readFileSync(INDEX, 'utf8');
  const open = src.indexOf('<script>', src.indexOf('<body>'));
  const body = src.slice(open + '<script>'.length, src.lastIndexOf('</script>'));
  const init = body.lastIndexOf(INIT_BANNER);
  if (init === -1) throw new Error('INIT banner not found — harness needs updating');

  // Everything above the INIT banner: declarations, no page-boot side effects.
  const head = body.slice(0, body.lastIndexOf('// ═', init));

  // A few functions are declared below the banner, interleaved with boot calls.
  // Take just the declarations so callers like loadActiveDate() resolve, while
  // leaving the side effects unexecuted — tests need a deterministic start.
  const tail = body.slice(init);
  const decls = [];
  for (const m of tail.matchAll(/^function\s+\w+\s*\(/gm)) {
    decls.push(tail.slice(m.index, matchBrace(tail, m.index)));
  }
  return head + '\n' + decls.join('\n') + '\n';
}

/** In-memory localStorage. `quotaAfter` makes writes throw, like a full disk. */
function makeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  const store = {
    quotaAfter: Infinity,
    throwOnRead: false,
    writes: 0,
    getItem(k) {
      if (store.throwOnRead) throw new DOMException('blocked', 'SecurityError');
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      if (store.writes >= store.quotaAfter) {
        const e = new Error('The quota has been exceeded.');
        e.name = 'QuotaExceededError';
        throw e;
      }
      store.writes++;
      map.set(k, String(v));
    },
    removeItem(k) { map.delete(k); },
    key(i) { return [...map.keys()][i] ?? null; },
    get length() { return map.size; },
    _dump() { return Object.fromEntries(map); },
    _raw: map,
  };
  return store;
}

/** Just enough DOM for the render and persistence paths under test. */
function makeElement(id = '') {
  const el = {
    id, innerHTML: '', textContent: '', value: '', checked: false, disabled: false,
    style: { setProperty() {} },
    dataset: {},
    className: '',
    children: [],
    classList: {
      _s: new Set(),
      add(...c) { c.forEach(x => this._s.add(x)); },
      remove(...c) { c.forEach(x => this._s.delete(x)); },
      toggle(c, on) { on === undefined ? (this._s.has(c) ? this._s.delete(c) : this._s.add(c)) : (on ? this._s.add(c) : this._s.delete(c)); },
      contains(c) { return this._s.has(c); },
    },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    appendChild(c) { el.children.push(c); return c; },
    removeChild(c) { el.children = el.children.filter(x => x !== c); return c; },
    remove() {}, focus() {}, click() {},
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    getBoundingClientRect() { return { top: 0, bottom: 0, height: 0, width: 0 }; },
    offsetHeight: 0,
  };
  return el;
}

function makeDocument() {
  const els = new Map();
  return {
    _els: els,
    body: makeElement('body'),
    getElementById(id) {
      if (!els.has(id)) els.set(id, makeElement(id));
      return els.get(id);
    },
    createElement(tag) { const e = makeElement(); e.tagName = String(tag).toUpperCase(); return e; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
}

/**
 * Boots the app script in a fresh sandbox.
 * @returns the sandbox — every top-level function/const is a property on it.
 */
function loadApp({ storage = makeStorage(), document = makeDocument() } = {}) {
  const alerts = [];
  const confirms = [];
  const sandbox = {
    localStorage: storage,
    document,
    console: { log() {}, warn() {}, error() {} },
    setTimeout: () => 0,
    clearTimeout: () => {},
    requestAnimationFrame: () => 0,
    ResizeObserver: undefined,
    Chart: undefined,
    html2pdf: undefined,
    alert: (m) => alerts.push(String(m)),
    confirm: (m) => { confirms.push(String(m)); return sandbox.__confirmReply; },
    __confirmReply: true,
    __alerts: alerts,
    __confirms: confirms,
    Blob: class { constructor(p) { this.parts = p; } },
    URL: { createObjectURL: () => 'blob:stub', revokeObjectURL() {} },
    FileReader: class {},
    DOMException: globalThis.DOMException,
    crypto: globalThis.crypto,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(appScript(), sandbox, { filename: 'index.html<script>' });
  sandbox.__storage = storage;
  sandbox.__document = document;
  return sandbox;
}

// Values built inside the VM carry that realm's prototypes, so assert.deepStrictEqual
// would reject them against host-realm literals. Normalise at the boundary.
function plain(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

module.exports = { loadApp, makeStorage, makeDocument, makeElement, appScript, plain };
