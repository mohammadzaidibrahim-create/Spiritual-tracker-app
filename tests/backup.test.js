// Finding H-1 and P0-11 — backup must carry every store that holds real user
// data; import treats the file as untrusted input, validates it, shows a
// dry-run plan, never overwrites a differing day without an explicit choice,
// and writes all or nothing.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
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
const KEEP = { decide: () => 'keep' };
const BACKUP = { decide: () => 'backup' };
const STORES = ['spt_v2', 'spt_draft_v2', 'spt_drafts_v1', 'spt_section_config_v1', 'spt_dhikr_preferences_v1'];
const snapshot = app => Object.fromEntries(STORES.map(k => [k, app.__storage.getItem(k)]));
const day = (o = {}) => ({ score: 50, maxScore: 100, scoringVersion: 3, gaze: 'success', savedAt: '2026-09-30T18:00:00.000Z', reflection: { win: 'device', improve: '' }, ...o });
const legacy = (o = {}) => { const d = day(o); delete d.scoringVersion; return d; };
const days = app => plain(app.getStorage());
const R = (app, s) => vm.runInContext(s, app);

// ── export ─────────────────────────────────────────────────────────────────

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

test('export is labelled schema 3 and keeps schema-1 keys in place', () => {
  const app = loadApp({ storage: makeStorage(SEED) });
  const p = plain(app.buildBackupPayload());
  assert.strictEqual(p._meta.schema, 3);
  // An older build reads exactly these two top-level keys; both still present.
  assert.ok('spt_v2' in p && 'spt_draft_v2' in p);
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

// ── export: schema 3 (Step 5.2) ────────────────────────────────────────────

const SYNC = { v: 1, h: 'fp1:abc', at: '2026-09-30T18:00:01.000Z' };
const HELD = { ...SYNC, held: { reason: 'both-changed', other: day({ reflection: { win: 'cloud', improve: '' } }), otherFp: 'fp1:d', otherSide: 'cloud' }, err: { kind: 'validation', code: '23514', fp: 'fp1:abc' } };
const FULL_DAYS = {
  '2026-09-30': day({ _sync: SYNC, habits: [{ name: 'Walk', done: true, mins: 20 }, { name: 'Read', done: false, mins: 0 }] }),
  '2026-09-29': day({ score: 91, maxScore: 73, quran: { kahf: true }, _sync: HELD }),     // bonus above max
  '2026-04-03': legacy({ score: -15, maxScore: 60, gaze: 'relapse', gazeScore: -25 }),    // negative legacy
  '2026-04-02': day({ scoringVersion: 2, score: 40 }),
  '2026-04-01': { ...legacy(), scoringVersion: null },
};
const FULL_DRAFTS = {
  '2026-10-01': { date: '2026-10-01', reflectionWin: 'open form', base: { fp: null } },
  '2026-09-30': { date: '2026-09-30', reflectionWin: 'edit', base: { fp: 'fp1:abc' } },
  '2026-09-28': { date: '2026-09-28', gazeVal: 'success', base: { fp: null, legacy: true } },
};
const FULL = {
  ...SEED,
  spt_v2: JSON.stringify(FULL_DAYS),
  spt_draft_v2: JSON.stringify(FULL_DRAFTS['2026-10-01']),
  spt_drafts_v1: JSON.stringify(FULL_DRAFTS),
  // Stage 6.1 bookkeeping: this device's sync state, never part of a backup.
  spt_prefs_sync_v1: JSON.stringify({ h: 'pf1:x', at: '2026-09-30T18:00:00Z' }),
  spt_sync_migrated_v1: '2026-10-02T00:00:00.000Z',
};
const noSync = d => { const o = { ...d }; delete o._sync; return o; };
const noBase = d => { const o = { ...d }; delete o.base; return o; };
const asFile = p => JSON.parse(JSON.stringify(p));   // what a download then upload gives

test('v3 export copies every day exactly as stored, minus _sync — never rescored or upgraded', () => {
  const p = plain(loadApp({ storage: makeStorage(FULL) }).buildBackupPayload());
  assert.deepStrictEqual(Object.keys(p.spt_v2), Object.keys(FULL_DAYS).sort());
  for (const [d, rec] of Object.entries(FULL_DAYS)) {
    assert.deepStrictEqual(p.spt_v2[d], noSync(rec), d);
    assert.ok(!('_sync' in p.spt_v2[d]), d);
  }
  assert.ok(!('scoringVersion' in p.spt_v2['2026-04-03']), 'a legacy day stays legacy');
  assert.strictEqual(p.spt_v2['2026-04-03'].score, -15, 'a negative legacy total is kept');
  assert.strictEqual(p.spt_v2['2026-04-01'].scoringVersion, null);
  assert.strictEqual(p.spt_v2['2026-04-02'].scoringVersion, 2);
  assert.strictEqual(p.spt_v2['2026-09-29'].scoringVersion, 3);
  assert.strictEqual(p.spt_v2['2026-09-29'].score, 91, 'a bonus day above its max is kept');
  assert.deepStrictEqual(p.spt_v2['2026-09-30'].habits, FULL_DAYS['2026-09-30'].habits, 'full habit detail');
});

test('v3 export leaves this device’s sync state behind: no _sync, no draft base, no sync bookkeeping', () => {
  const p = plain(loadApp({ storage: makeStorage(FULL) }).buildBackupPayload());
  for (const [d, dr] of Object.entries(FULL_DRAFTS)) assert.deepStrictEqual(p.spt_drafts_v1[d], noBase(dr), d);
  assert.deepStrictEqual(p.spt_draft_v2, noBase(FULL_DRAFTS['2026-10-01']));
  assert.ok(!('spt_prefs_sync_v1' in p) && !('spt_sync_migrated_v1' in p));
  const text = JSON.stringify(p);
  assert.doesNotMatch(text, /"_sync"/);
  assert.doesNotMatch(text, /"base"/);
  assert.doesNotMatch(text, /fp1:abc|pf1:x/, 'no fingerprint survives anywhere');
});

test('exporting is read-only: no store is written or changed', () => {
  const s = makeStorage(FULL);
  const app = loadApp({ storage: s });
  const before = JSON.stringify(s._dump()), writes = s.writes;
  app.buildBackupPayload();
  app.exportBackup();
  assert.strictEqual(s.writes, writes);
  assert.strictEqual(JSON.stringify(s._dump()), before);
});

test('an invalid section config or dhikr list is left out of the export and reported', () => {
  const app = loadApp({ storage: makeStorage({
    spt_v2: JSON.stringify({ '2026-04-01': day() }),
    spt_section_config_v1: JSON.stringify({ order: 'broken', enabled: {}, custom: [] }),
    spt_dhikr_preferences_v1: JSON.stringify(['Istighfar', 3]),
  })});
  const p = plain(app.exportBackup());
  assert.strictEqual(p.spt_section_config_v1, null);
  assert.strictEqual(p.spt_dhikr_preferences_v1, null);
  assert.deepStrictEqual(p._unreadable, ['spt_section_config_v1', 'spt_dhikr_preferences_v1']);
  assert.match(app.__document.getElementById('backup-status').textContent, /2 store\(s\) could not be read or were invalid/);
});

test('an invalid day is exported as stored and left to the importer to report', () => {
  const bad = { score: 'abc', maxScore: 60 };
  const p = plain(loadApp({ storage: makeStorage({ spt_v2: JSON.stringify({ '2026-04-01': day(), '2026-04-02': bad }) }) }).buildBackupPayload());
  assert.deepStrictEqual(p.spt_v2['2026-04-02'], bad, 'not dropped, not repaired');
  const plan = plain(loadApp().planBackupImport(asFile(p)));
  assert.deepStrictEqual(plan.invalidDays, [{ key: '2026-04-02', why: 'score is not a number' }]);
  assert.deepStrictEqual(plan.newDays, ['2026-04-01']);
});

test('v3 export is deterministic: the same state in a different key order gives the same file', () => {
  const reverse = o => Object.fromEntries(Object.entries(o).reverse().map(([k, v]) => [k, v && typeof v === 'object' && !Array.isArray(v) ? reverse(v) : v]));
  const a = makeStorage(FULL), b = makeStorage({ ...FULL,
    spt_v2: JSON.stringify(reverse(FULL_DAYS)), spt_drafts_v1: JSON.stringify(reverse(FULL_DRAFTS)),
    spt_section_config_v1: JSON.stringify(reverse(JSON.parse(SEED.spt_section_config_v1))) });
  const text = s => { const p = plain(loadApp({ storage: s }).buildBackupPayload()); delete p._meta.exported; return JSON.stringify(p, null, 2); };
  assert.notStrictEqual(a.getItem('spt_v2'), b.getItem('spt_v2'));
  assert.strictEqual(text(a), text(b));
  assert.strictEqual(text(a), text(a), 'and exporting twice gives the same file');
});

test('a v3 export dry-runs and restores onto a clean device, round-tripping every store', () => {
  const file = asFile(plain(loadApp({ storage: makeStorage(FULL) }).buildBackupPayload()));
  const t = loadApp();
  const plan = plain(t.planBackupImport(file));
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.schema, 3);
  assert.deepStrictEqual(plan.newDays, Object.keys(FULL_DAYS).sort());
  assert.deepStrictEqual([plan.conflicts, plan.identical, plan.invalidDays], [[], [], []]);
  assert.deepStrictEqual(plan.drafts.add, Object.keys(FULL_DRAFTS).sort());
  assert.deepStrictEqual(plan.stores, { section: 'replace', dhikr: 'replace' });

  const r = plain(t.applyBackupPayload(file, KEEP));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.added, 5);
  const h = days(t);
  for (const [d, rec] of Object.entries(FULL_DAYS)) assert.deepStrictEqual(h[d], noSync(rec), d);
  const after = t.__storage._dump();
  const drafts = JSON.parse(after.spt_drafts_v1);
  for (const [d, dr] of Object.entries(FULL_DRAFTS)) assert.deepStrictEqual(drafts[d], noBase(dr), d);
  assert.strictEqual(after.spt_draft_v2, undefined, 'an imported draft never becomes the open form');
  assert.deepStrictEqual(JSON.parse(after.spt_section_config_v1), JSON.parse(SEED.spt_section_config_v1));
  assert.deepStrictEqual(JSON.parse(after.spt_dhikr_preferences_v1), JSON.parse(SEED.spt_dhikr_preferences_v1));
});

