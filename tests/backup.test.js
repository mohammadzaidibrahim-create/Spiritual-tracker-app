// Finding H-1 — backup must carry every store that holds real user data, and
// import must treat the file as untrusted input.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadApp, makeStorage, plain } = require('./harness.js');

const SEED = {
  spt_v2: JSON.stringify({ '2026-04-01': { score: 50, maxScore: 60 } }),
  spt_draft_v2: JSON.stringify({ date: '2026-04-01', gazeVal: 'success' }),
  spt_drafts_v1: JSON.stringify({ '2026-04-02': { date: '2026-04-02', gazeVal: 'nottracked' } }),
  spt_section_config_v1: JSON.stringify({
    order: ['salah', 'custom_abc'], enabled: { salah: true, custom_abc: true },
    custom: [{ id: 'custom_abc', icon: '🤲', name: 'Dua', subtitle: 'x', tasks: [{ id: 't1', name: 'Morning dua', points: 2 }] }],
  }),
  spt_dhikr_preferences_v1: JSON.stringify(['Istighfar', 'Durood']),
  // Per-device UI state that must NOT travel with a backup.
  spt_swipe_position_v1: JSON.stringify({ '2026-04-01': 3 }),
  spt_bell_seen_v27: '1',
};

test('export carries every store that holds real user data', () => {
  const app = loadApp({ storage: makeStorage(SEED) });
  const p = plain(app.buildBackupPayload());

  assert.deepStrictEqual(Object.keys(p.spt_v2), ['2026-04-01']);
  assert.ok(p.spt_draft_v2, 'active draft');
  assert.ok(p.spt_drafts_v1, 'per-date drafts — absent before this change');
  assert.ok(p.spt_section_config_v1, 'custom sections — absent before this change');
  assert.ok(p.spt_dhikr_preferences_v1, 'dhikr list — absent before this change');
  assert.strictEqual(p.spt_section_config_v1.custom[0].name, 'Dua');
  assert.deepStrictEqual(p.spt_dhikr_preferences_v1, ['Istighfar', 'Durood']);
});

test('export excludes per-device UI state', () => {
  const app = loadApp({ storage: makeStorage(SEED) });
  const p = plain(app.buildBackupPayload());
  assert.ok(!('spt_swipe_position_v1' in p));
  assert.ok(!('spt_bell_seen_v27' in p));
});

test('export is labelled schema 2 and keeps schema-1 keys in place', () => {
  const app = loadApp({ storage: makeStorage(SEED) });
  const p = plain(app.buildBackupPayload());
  assert.strictEqual(p._meta.schema, 2);
  // An older build reads exactly these two top-level keys; both still present.
  assert.ok('spt_v2' in p && 'spt_draft_v2' in p);
});

test('a full backup round-trips onto an empty device', () => {
  const source = loadApp({ storage: makeStorage(SEED) });
  const file = plain(source.buildBackupPayload());

  const target = loadApp();                     // fresh device, nothing stored
  const r = plain(target.applyBackupPayload(file, { confirmFn: () => true }));

  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.dayCount, 1);
  assert.deepStrictEqual(r.restored.sort(), ['custom sections', 'dhikr list', 'saved days', 'unsaved drafts'].sort());

  const after = target.__storage._dump();
  assert.strictEqual(JSON.parse(after.spt_section_config_v1).custom[0].name, 'Dua');
  assert.deepStrictEqual(JSON.parse(after.spt_dhikr_preferences_v1), ['Istighfar', 'Durood']);
  assert.ok(JSON.parse(after.spt_drafts_v1)['2026-04-02']);
});

test('an old schema-1 backup still restores, and leaves absent stores untouched', () => {
  const legacy = {
    _meta: { app: 'Spiritual Tracker', version: '3.1.0-clean-integrated' },
    spt_v2: { '2026-03-01': { score: 30, maxScore: 40 } },
    spt_draft_v2: null,
  };
  const target = loadApp({ storage: makeStorage({ spt_section_config_v1: SEED.spt_section_config_v1 }) });
  const r = plain(target.applyBackupPayload(legacy, { confirmFn: () => true }));

  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.dayCount, 1);
  assert.deepStrictEqual(r.restored, ['saved days'], 'only what the file carried');
  assert.strictEqual(
    JSON.parse(target.__storage._dump().spt_section_config_v1).custom[0].name, 'Dua',
    'existing custom sections are not wiped by a file that has none');
});

