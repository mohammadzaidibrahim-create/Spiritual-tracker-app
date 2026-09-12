// Finding C-4 — a write that did not land must never be reported as saved.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadApp, makeStorage, plain } = require('./harness.js');

test('setStorage returns true when the write lands', () => {
  const app = loadApp();
  assert.strictEqual(app.setStorage({ '2026-09-11': { score: 42 } }), true);
  assert.deepStrictEqual(plain(app.getStorage()), { '2026-09-11': { score: 42 } });
});

test('setStorage returns false when the quota is exhausted', () => {
  const storage = makeStorage();
  const app = loadApp({ storage });
  storage.quotaAfter = 0;                       // every write from here throws
  assert.strictEqual(app.setStorage({ a: 1 }), false);
});

test('a quota failure is classified as a full device, not a blocked browser', () => {
  const storage = makeStorage();
  const app = loadApp({ storage });
  storage.quotaAfter = 0;
  app.setStorage({ a: 1 });
  assert.match(app.storageErrorText(), /storage is full/i);
});

test('saveDay reports failure and does NOT show the success message', () => {
  const storage = makeStorage();
  const app = loadApp({ storage });
  const btn = app.__document.getElementById('save-day-btn-stub');
  app.__document.querySelector = (sel) => (sel === '.save-day-btn' ? btn : null);

  storage.quotaAfter = 0;
  const ok = app.saveDay();

  assert.strictEqual(ok, false, 'saveDay must report failure');
  assert.doesNotMatch(btn.textContent, /Saved!/, 'must not claim the day was saved');
  assert.match(btn.textContent, /Not saved/i);
  assert.strictEqual(app.__alerts.length, 1, 'the user must be told, unmissably');
  assert.match(app.__alerts[0], /could not be saved/i);
});

test('saveDay reports success and persists the day when the write lands', () => {
  const app = loadApp();
  const btn = app.__document.getElementById('save-day-btn-stub');
  app.__document.querySelector = (sel) => (sel === '.save-day-btn' ? btn : null);

  const ok = app.saveDay();

  assert.strictEqual(ok, true);
  assert.match(btn.textContent, /Saved!/);
  assert.strictEqual(app.__alerts.length, 0);
  const keys = Object.keys(app.getStorage());
  assert.strictEqual(keys.length, 1, 'exactly one day written');
  assert.match(keys[0], /^\d{4}-\d{2}-\d{2}$/);
});

test('corrupt history is quarantined, not silently discarded', () => {
  const storage = makeStorage({ spt_v2: '{"2026-04-01":{"score":88}' });   // truncated JSON
  const app = loadApp({ storage });

  assert.deepStrictEqual(plain(app.getStorage()), {}, 'unreadable history reads as empty');

  const quarantined = Object.keys(storage._dump()).filter(k => k.startsWith('spt_v2_corrupt_'));
  assert.strictEqual(quarantined.length, 1, 'the raw value is preserved under a quarantine key');
  assert.strictEqual(storage._dump()[quarantined[0]], '{"2026-04-01":{"score":88}');
});

test('a non-object history value is treated as corrupt', () => {
  const storage = makeStorage({ spt_v2: '["not","a","map"]' });
  const app = loadApp({ storage });
  assert.deepStrictEqual(plain(app.getStorage()), {});
  assert.strictEqual(Object.keys(storage._dump()).filter(k => k.startsWith('spt_v2_corrupt_')).length, 1);
});

test('absent and empty history are normal, not corrupt', () => {
  for (const seed of [{}, { spt_v2: '' }, { spt_v2: '{}' }]) {
    const storage = makeStorage(seed);
    const app = loadApp({ storage });
    assert.deepStrictEqual(plain(app.getStorage()), {});
    assert.strictEqual(Object.keys(storage._dump()).filter(k => k.startsWith('spt_v2_corrupt_')).length, 0);
  }
});

test('a blocked read does not crash and does not quarantine', () => {
  const storage = makeStorage();
  storage.throwOnRead = true;
  const app = loadApp({ storage });
  assert.deepStrictEqual(plain(app.getStorage()), {});
});

test('saveDraft reports the real outcome of both draft writes', () => {
  const storage = makeStorage();
  const app = loadApp({ storage });
  assert.strictEqual(app.saveDraft(), true);
  storage.quotaAfter = storage.writes;          // next write throws
  assert.strictEqual(app.saveDraft(), false);
});

test('config writes report failure instead of swallowing it', () => {
  const storage = makeStorage();
  const app = loadApp({ storage });
  assert.strictEqual(app.saveSectionConfig(), true);
  assert.strictEqual(app._saveDhikrPreferences(), true);
  storage.quotaAfter = storage.writes;
  assert.strictEqual(app.saveSectionConfig(), false);
  assert.strictEqual(app._saveDhikrPreferences(), false);
});