test('a v3 export imported back onto the same device changes nothing: every day identical', () => {
  const s = makeStorage(FULL);
  const t = loadApp({ storage: s });
  const file = asFile(plain(t.buildBackupPayload()));
  const before = JSON.stringify(s._dump()), writes = s.writes;
  let seen;
  const r = plain(t.applyBackupPayload(file, { decide: p => { seen = plain(p); return 'keep'; } }));
  assert.strictEqual(seen.identical.length, 5, 'identical ignoring _sync');
  assert.deepStrictEqual([seen.newDays, seen.conflicts, seen.drafts.add], [[], [], []]);
  assert.deepStrictEqual(seen.stores, { section: 'same', dhikr: 'same' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.nothing, true);
  assert.strictEqual(s.writes, writes);
  assert.strictEqual(JSON.stringify(s._dump()), before);
});

test('a v3 export goes through the Step 5.1 conflict choice: downgrade flagged, cancel, keep and use-backup', () => {
  const file = asFile(plain(loadApp({ storage: makeStorage(FULL) }).buildBackupPayload()));
  const device = { '2026-04-03': day({ score: 30, savedAt: '2026-10-02T08:00:00.000Z' }), '2026-09-30': day({ reflection: { win: 'newer', improve: '' }, savedAt: '2026-10-02T09:00:00.000Z' }) };
  const seed = { spt_v2: JSON.stringify(device) };

  const plan = plain(loadApp({ storage: makeStorage(seed) }).planBackupImport(file));
  assert.deepStrictEqual(plan.conflicts.map(c => c.date), ['2026-04-03', '2026-09-30']);
  const c = plan.conflicts.find(x => x.date === '2026-04-03');
  assert.deepStrictEqual([c.from, c.to, c.downgrade], [3, null, true]);

  const cancel = loadApp({ storage: makeStorage(seed) }), w = cancel.__storage.writes;
  assert.strictEqual(plain(cancel.applyBackupPayload(file, { decide: () => 'cancel' })).reason, 'cancelled');
  assert.strictEqual(cancel.__storage.writes, w);

  const keep = loadApp({ storage: makeStorage(seed) });
  assert.strictEqual(plain(keep.applyBackupPayload(file, KEEP)).kept, 2);
  assert.deepStrictEqual(days(keep)['2026-04-03'], device['2026-04-03']);
  assert.deepStrictEqual(days(keep)['2026-09-30'], device['2026-09-30']);

  const use = loadApp({ storage: makeStorage(seed) });
  assert.strictEqual(plain(use.applyBackupPayload(file, BACKUP)).replaced, 2);
  assert.deepStrictEqual(days(use)['2026-04-03'], noSync(FULL_DAYS['2026-04-03']), 'replaced only by explicit choice, as stored');
  assert.deepStrictEqual(days(use)['2026-09-30'], noSync(FULL_DAYS['2026-09-30']));
});

test('a v3 export restore that fails part-way rolls back every store', () => {
  const file = asFile(plain(loadApp({ storage: makeStorage(FULL) }).buildBackupPayload()));
  for (const failing of STORES.filter(k => k !== 'spt_draft_v2')) {
    const s = makeStorage({ spt_v2: JSON.stringify({ '2026-04-03': day() }), spt_dhikr_preferences_v1: JSON.stringify(['Mine']) });
    const t = loadApp({ storage: s });
    const before = snapshot(t);
    const set = s.setItem;
    s.setItem = (k, v) => { if (k === failing && !s.__failed) { s.__failed = true; throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' }); } return set.call(s, k, v); };
    const r = plain(t.applyBackupPayload(file, BACKUP));
    assert.deepStrictEqual([r.ok, r.reason, r.rolledBack], [false, 'write-failed', true], failing);
    assert.deepStrictEqual(snapshot(t), before, 'every store restored after failing at ' + failing);
  }
});

test('Export Backup downloads valid schema-3 JSON and reports the day count', () => {
  const parts = [];
  const app = loadApp({ storage: makeStorage(FULL), globals: { Blob: class { constructor(p, o) { parts.push(...p); this.type = o && o.type; } } } });
  app.exportBackup();
  const file = JSON.parse(parts.join(''));
  assert.strictEqual(file._meta.schema, 3);
  assert.strictEqual(Object.keys(file.spt_v2).length, 5);
  assert.deepStrictEqual(file._unreadable, []);
  assert.match(app.__document.getElementById('backup-status').textContent, /Backup downloaded — 5 days/);
  assert.strictEqual(plain(loadApp().planBackupImport(file)).ok, true);
});

// ── schema ─────────────────────────────────────────────────────────────────

test('a full backup round-trips onto an empty device', () => {
  const source = loadApp({ storage: makeStorage(SEED) });
  const file = plain(source.buildBackupPayload());

  const target = loadApp();                     // fresh device, nothing stored
  const r = plain(target.applyBackupPayload(file, KEEP));

  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.dayCount, 1);
  assert.deepStrictEqual(r.restored.sort(), ['custom sections', 'dhikr list', 'saved days', 'unsaved drafts'].sort());

  const after = target.__storage._dump();
  assert.strictEqual(JSON.parse(after.spt_section_config_v1).custom[0].name, 'Dua');
  assert.deepStrictEqual(JSON.parse(after.spt_dhikr_preferences_v1), ['Istighfar', 'Durood']);
  assert.ok(JSON.parse(after.spt_drafts_v1)['2026-04-02']);
});

test('an old schema-1 backup (no schema in _meta) still restores, and leaves absent stores untouched', () => {
  const v1 = {
    _meta: { app: 'Spiritual Tracker', version: '3.1.0-clean-integrated' },
    spt_v2: { '2026-03-01': { score: 30, maxScore: 40 } },
    spt_draft_v2: null,
  };
  const target = loadApp({ storage: makeStorage({ spt_section_config_v1: SEED.spt_section_config_v1 }) });
  assert.strictEqual(plain(target.planBackupImport(v1)).schema, 1);
  const r = plain(target.applyBackupPayload(v1, KEEP));

  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.dayCount, 1);
  assert.deepStrictEqual(r.restored, ['saved days'], 'only what the file carried');
  assert.strictEqual(
    JSON.parse(target.__storage._dump().spt_section_config_v1).custom[0].name, 'Dua',
    'existing custom sections are not wiped by a file that has none');
});

test('a backup with no _meta at all is read as schema 1', () => {
  const target = loadApp();
  const plan = plain(target.planBackupImport({ spt_v2: { '2026-03-01': day() } }));
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.schema, 1);
});

