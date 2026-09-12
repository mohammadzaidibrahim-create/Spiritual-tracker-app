// Structural guards. These do not test behaviour — they stop the specific
// defects fixed in Phase 1 from being reintroduced by a later edit.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { appScript } = require('./harness.js');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('the application script parses', () => {
  assert.doesNotThrow(() => new vm.Script(appScript(), { filename: 'index.html<script>' }));
});

test('C-4: no data store is written with a raw localStorage.setItem', () => {
  // Stores holding user data must go through _lsWrite so failures surface.
  // Per-device UI flags are exempt: losing one costs the user nothing.
  const EXEMPT = /spt_bell_seen|spt_reminder|SWIPE_POSITION|\(key,\s*value\)|\(key,\s*'1'\)/;
  const offenders = INDEX.split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => line.includes('localStorage.setItem') && !EXEMPT.test(line));
  assert.deepStrictEqual(offenders, [],
    'these lines bypass _lsWrite and would silently swallow a write failure');
});

test('C-4: setStorage returns its result rather than swallowing it', () => {
  assert.match(INDEX, /function setStorage\(d\)\{\s*return _lsWrite\('spt_v2'/,
    'setStorage must report whether the write landed');
});

test('H-5: no user-supplied name reaches a template without escapeHTML', () => {
  // The old pattern: value="${x.name.replace(/"/g,'&quot;')}" — quote-only,
  // and in one place no escaping at all.
  assert.ok(!/\$\{\s*\w+\.name\.replace\(/.test(INDEX),
    'quote-only attribute escaping has returned');
  // Only HTML contexts need escaping. A name inside a confirm()/alert() string
  // is plain text, where entity-encoding would show the user "&amp;".
  const HTML_CONTEXT = /<[a-z]+[\s>]/;
  const offenders = INDEX.split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => HTML_CONTEXT.test(line) && /\$\{\s*\w+\.name\s*\}/.test(line));
  assert.deepStrictEqual(offenders, [],
    'a name is interpolated into markup without escapeHTML()');
});

test('no service-role or secret key is present in the frontend', () => {
  assert.ok(!/service_role/.test(INDEX), 'service_role key must never ship to the browser');
  assert.ok(!/sb_secret_/.test(INDEX), 'secret key must never ship to the browser');
  // eyJ… is a raw JWT; the publishable key is the only credential allowed here.
  assert.ok(!/eyJ[A-Za-z0-9_-]{20,}\./.test(INDEX), 'a raw JWT is embedded in the page');
  assert.match(INDEX, /SUPABASE_PUBLISHABLE_KEY\s*=\s*'sb_publishable_/,
    'the browser key must be a publishable key');
});