test('import merges rather than replaces, with the backup winning on conflict', () => {
  const target = loadApp({ storage: makeStorage({
    spt_v2: JSON.stringify({ '2026-01-01': { score: 1 }, '2026-02-02': { score: 2 } }),
  })});
  target.applyBackupPayload({
    spt_v2: { '2026-02-02': { score: 99 }, '2026-03-03': { score: 3 } },
  }, { confirmFn: () => true });

  const h = plain(target.getStorage());
  assert.deepStrictEqual(Object.keys(h).sort(), ['2026-01-01', '2026-02-02', '2026-03-03']);
  assert.strictEqual(h['2026-01-01'].score, 1, 'local-only day survives');
  assert.strictEqual(h['2026-02-02'].score, 99, 'backup wins on same date');
});

test('malformed day keys and values are skipped, not imported', () => {
  const target = loadApp();
  const r = plain(target.applyBackupPayload({
    spt_v2: {
      '2026-05-05': { score: 10 },
      'not-a-date': { score: 10 },
      '2026-13-45': { score: 10 },
      '__proto__x': { score: 10 },
      '2026-06-06': 'a string, not a day',
      '2026-07-07': ['an array'],
      '2026-08-08': null,
    },
  }, { confirmFn: () => true }));

  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.dayCount, 1, 'only the one well-formed day');
  assert.strictEqual(r.skipped, 6);
  assert.deepStrictEqual(Object.keys(plain(target.getStorage())), ['2026-05-05']);
});

test('a __proto__ key in an untrusted backup cannot pollute the prototype', () => {
  const target = loadApp();
  const hostile = JSON.parse('{"spt_v2":{"__proto__":{"polluted":true},"2026-05-05":{"score":1}}}');
  const r = plain(target.applyBackupPayload(hostile, { confirmFn: () => true }));

  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.dayCount, 1, '__proto__ is not a valid date key');
  assert.strictEqual(({}).polluted, undefined, 'host prototype is clean');
  assert.strictEqual(target.escapeHTML.constructor.prototype.polluted, undefined);
  assert.deepStrictEqual(Object.keys(plain(target.getStorage())), ['2026-05-05']);
});

test('a file that is not a backup is rejected before any write', () => {
  for (const junk of [null, undefined, 42, 'text', [], {}, { nope: 1 }]) {
    const target = loadApp({ storage: makeStorage({ spt_v2: JSON.stringify({ '2026-01-01': { score: 7 } }) }) });
    const r = plain(target.applyBackupPayload(junk, { confirmFn: () => true }));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'not-a-backup');
    assert.deepStrictEqual(Object.keys(plain(target.getStorage())), ['2026-01-01'], 'existing data untouched');
  }
});

test('a backup whose days are all invalid changes nothing', () => {
  const target = loadApp({ storage: makeStorage({ spt_v2: JSON.stringify({ '2026-01-01': { score: 7 } }) }) });
  const r = plain(target.applyBackupPayload({ spt_v2: { bad: 1, worse: 2 } }, { confirmFn: () => true }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no-valid-days');
  assert.deepStrictEqual(Object.keys(plain(target.getStorage())), ['2026-01-01']);
});

test('declining the prompt writes nothing', () => {
  const target = loadApp({ storage: makeStorage({ spt_v2: JSON.stringify({ '2026-01-01': { score: 7 } }) }) });
  const r = plain(target.applyBackupPayload({ spt_v2: { '2026-09-09': { score: 1 } } }, { confirmFn: () => false }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'cancelled');
  assert.deepStrictEqual(Object.keys(plain(target.getStorage())), ['2026-01-01']);
});

test('a restore that cannot be written reports failure', () => {
  const storage = makeStorage();
  const target = loadApp({ storage });
  storage.quotaAfter = storage.writes;
  const r = plain(target.applyBackupPayload({ spt_v2: { '2026-09-09': { score: 1 } } }, { confirmFn: () => true }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'write-failed');
  assert.match(r.detail, /storage is full|blocking local storage/);
});

test('the confirm prompt names what will be replaced', () => {
  const target = loadApp();
  let shown = '';
  target.applyBackupPayload(
    { spt_v2: { '2026-09-09': { score: 1 } }, spt_section_config_v1: { order: [], enabled: {}, custom: [] } },
    { confirmFn: (m) => { shown = m; return false; } });
  assert.match(shown, /1 saved day will be merged in/);
  assert.match(shown, /custom sections will be replaced/);
});

test('unreadable stores are reported rather than silently dropped', () => {
  const app = loadApp({ storage: makeStorage({
    spt_v2: JSON.stringify({ '2026-04-01': { score: 1 } }),
    spt_section_config_v1: '{broken json',
  })});
  const p = plain(app.buildBackupPayload());
  assert.deepStrictEqual(p._unreadable, ['spt_section_config_v1']);
  assert.strictEqual(p.spt_section_config_v1, null);
});