test('schema 1, 2 and 3 are accepted; pre-6.1 and post-6.1 v2 files both restore', () => {
  const pre61 = { _meta: { schema: 2 }, spt_v2: { '2026-09-01': legacy() } };
  const post61 = { _meta: { schema: 2 }, spt_v2: { '2026-09-02': day({ _sync: { v: 1, h: 'fp1:x', at: 'y' } }) } };
  const v3 = { _meta: { schema: 3 }, spt_v2: { '2026-09-03': day() } };
  for (const [file, d] of [[pre61, '2026-09-01'], [post61, '2026-09-02'], [v3, '2026-09-03']]) {
    const t = loadApp();
    const r = plain(t.applyBackupPayload(file, KEEP));
    assert.strictEqual(r.ok, true, JSON.stringify(file._meta));
    assert.ok(days(t)[d]);
  }
});

test('unknown schemas are rejected before any write, naming a newer format when it is one', () => {
  for (const schema of [4, 99, 'banana', 2.5, -1, 0, null]) {
    const t = loadApp({ storage: makeStorage(SEED) });
    const before = snapshot(t), writes = t.__storage.writes;
    let decided = false;
    const r = plain(t.applyBackupPayload({ _meta: { schema }, spt_v2: { '2026-09-01': day() } }, { decide: () => { decided = true; return 'backup'; } }));
    assert.strictEqual(r.ok, false, String(schema));
    assert.strictEqual(r.reason, 'unsupported-schema');
    assert.strictEqual(r.newer, Number.isInteger(schema) && schema > 3);
    assert.strictEqual(decided, false, 'no plan is offered');
    assert.strictEqual(t.__storage.writes, writes, 'zero writes');
    assert.deepStrictEqual(snapshot(t), before);
  }
  const t = loadApp();
  assert.strictEqual(plain(t.applyBackupPayload({ _meta: 'garbage', spt_v2: { '2026-09-01': day() } }, KEEP)).reason, 'unsupported-schema');
});

