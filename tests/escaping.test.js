// Finding H-5 — user-supplied names must never reach innerHTML as markup.
// The attack path that matters: a hostile backup file is imported, its dhikr
// names render, and script runs in the app's origin where the Supabase
// session token lives.
//
// State is driven through the app's own input functions rather than assigned
// directly: the module's `let` bindings are lexical and not reachable from the
// sandbox object, so a direct assignment would leave the renderer with empty
// input and the test would pass without proving anything.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadApp } = require('./harness.js');

const PAYLOADS = [
  '<img src=x onerror="alert(1)">',
  '<script>alert(1)<\/script>',
  '"><svg onload=alert(1)>',
  "'><iframe src=javascript:alert(1)>",
  '</div><b>escaped?</b>',
];

// Escaped text legitimately contains substrings like `onerror=`; what matters
// is that the payload never appears verbatim and always appears entity-encoded.
// Computed independently of the app so a broken escapeHTML cannot hide itself.
const expectEscaped = (s) => String(s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const assertInert = (html, payload) => {
  assert.ok(html.length > 0, 'renderer produced output (guards against a vacuous pass)');
  assert.ok(!html.includes(payload), `payload appears verbatim, unescaped: ${payload}`);
  assert.ok(html.includes(expectEscaped(payload)), `payload was not entity-encoded: ${payload}`);
  for (const tag of ['<img', '<script', '<svg', '<iframe', '<b>']) {
    assert.ok(!html.includes(tag), `unescaped ${tag} survived for: ${payload}`);
  }
};

test('escapeHTML neutralises every metacharacter', () => {
  const app = loadApp();
  assert.strictEqual(app.escapeHTML('<&>"\''), '&lt;&amp;&gt;&quot;&#39;');
  assert.strictEqual(app.escapeHTML(null), '');
  assert.strictEqual(app.escapeHTML(undefined), '');
});

test('renderDhikrItems escapes the dhikr name in both text and title', () => {
  for (const payload of PAYLOADS) {
    const app = loadApp();
    app._addDhikrItem(payload);
    assertInert(app.__document.getElementById('dhikr-multi-container').innerHTML, payload);
  }
});

test('renderHabits escapes the habit name in the value attribute', () => {
  for (const payload of PAYLOADS) {
    const app = loadApp();
    app.addHabit();
    app.updateHabitName(1, payload);
    app.renderHabits();
    assertInert(app.__document.getElementById('habits-container').innerHTML, payload);
  }
});

test('renderNaflRows escapes the nafl prayer name', () => {
  for (const payload of PAYLOADS) {
    const app = loadApp();
    app.addNaflRow();
    app.updateNaflName(1, payload);
    app.renderNaflRows();
    assertInert(app.__document.getElementById('extra-nafl-container').innerHTML, payload);
  }
});

test('ordinary names still render as typed', () => {
  const app = loadApp();
  app._addDhikrItem('Astaghfirullah');
  const html = app.__document.getElementById('dhikr-multi-container').innerHTML;
  assert.ok(html.includes('Astaghfirullah'), 'normal text is untouched');
});

test('an apostrophe in a name survives as readable text', () => {
  const app = loadApp();
  app._addDhikrItem("La ilaha illa'llah");
  const html = app.__document.getElementById('dhikr-multi-container').innerHTML;
  assert.ok(html.includes('illa&#39;llah'), 'escaped, not dropped or mangled');
});

test('a hostile name round-trips through storage still inert', () => {
  const payload = '<img src=x onerror=alert(1)>';
  const app = loadApp();
  app._addDhikrItem(payload);
  // Re-render from the persisted preference list, as a fresh page load would.
  const app2 = loadApp({ storage: app.__storage });
  app2._restoreDhikrPreferences();
  app2.renderDhikrItems();
  assertInert(app2.__document.getElementById('dhikr-multi-container').innerHTML, payload);
});