test('a file that is not a backup is rejected before any write', () => {
  for (const junk of [null, undefined, 42, 'text', [], {}, { nope: 1 }]) {
    const target = loadApp({ storage: makeStorage({ spt_v2: JSON.stringify({ '2026-01-01': { score: 7 } }) }) });
    const r = plain(target.applyBackupPayload(junk, KEEP));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'not-a-backup');
    assert.deepStrictEqual(Object.keys(plain(target.getStorage())), ['2026-01-01'], 'existing data untouched');
  }
});

// ── days ───────────────────────────────────────────────────────────────────

test('malformed day keys and values are skipped and reported, not imported', () => {
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
  }, KEEP));

  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.dayCount, 1, 'only the one well-formed day');
  assert.strictEqual(r.skipped, 6);
  assert.deepStrictEqual(Object.keys(plain(target.getStorage())), ['2026-05-05']);
});

test('a day breaking the saved-day contract is skipped and reported; valid days still import', () => {
  const t = loadApp();
  const file = { _meta: { schema: 2 }, spt_v2: {
    '2026-09-01': day({ scoringVersion: 1 }),
    '2026-09-02': day({ scoringVersion: 99 }),
    '2026-09-03': day({ scoringVersion: '3' }),
    '2026-09-04': day({ score: 'abc' }),
    '2026-09-05': {},
    '2026-09-06': day({ maxScore: Infinity }),
    '2026-09-07': day({ savedAt: 'yesterday' }),
    '2026-09-08': { _sync: { v: 1 } },
    '2026-09-09': legacy(),
    '2026-09-10': day(),
  } };
  const plan = plain(t.planBackupImport(file));
  assert.deepStrictEqual(plan.invalidDays.map(x => x.key), ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06', '2026-09-07', '2026-09-08']);
  assert.match(plan.invalidDays.find(x => x.key === '2026-09-02').why, /scoring version/);
  const r = plain(t.applyBackupPayload(file, KEEP));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.skipped, 8);
  assert.deepStrictEqual(Object.keys(days(t)).sort(), ['2026-09-09', '2026-09-10']);
});

test('legacy, v3 and negative legacy days are imported exactly as they are — never rescored', () => {
  const t = loadApp();
  const neg = legacy({ score: -12.5, maxScore: 140, gazeScore: -10 });
  const file = { spt_v2: { '2026-04-01': neg, '2026-09-30': day({ score: 91, maxScore: 73 }), '2026-05-01': { ...legacy(), scoringVersion: null } } };
  assert.strictEqual(plain(t.applyBackupPayload(file, KEEP)).ok, true);
  const h = days(t);
  assert.deepStrictEqual(h['2026-04-01'], neg, 'negative legacy total unchanged, no scoringVersion added');
  assert.strictEqual(h['2026-09-30'].scoringVersion, 3);
  assert.strictEqual(h['2026-09-30'].score, 91);
  assert.strictEqual(h['2026-05-01'].scoringVersion, null, 'explicit null kept');
});

test('a backup whose days are all invalid changes nothing', () => {
  const target = loadApp({ storage: makeStorage({ spt_v2: JSON.stringify({ '2026-01-01': { score: 7 } }) }) });
  const r = plain(target.applyBackupPayload({ spt_v2: { bad: 1, worse: 2 } }, KEEP));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no-valid-days');
  assert.deepStrictEqual(Object.keys(plain(target.getStorage())), ['2026-01-01']);
});

test('a __proto__ key in an untrusted backup cannot pollute the prototype', () => {
  const target = loadApp();
  const hostile = JSON.parse('{"spt_v2":{"__proto__":{"polluted":true},"2026-05-05":{"score":1}}}');
  const r = plain(target.applyBackupPayload(hostile, KEEP));

  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.dayCount, 1, '__proto__ is not a valid date key');
  assert.strictEqual(({}).polluted, undefined, 'host prototype is clean');
  assert.strictEqual(target.escapeHTML.constructor.prototype.polluted, undefined);
  assert.deepStrictEqual(Object.keys(plain(target.getStorage())), ['2026-05-05']);
});

// ── same-date conflicts ────────────────────────────────────────────────────

test('import merges; a differing same-date day is a conflict, never overwritten without a choice', () => {
  const target = loadApp({ storage: makeStorage({
    spt_v2: JSON.stringify({ '2026-01-01': { score: 1 }, '2026-02-02': { score: 2 } }),
  })});
  const file = { spt_v2: { '2026-02-02': { score: 99 }, '2026-03-03': { score: 3 } } };
  const plan = plain(target.planBackupImport(file));
  assert.deepStrictEqual(plan.newDays, ['2026-03-03']);
  assert.deepStrictEqual(plan.conflicts.map(c => c.date), ['2026-02-02']);

  const r = plain(target.applyBackupPayload(file, KEEP));
  const h = days(target);
  assert.deepStrictEqual(Object.keys(h).sort(), ['2026-01-01', '2026-02-02', '2026-03-03']);
  assert.strictEqual(h['2026-01-01'].score, 1, 'local-only day survives');
  assert.strictEqual(h['2026-02-02'].score, 2, 'keep-device choice: the device version stays');
  assert.strictEqual(r.kept, 1);
  assert.strictEqual(r.replaced, 0);
});

test('an identical same-date day (ignoring _sync) is not a conflict and is not written', () => {
  const mine = day({ _sync: { v: 1, h: 'fp1:device', at: 'x' } });
  const t = loadApp({ storage: makeStorage({ spt_v2: JSON.stringify({ '2026-09-30': mine }) }) });
  const before = t.__storage.getItem('spt_v2'), writes = t.__storage.writes;
  const file = { _meta: { schema: 2 }, spt_v2: { '2026-09-30': day({ _sync: { v: 1, h: 'fp1:OTHER', at: 'y', held: { reason: 'both-changed' } } }) } };
  const plan = plain(t.planBackupImport(file));
  assert.deepStrictEqual(plan.identical, ['2026-09-30']);
  assert.strictEqual(plan.conflicts.length, 0);
  const r = plain(t.applyBackupPayload(file, BACKUP));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.nothing, true);
  assert.strictEqual(t.__storage.writes, writes, 'no write at all');
  assert.strictEqual(t.__storage.getItem('spt_v2'), before);
});

test('days differing only in local-only detail (habits, per-section scores) are conflicts, not identical', () => {
  const mine = day({ habits: [{ id: 1, name: 'Walk', done: false, mins: 0 }, { id: 2, name: 'Read', done: true, mins: 20 }], salahScore: 17 });
  const theirs = day({ habits: [{ id: 2, name: 'Read', done: true, mins: 20 }], salahScore: 0 });
  const t = loadApp({ storage: makeStorage({ spt_v2: JSON.stringify({ '2026-09-30': mine }) }) });
  const plan = plain(t.planBackupImport({ spt_v2: { '2026-09-30': theirs } }));
  assert.deepStrictEqual(plan.conflicts.map(c => c.date), ['2026-09-30']);
  t.applyBackupPayload({ spt_v2: { '2026-09-30': theirs } }, KEEP);
  assert.deepStrictEqual(days(t)['2026-09-30'].habits, mine.habits, 'full habit detail protected');
});

test('Use backup versions replaces exactly the listed conflicting dates', () => {
  const t = loadApp({ storage: makeStorage({ spt_v2: JSON.stringify({
    '2026-09-01': day({ reflection: { win: 'A device' } }), '2026-09-02': day({ reflection: { win: 'B device' } }), '2026-09-03': day(),
  }) }) });
  const file = { spt_v2: { '2026-09-01': day({ reflection: { win: 'A backup' } }), '2026-09-02': day({ reflection: { win: 'B backup' } }), '2026-09-03': day(), '2026-09-04': day() } };
  let seen = null, writesAtDecision = null;
  const writesBefore = t.__storage.writes;
  const r = plain(t.applyBackupPayload(file, { decide: p => { seen = plain(p).conflicts.map(c => c.date); writesAtDecision = t.__storage.writes; return 'backup'; } }));
  assert.deepStrictEqual(seen, ['2026-09-01', '2026-09-02']);
  assert.strictEqual(writesAtDecision, writesBefore, 'nothing is written before the explicit choice');
  const h = days(t);
  assert.strictEqual(h['2026-09-01'].reflection.win, 'A backup');
  assert.strictEqual(h['2026-09-02'].reflection.win, 'B backup');
  assert.ok(h['2026-09-04']);
  assert.strictEqual(r.replaced, 2);
  assert.strictEqual(r.added, 1);
});

test('Cancel performs zero writes', () => {
  const t = loadApp({ storage: makeStorage(SEED) });
  const before = snapshot(t), writes = t.__storage.writes;
  const r = plain(t.applyBackupPayload({ spt_v2: { '2026-04-01': { score: 99 }, '2026-09-09': { score: 1 } }, spt_dhikr_preferences_v1: ['X'] }, { decide: () => 'cancel' }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'cancelled');
  assert.strictEqual(t.__storage.writes, writes);
  assert.deepStrictEqual(snapshot(t), before);
});

test('a v3 → legacy downgrade and an older backup copy are flagged in the plan and the dialog', () => {
  const t = loadApp({ storage: makeStorage({ spt_v2: JSON.stringify({ '2026-09-30': day({ savedAt: '2026-10-01T10:00:00Z' }), '2026-09-29': legacy() }) }) });
  const plan = t.planBackupImport({ _meta: { schema: 2, exported: '2026-09-15T08:00:00Z' }, spt_v2: {
    '2026-09-30': legacy({ score: 40, savedAt: '2026-09-15T08:00:00Z' }),
    '2026-09-29': day({ score: 60 }),
  } });
  const c = Object.fromEntries(plain(plan).conflicts.map(x => [x.date, x]));
  assert.deepStrictEqual([c['2026-09-30'].from, c['2026-09-30'].to, c['2026-09-30'].downgrade, c['2026-09-30'].olderBackup], [3, null, true, true]);
  assert.deepStrictEqual([c['2026-09-29'].from, c['2026-09-29'].to, c['2026-09-29'].downgrade], [null, 3, false]);
  const html = t._renderImportPlan(plan);
  assert.match(html, /2026-09-30 — <span class="import-warn">⚠️ downgrade v3 → legacy<\/span> · backup copy is older/);
  assert.match(html, /2026-09-29 — version change legacy → v3/);
  assert.match(html, /2 dates differ between this device and the backup/);
});

test('the dialog offers the three explicit choices when there are conflicts, and names what will be replaced', () => {
  const t = loadApp({ storage: makeStorage({ spt_v2: JSON.stringify({ '2026-09-30': day() }) }) });
  const file = { spt_v2: { '2026-09-30': day({ score: 1 }), '2026-10-01': day() }, spt_section_config_v1: { order: [], enabled: {}, custom: [] } };
  t._openImportModal(file, t.planBackupImport(file));
  const actions = t.__document.getElementById('import-actions').innerHTML;
  assert.match(actions, /importChoose\('keep'\)">Keep this device’s versions/);
  assert.match(actions, /importChoose\('backup'\)">Use backup versions for 1 listed date/);
  assert.match(actions, /importChoose\('cancel'\)">Cancel import/);
  const body = t.__document.getElementById('import-plan').innerHTML;
  assert.match(body, /1 new day will be added/);
  assert.match(body, /Custom sections will be replaced/);
  t.importChoose('cancel');
  assert.match(t.__document.getElementById('backup-status').textContent, /cancelled — nothing was changed/);
  assert.strictEqual(days(t)['2026-09-30'].score, 50);
});

test('a plan is not applied if this device changed after it was shown', () => {
  const t = loadApp({ storage: makeStorage({ spt_v2: JSON.stringify({ '2026-09-30': day() }) }) });
  const file = { spt_v2: { '2026-10-01': day({ reflection: { win: 'backup' } }) } };
  const plan = t.planBackupImport(file);
  const h = days(t); h['2026-10-01'] = day({ reflection: { win: 'saved meanwhile' } }); t.setStorage(h);
  const r = plain(t.applyBackupPlan(file, plan, { useBackup: true }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'changed');
  assert.strictEqual(days(t)['2026-10-01'].reflection.win, 'saved meanwhile');
});

// ── Stage 6.1 sync state ───────────────────────────────────────────────────

test('imported days never carry another device’s _sync state (held versions, errors)', () => {
  const t = loadApp();
  const synced = day({ _sync: { v: 1, h: 'fp1:abc', at: 'x', held: { reason: 'both-changed', other: day({ reflection: { win: 'cloud' } }), otherFp: 'fp1:d', otherSide: 'cloud' }, err: { kind: 'validation', code: '23514', fp: 'fp1:abc' } } });
  t.applyBackupPayload({ _meta: { schema: 2 }, spt_v2: { '2026-09-30': synced, '2026-09-29': day() } }, KEEP);
  const h = days(t);
  assert.ok(!('_sync' in h['2026-09-30']));
  assert.ok(!('_sync' in h['2026-09-29']));
  assert.strictEqual(h['2026-09-30'].reflection.win, 'device', 'the day itself is unchanged');
});

// ── drafts ─────────────────────────────────────────────────────────────────

test('drafts merge: device drafts are kept, a backup-only draft is added without its base, nothing replaces the open form', () => {
  const deviceMap = { '2026-09-29': { date: '2026-09-29', reflectionWin: 'device work', base: { fp: 'fp1:x' } } };
  const deviceActive = { date: '2026-09-28', reflectionWin: 'open form work', base: { fp: null } };
  const t = loadApp({ storage: makeStorage({ spt_v2: JSON.stringify({ '2026-09-27': day(), '2026-09-28': day() }), spt_drafts_v1: JSON.stringify(deviceMap), spt_draft_v2: JSON.stringify(deviceActive) }) });
  R(t, "activeDateKey='2026-09-28'");
  const file = { spt_v2: { '2026-09-27': day() },
    spt_drafts_v1: { '2026-09-29': { date: '2026-09-29', reflectionWin: 'backup copy' }, '2026-09-27': { date: '2026-09-27', reflectionWin: 'from backup', base: { fp: 'fp1:old' } }, 'junk': 5 },
    spt_draft_v2: { date: '2026-09-28', reflectionWin: 'backup open form' } };
  const plan = plain(t.planBackupImport(file));
  assert.deepStrictEqual(plan.drafts.add, ['2026-09-27']);
  assert.deepStrictEqual(plan.drafts.deviceKept, ['2026-09-28', '2026-09-29']);
  assert.deepStrictEqual(plan.drafts.invalid, ['junk']);
  const r = plain(t.applyBackupPayload(file, KEEP));
  assert.strictEqual(r.draftsAdded, 1);
  const m = JSON.parse(t.__storage.getItem('spt_drafts_v1'));
  assert.strictEqual(m['2026-09-29'].reflectionWin, 'device work', 'existing device draft wins');
  assert.deepStrictEqual(m['2026-09-29'].base, { fp: 'fp1:x' }, 'device draft untouched');
  assert.strictEqual(m['2026-09-27'].reflectionWin, 'from backup');
  assert.ok(!('base' in m['2026-09-27']), 'imported draft has no base');
  assert.deepStrictEqual(JSON.parse(t.__storage.getItem('spt_draft_v2')), deviceActive, 'the open form’s draft is not replaced');
});

test('an imported draft is not applied to the form: on a saved day it is only offered', () => {
  const t = loadApp({ storage: makeStorage({ spt_v2: JSON.stringify({ '2026-09-27': day() }) }) });
  R(t, "activeDateKey='2026-09-27'");
  t.loadActiveDate();
  t.applyBackupPayload({ spt_v2: { '2026-09-26': day() }, spt_drafts_v1: { '2026-09-27': { date: '2026-09-27', reflectionWin: 'imported unsaved', gazeVal: 'success' } } }, KEEP);
  t.loadActiveDate();                                  // what importChoose does after restoring
  assert.strictEqual(t.__document.getElementById('reflection-win').value, 'device', 'the saved day is shown');
  assert.match(t.__document.getElementById('sync-day-banner').innerHTML, /Unsaved changes from .* were found/, 'offered via the existing notice');
});

test('a backup draft for the open day without a saved version is skipped, so the open form is never replaced', () => {
  const t = loadApp({ storage: makeStorage({ spt_v2: JSON.stringify({ '2026-09-27': day() }) }) });
  R(t, "activeDateKey='2026-10-02'");
  const plan = plain(t.planBackupImport({ spt_v2: { '2026-09-26': day() }, spt_draft_v2: { date: '2026-10-02', reflectionWin: 'backup' } }));
  assert.deepStrictEqual(plan.drafts.skippedOpenDay, ['2026-10-02']);
  assert.deepStrictEqual(plan.drafts.add, []);
});

test('a device draft for a date the backup replaces is kept and offered, not dropped as stale', () => {
  const t = loadApp({ storage: makeStorage({ spt_v2: JSON.stringify({ '2026-09-27': day() }),
    spt_drafts_v1: JSON.stringify({ '2026-09-27': { date: '2026-09-27', reflectionWin: 'device unsaved', base: { fp: 'fp1:z' } } }) }) });
  t.applyBackupPayload({ spt_v2: { '2026-09-27': day({ reflection: { win: 'backup' } }) } }, BACKUP);
  const m = JSON.parse(t.__storage.getItem('spt_drafts_v1'));
  assert.strictEqual(m['2026-09-27'].reflectionWin, 'device unsaved');
  assert.deepStrictEqual(m['2026-09-27'].base, { fp: null, legacy: true });
});

// ── optional stores ────────────────────────────────────────────────────────

test('a valid section config and dhikr list replace the device’s', () => {
  const t = loadApp({ storage: makeStorage({ spt_v2: '{}', spt_section_config_v1: SEED.spt_section_config_v1, spt_dhikr_preferences_v1: SEED.spt_dhikr_preferences_v1 }) });
  const cfg = { order: ['salah'], enabled: { salah: true }, custom: [] };
  const r = plain(t.applyBackupPayload({ spt_v2: { '2026-09-01': day() }, spt_section_config_v1: cfg, spt_dhikr_preferences_v1: ['SubhanAllah'] }, KEEP));
  assert.deepStrictEqual(r.restored.sort(), ['custom sections', 'dhikr list', 'saved days']);
  assert.deepStrictEqual(JSON.parse(t.__storage.getItem('spt_section_config_v1')), cfg);
  assert.deepStrictEqual(JSON.parse(t.__storage.getItem('spt_dhikr_preferences_v1')), ['SubhanAllah']);
});

test('a malformed section config or dhikr list never overwrites the device’s, even after a reload', () => {
  const bad = [
    { order: 'not-an-array', enabled: {}, custom: [] },
    { order: [], enabled: [], custom: [] },
    { order: [], enabled: { salah: 'yes' }, custom: [] },
    { order: [], enabled: {}, custom: [{ id: 'c', name: 'X', tasks: 'none' }] },
    { order: [], enabled: {}, custom: [{ id: 'c', name: 'X', tasks: [{ id: 't', name: 'T', points: 'two' }] }] },
    { order: [], enabled: {}, custom: [{ name: 'No id', tasks: [] }] },
  ];
  for (const cfg of bad) {
    const s = makeStorage({ spt_v2: '{}', spt_section_config_v1: SEED.spt_section_config_v1, spt_dhikr_preferences_v1: SEED.spt_dhikr_preferences_v1 });
    const t = loadApp({ storage: s });
    const plan = plain(t.planBackupImport({ spt_v2: { '2026-09-01': day() }, spt_section_config_v1: cfg, spt_dhikr_preferences_v1: [{ evil: 1 }, 42, ''] }));
    assert.strictEqual(plan.stores.section, 'invalid', JSON.stringify(cfg));
    assert.strictEqual(plan.stores.dhikr, 'invalid');
    t.applyBackupPayload({ spt_v2: { '2026-09-01': day() }, spt_section_config_v1: cfg, spt_dhikr_preferences_v1: [{ evil: 1 }, 42, ''] }, KEEP);
    assert.strictEqual(s.getItem('spt_section_config_v1'), SEED.spt_section_config_v1);
    assert.strictEqual(s.getItem('spt_dhikr_preferences_v1'), SEED.spt_dhikr_preferences_v1);
    const reloaded = loadApp({ storage: s });          // the next page load
    R(reloaded, 'loadSectionConfig()');
    assert.strictEqual(plain(R(reloaded, 'sectionConfig')).custom[0].name, 'Dua', 'custom sections survive a reload');
  }
});

// ── all or nothing ─────────────────────────────────────────────────────────

test('a write failure at any stage rolls back every store and reports ok:false', () => {
  const file = {
    spt_v2: { '2026-04-01': { score: 99 }, '2026-09-09': { score: 1 } },
    spt_drafts_v1: { '2026-09-10': { date: '2026-09-10', reflectionWin: 'backup draft' } },
    spt_section_config_v1: { order: ['salah'], enabled: { salah: true }, custom: [] },
    spt_dhikr_preferences_v1: ['Only'],
  };
  for (const failing of ['spt_v2', 'spt_drafts_v1', 'spt_section_config_v1', 'spt_dhikr_preferences_v1']) {
    const s = makeStorage(SEED);
    const t = loadApp({ storage: s });
    const before = snapshot(t);
    const set = s.setItem;
    s.setItem = (k, v) => { if (k === failing && !s.__failed) { s.__failed = true; const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; } return set.call(s, k, v); };
    const r = plain(t.applyBackupPayload(file, BACKUP));
    assert.strictEqual(r.ok, false, failing);
    assert.strictEqual(r.reason, 'write-failed');
    assert.strictEqual(r.rolledBack, true);
    assert.deepStrictEqual(snapshot(t), before, 'every store restored after failing at ' + failing);
  }
});

test('a restore that cannot be written reports failure', () => {
  const storage = makeStorage();
  const target = loadApp({ storage });
  storage.quotaAfter = storage.writes;
  const r = plain(target.applyBackupPayload({ spt_v2: { '2026-09-09': { score: 1 } } }, KEEP));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'write-failed');
  assert.match(r.detail, /storage is full|blocking local storage/);
  assert.strictEqual(storage.getItem('spt_v2'), null, 'rolled back to nothing');
});

test('a rolled-back restore tells the user nothing was changed', () => {
  const s = makeStorage(SEED);
  const t = loadApp({ storage: s });
  const file = { spt_v2: { '2026-09-09': { score: 1 } }, spt_dhikr_preferences_v1: ['Only'] };
  t._openImportModal(file, t.planBackupImport(file));
  const set = s.setItem;
  s.setItem = (k, v) => { if (k === 'spt_dhikr_preferences_v1' && !s.__failed) { s.__failed = true; throw Object.assign(new Error('q'), { name: 'QuotaExceededError' }); } return set.call(s, k, v); };
  const r = plain(t.importChoose('keep'));
  assert.strictEqual(r.ok, false);
  assert.match(t.__document.getElementById('backup-status').textContent, /rolled back — nothing was changed/);
  assert.strictEqual(s.getItem('spt_v2'), SEED.spt_v2);
});
