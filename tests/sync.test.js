// Step 6.1 — sync safety. Drives the real sync code against an in-memory
// stand-in for Supabase, so every request the app would send is counted and
// every row it would store is checked.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const { loadApp, makeStorage, plain } = require('./harness.js');

const UID = 'u-1';
const flush = async (n = 40) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
const clone = v => JSON.parse(JSON.stringify(v));
// Postgres hands timestamptz back in its own format, e.g. ...00.123+00:00.
const pgTime = iso => new Date(iso).toISOString().replace('Z', '+00:00');

function cloudRow(d, o = {}) {
  return {
    record_date: d, score: 50, max_score: 100, scoring_version: 3,
    fardh_salah: { Fajr: 10, Dhuhr: 10, Asr: 10, Maghrib: 10, Isha: 10 },
    nafl_salah: { tahajjud: false, ishraq: false, chast: false, extraNafl: [] },
    khushu: { value: '' }, gaze: { value: 'clean', trigger: '' }, music_free: true,
    dhikr: [{ name: 'Istighfar', count: 100, pts: 1 }],
    quran: { done: true, onepage: false, mins: '10', pages: 0, kahf: false, nightly: false },
    fasting: { done: false }, habits: { count: 0, mins: 0, names: [] }, custom_sections: {},
    reflection: { win: 'cloud', improve: '' }, is_hayd_mode: false, is_sisters_mode: false,
    saved_at: '2026-09-10T08:00:00.000Z', ...o,
  };
}
function localDay(o = {}) {
  return {
    score: 50, maxScore: 100, scoringVersion: 3,
    salahData: { Fajr: 10, Dhuhr: 10, Asr: 10, Maghrib: 10, Isha: 10 },
    voluntary: { tahajjud: false, ishraq: false, chast: false, extraNafl: [] },
    khushu: '', gaze: 'clean', trigger: '', musicFree: true,
    dhikrData: [{ name: 'Istighfar', count: 100, pts: 1 }], customSectionData: {},
    quran: { done: true, onepage: false, mins: '10', pages: 0, kahf: false, nightly: false },
    fast: false, habitsCount: 0, habitsMins: 0, habitNames: [], habits: [],
    reflection: { win: 'cloud', improve: '' }, isHaydMode: false, isSistersMode: false,
    savedAt: '2026-09-10T08:00:00.000Z', ...o,
  };
}

/** An in-memory Supabase: auth, daily_records and user_preferences. */
function makeCloud({ rows = [], prefs = { cloud_sync_enabled: true }, signedIn = true } = {}) {
  const cloud = {
    rows: new Map(),
    prefs: prefs ? { user_id: UID, ...clone(prefs) } : null,
    session: signedIn ? { user: { id: UID, email: 'owner@example.test' } } : null,
    log: [],
    listener: null,
    failPage: null,      // (from) => error | null
    failUpsert: null,    // (rows) => error | null
    beforeUpsert: null,  // (rows) => void, runs while the request is "in flight"
    gate: null,          // a promise every daily_records select waits on
    inFlight: 0, maxInFlight: 0,
    get selects() { return cloud.log.filter(x => x.table === 'daily_records' && x.op === 'select'); },
    get upserts() { return cloud.log.filter(x => x.table === 'daily_records' && x.op === 'upsert'); },
    get prefWrites() { return cloud.log.filter(x => x.table === 'user_preferences' && x.op === 'upsert'); },
    uploaded() { return cloud.upserts.flatMap(u => u.rows.map(r => r.record_date)); },
    store(row) {
      cloud.rows.set(row.record_date, { ...clone(row), user_id: UID, saved_at: pgTime(row.saved_at), updated_at: pgTime(new Date().toISOString()) });
    },
    signIn() { cloud.session = { user: { id: UID, email: 'owner@example.test' } }; cloud.listener('SIGNED_IN', cloud.session); },
    emit(event) { cloud.listener(event, cloud.session); },
  };
  rows.forEach(r => cloud.store(r));

  class Query {
    constructor(table) { this.table = table; this.op = 'select'; }
    select() { return this; }
    order() { return this; }
    eq() { return this; }
    range(a, b) { this.from = a; this.to = b; return this; }
    upsert(payload) { this.op = 'upsert'; this.payload = clone(Array.isArray(payload) ? payload : [payload]); return this; }
    async maybeSingle() {
      cloud.log.push({ table: this.table, op: 'select' });
      return { data: cloud.prefs ? clone(cloud.prefs) : null, error: null };
    }
    then(ok, fail) { return this.run().then(ok, fail); }
    async run() {
      if (this.table === 'user_preferences') {
        cloud.log.push({ table: this.table, op: 'upsert', rows: this.payload });
        cloud.prefs = clone(this.payload[0]);
        return { data: null, error: null };
      }
      cloud.inFlight++; cloud.maxInFlight = Math.max(cloud.maxInFlight, cloud.inFlight);
      try {
        if (this.op === 'select') {
          cloud.log.push({ table: this.table, op: 'select', from: this.from, to: this.to });
          if (cloud.gate) await cloud.gate;
          const err = cloud.failPage && cloud.failPage(this.from);
          if (err) return { data: null, error: err };
          const all = [...cloud.rows.values()].sort((x, y) => x.record_date.localeCompare(y.record_date));
          return { data: clone(all.slice(this.from, this.to + 1)), error: null };
        }
        cloud.log.push({ table: this.table, op: 'upsert', rows: this.payload });
        if (cloud.beforeUpsert) cloud.beforeUpsert(this.payload);
        const injected = cloud.failUpsert && cloud.failUpsert(this.payload);
        if (injected) return { data: null, error: injected };
        // One statement: a single bad row rejects the whole request.
        if (this.payload.some(r => Number(r.score) < 0))
          return { data: null, error: { code: '23514', message: 'new row for relation "daily_records" violates check constraint "daily_records_score_check"' } };
        this.payload.forEach(r => cloud.store(r));
        return { data: null, error: null };
      } finally { cloud.inFlight--; }
    }
  }

  cloud.client = {
    auth: {
      getSession: async () => ({ data: { session: cloud.session }, error: null }),
      onAuthStateChange(cb) { cloud.listener = cb; return { data: { subscription: { unsubscribe() {} } } }; },
      signOut: async () => { cloud.session = null; cloud.listener('SIGNED_OUT', null); return { error: null }; },
    },
    from: table => new Query(table),
  };
  cloud.lib = { createClient: () => cloud.client };
  return cloud;
}

/** Boots the app with `local` days on this device and `cloud` as its Supabase. */
function boot({ local = {}, cloud, seed = {}, date } = {}) {
  const storage = makeStorage({ spt_v2: JSON.stringify(local), ...seed });
  const app = loadApp({ storage, globals: cloud ? { supabase: cloud.lib } : {} });
  if (date) vm.runInContext(`activeDateKey=${JSON.stringify(date)};_refreshActiveDateFlags();`, app);
  return app;
}
const R = (app, src) => vm.runInContext(src, app);
const days = app => plain(app.getStorage());
const note = (app, d) => days(app)[d]._sync;
const field = (app, id) => app.__document.getElementById(id);
const rowFp = (app, row) => app._rowFingerprint(row);
const recFp = (app, d, rec) => app._recordFingerprint(d, rec);
const inputsOf = (app, rec) => R(app, '_inputsFingerprint')(app._inputsFromRecord(rec));

// ── fingerprints ────────────────────────────────────────────────────────────

test('a day and its cloud row fingerprint identically, whatever the timestamp format or key order', () => {
  const app = boot();
  const row = cloudRow('2026-09-10', { saved_at: '2026-09-10T08:00:00.123+00:00' });
  const rec = localDay({ savedAt: '2026-09-10T08:00:00.123Z', quran: { nightly: false, kahf: false, pages: 0, mins: '10', onepage: false, done: true } });
  assert.strictEqual(recFp(app, '2026-09-10', rec), rowFp(app, row));
  assert.strictEqual(rowFp(app, { ...row, saved_at: '2026-09-10T08:00:00.123000+00:00' }), rowFp(app, row));
});

test('fingerprints ignore server-only columns but change with any uploaded value', () => {
  const app = boot();
  const row = cloudRow('2026-09-10');
  const base = rowFp(app, row);
  assert.strictEqual(rowFp(app, { ...row, id: 7, user_id: UID, created_at: 'x', updated_at: '2026-10-01T00:00:00Z' }), base);
  assert.strictEqual(rowFp(app, { ...row, score: '50', max_score: '100.00' }), base, 'numeric text from the API is the same number');
  assert.notStrictEqual(rowFp(app, { ...row, reflection: { win: 'cloud!', improve: '' } }), base);
  assert.notStrictEqual(rowFp(app, { ...row, saved_at: '2026-09-10T08:00:01.000Z' }), base);
  assert.notStrictEqual(rowFp(app, { ...row, scoring_version: null }), base);
  assert.notStrictEqual(rowFp(app, { ...row, habits: { count: 1, mins: 5, names: ['Walk'] } }), base);
});

test('a day pulled from the cloud fingerprints back to the same row (legacy, v3 and odd shapes)', () => {
  const app = boot();
  const rows = [
    cloudRow('2026-04-01', { scoring_version: null, score: 133.5, max_score: 140, gaze: { value: 'relapse', trigger: 'late night' } }),
    cloudRow('2026-09-18', { fardh_salah: { Fajr: 10, Jummah: 20, Asr: 10, Maghrib: 10, Isha: 10 } }),
    cloudRow('2026-09-20', { dhikr: [], quran: {}, reflection: {}, custom_sections: { c1: { tasks: [{ id: 1, done: true }] } } }),
  ];
  for (const row of rows) {
    const local = plain(app._rowToLocalPayload({ ...row, saved_at: pgTime(row.saved_at), updated_at: 'x', user_id: UID }));
    assert.strictEqual(recFp(app, row.record_date, local), rowFp(app, row), row.record_date);
  }
});

test('the form, loaded from a saved day, reads back as exactly that day', () => {
  const rec = localDay({
    salahData: { Fajr: 10, Jummah: 20, Asr: 10, Maghrib: 5, Isha: 10 },
    voluntary: { tahajjud: true, ishraq: false, chast: false, extraNafl: [{ name: 'Duha', checked: true }] },
    khushu: 'good', gaze: 'relapse', trigger: 'phone',
    dhikrData: [{ name: 'Istighfar', count: 100, pts: 1 }, { name: 'Salawat', count: 0, pts: 0 }],
    quran: { done: true, onepage: false, mins: '15', pages: 2, kahf: true, nightly: false },
    habits: [{ id: 1, name: 'Walk', done: true, mins: 20 }, { id: 2, name: 'Read', done: false, mins: 0 }],
    habitsCount: 1, habitsMins: 20, habitNames: ['Walk'], reflection: { win: 'w', improve: 'i' },
  });
  const app = boot({ local: { '2026-09-18': rec }, date: '2026-09-18' });   // a Friday
  app.loadActiveDate();
  assert.strictEqual(R(app, '_inputsFingerprint')(app._inputsFromDraft(app._buildDraftFromForm())), inputsOf(app, rec));
});

// ── opening a day, drafts ───────────────────────────────────────────────────

test('start-up opens today’s saved day even without a draft, so Save cannot wipe it (F-1)', () => {
  const probe = boot();
  const today = probe.todayKey();
  const salahData = Object.fromEntries(R(probe, 'SALAH_NAMES').map((n, i) => [n, [10, 20, 10, 5, 10][i]]));   // Jummah on a Friday
  const rec = localDay({ salahData, reflection: { win: 'from the other device', improve: '' }, habits: [{ id: 1, name: 'Walk', done: true, mins: 25 }], habitsCount: 1, habitsMins: 25, habitNames: ['Walk'] });
  const app = boot({ local: { [today]: rec } });
  app._migrateSyncV1();
  assert.strictEqual(app._openActiveDateAtBoot(), true);
  assert.strictEqual(field(app, 'reflection-win').value, 'from the other device');
  assert.strictEqual(app.saveDay(), true);
  const saved = days(app)[today];
  assert.strictEqual(inputsOf(app, saved), inputsOf(app, rec), 'saving the untouched day keeps every input');
});

test('opening a date writes no draft', () => {
  const app = boot({ local: { '2026-09-10': localDay() }, date: '2026-09-10' });
  app.loadActiveDate();
  const s = app.__storage._dump();
  assert.ok(!s.spt_draft_v2 && (!s.spt_drafts_v1 || s.spt_drafts_v1 === '{}'), 'no draft for an untouched day');
});

test('a draft exists only while the form differs from its saved day, and records the version it started from', () => {
  const app = boot({ local: { '2026-09-10': localDay() }, date: '2026-09-10' });
  app.loadActiveDate();
  field(app, 'reflection-win').value = 'edited';
  assert.strictEqual(app.saveDraft(), true);
  const draft = plain(app._getDateDraft('2026-09-10'));
  assert.strictEqual(draft.reflectionWin, 'edited');
  assert.strictEqual(draft.base.fp, recFp(app, '2026-09-10', localDay()));
  field(app, 'reflection-win').value = 'cloud';                 // back to the saved text
  app.saveDraft();
  assert.strictEqual(app._getDateDraft('2026-09-10'), null);
  assert.strictEqual(app.__storage.getItem('spt_draft_v2'), null);
});

test('a draft made on the current saved version is restored over it', () => {
  const app = boot({ local: { '2026-09-10': localDay() }, date: '2026-09-10' });
  app.loadActiveDate();
  field(app, 'reflection-win').value = 'unsaved work';
  app.saveDraft();
  field(app, 'reflection-win').value = '';
  app.loadActiveDate();
  assert.strictEqual(field(app, 'reflection-win').value, 'unsaved work');
});

test('a stale draft gives way to the newer saved day, with a notice only for genuine changes (SY-3, D5)', () => {
  const genuine = { date: '2026-09-10', reflectionWin: 'old edit', gazeVal: 'clean', musicFree: true, base: { fp: 'fp1:older' } };
  const app = boot({ local: { '2026-09-10': localDay() }, date: '2026-09-10', seed: { spt_drafts_v1: JSON.stringify({ '2026-09-10': genuine }) } });
  app.loadActiveDate();
  assert.strictEqual(field(app, 'reflection-win').value, 'cloud', 'the saved day wins');
  assert.strictEqual(app._getDateDraft('2026-09-10'), null, 'the stale draft is removed');
  const banner = field(app, 'sync-day-banner');
  assert.match(banner.innerHTML, /replaced by a newer saved version/);
  assert.strictEqual(banner.style.display, 'block');

  // A stale draft that matches the saved day is removed silently.
  const same = { ...plain(app._buildDraftFromForm()), base: { fp: 'fp1:older' } };
  const app2 = boot({ local: { '2026-09-10': localDay() }, date: '2026-09-10', seed: { spt_drafts_v1: JSON.stringify({ '2026-09-10': same }) } });
  app2.loadActiveDate();
  assert.strictEqual(app2._getDateDraft('2026-09-10'), null);
  assert.strictEqual(field(app2, 'sync-day-banner').style.display, 'none');
});

test('saving a day removes its draft', () => {
  const app = boot({ local: { '2026-09-10': localDay() }, date: '2026-09-10' });
  app.loadActiveDate();
  field(app, 'reflection-win').value = 'edited';
  app.saveDraft();
  assert.ok(app._getDateDraft('2026-09-10'));
  assert.strictEqual(app.saveDay(), true);
  assert.strictEqual(app._getDateDraft('2026-09-10'), null);
  assert.strictEqual(app.__storage.getItem('spt_draft_v2'), null);
  assert.strictEqual(days(app)['2026-09-10'].reflection.win, 'edited');
});

// ── one-time clean-up of pre-6.1 drafts (D7) ─────────────────────────────────

test('pre-6.1 drafts: exact copies are removed, others are kept and offered, never applied silently (D7)', () => {
  const probe = boot({ local: { '2026-09-10': localDay() }, date: '2026-09-10' });
  probe.loadActiveDate();
  const copy = plain(probe._buildDraftFromForm());
  delete copy.base;
  const differs = { ...copy, date: '2026-09-11', reflectionWin: 'never saved text' };
  const unsaved = { ...copy, date: '2026-09-12', reflectionWin: 'new day' };
  const local = { '2026-09-10': localDay(), '2026-09-11': localDay() };
  const app = boot({ local, date: '2026-09-11', seed: { spt_drafts_v1: JSON.stringify({ '2026-09-10': copy, '2026-09-11': differs, '2026-09-12': unsaved }) } });
  app._migrateSyncV1();
  const m = JSON.parse(app.__storage.getItem('spt_drafts_v1'));
  assert.ok(!m['2026-09-10'], 'identical copy removed');
  assert.deepStrictEqual(m['2026-09-11'].base, { fp: null, legacy: true });
  assert.deepStrictEqual(m['2026-09-12'].base, { fp: null });
  assert.ok(app.__storage.getItem('spt_sync_migrated_v1'));

  app.loadActiveDate();
  assert.strictEqual(field(app, 'reflection-win').value, 'cloud', 'the saved day is shown first');
  assert.match(field(app, 'sync-day-banner').innerHTML, /Unsaved changes from .* were found/);
  app.syncUseLegacyDraft();
  assert.strictEqual(field(app, 'reflection-win').value, 'never saved text');
  assert.strictEqual(app.saveDay(), true);
  assert.strictEqual(days(app)['2026-09-11'].reflection.win, 'never saved text');
});

test('discarding a pre-6.1 draft keeps the saved day; the clean-up runs only once', () => {
  const legacy = { date: '2026-09-11', reflectionWin: 'old', gazeVal: 'clean' };
  const app = boot({ local: { '2026-09-11': localDay() }, date: '2026-09-11', seed: { spt_drafts_v1: JSON.stringify({ '2026-09-11': legacy }), spt_draft_v2: JSON.stringify(legacy) } });
  app._migrateSyncV1();
  app.loadActiveDate();
  app.syncDiscardLegacyDraft();
  assert.strictEqual(app._getDateDraft('2026-09-11'), null);
  assert.strictEqual(app.__storage.getItem('spt_draft_v2'), null);
  assert.strictEqual(field(app, 'sync-day-banner').style.display, 'none');
  app.__storage.setItem('spt_drafts_v1', JSON.stringify({ '2026-09-11': legacy }));
  app._migrateSyncV1();
  assert.strictEqual(JSON.parse(app.__storage.getItem('spt_drafts_v1'))['2026-09-11'].base, undefined, 'second run is a no-op');
});

// The shape of a real pre-6.1 device: exact-copy drafts for saved days, plus a
// draft for "today", which has no saved day yet, held in both draft stores.
function preSixOneDevice(todayDraft) {
  const local = { '2026-09-29': localDay(), '2026-09-30': localDay(), '2026-10-01': localDay() };
  const probe = boot({ local, date: '2026-10-01' });
  probe.loadActiveDate();
  const copy = plain(probe._buildDraftFromForm());
  delete copy.base;
  const map = { '2026-09-29': { ...copy, date: '2026-09-29' }, '2026-09-30': { ...copy, date: '2026-09-30' }, '2026-10-01': copy, '2026-10-02': todayDraft };
  return boot({ local, date: '2026-10-02', seed: { spt_drafts_v1: JSON.stringify(map), spt_draft_v2: JSON.stringify(todayDraft) } });
}
const withoutBase = d => { const c = { ...d }; delete c.base; return c; };

test('a pre-6.1 draft for a day with no saved version is kept and restored at start-up, never offered as stale or deleted', () => {
  const blank = boot({ date: '2026-10-02' });
  const todayDraft = { ...plain(blank._buildDraftFromForm()), reflectionWin: 'unsaved today', musicFree: true };
  delete todayDraft.base;
  const app = preSixOneDevice(todayDraft);
  app._migrateSyncV1();                                   // the real start-up order
  const map = JSON.parse(app.__storage.getItem('spt_drafts_v1'));
  assert.deepStrictEqual(Object.keys(map), ['2026-10-02'], 'exact copies of saved days removed; the unsaved day kept');
  assert.deepStrictEqual(map['2026-10-02'].base, { fp: null });
  assert.deepStrictEqual(withoutBase(map['2026-10-02']), todayDraft, 'content untouched');
  const active = JSON.parse(app.__storage.getItem('spt_draft_v2'));
  assert.deepStrictEqual(active.base, { fp: null });
  assert.deepStrictEqual(withoutBase(active), todayDraft);

  assert.strictEqual(app._openActiveDateAtBoot(), true);
  assert.strictEqual(field(app, 'reflection-win').value, 'unsaved today', 'restored into the form');
  assert.strictEqual(field(app, 'sync-day-banner').style.display, 'none', 'not offered as stale or legacy');
  assert.strictEqual(app._formHasEdits(), true);
  assert.ok(app._getDateDraft('2026-10-02'), 'still kept');

  // Moving away and back keeps it: it is real unsaved work.
  app.selectActiveDate('2026-10-01');
  assert.ok(app._getDateDraft('2026-10-02'));
  app.selectActiveDate('2026-10-02');
  assert.strictEqual(field(app, 'reflection-win').value, 'unsaved today');
  assert.strictEqual(field(app, 'sync-day-banner').style.display, 'none');
});

test('an empty pre-6.1 draft for a day with no saved version (autosaved on open) is kept harmlessly, then dropped once nothing differs', () => {
  const blank = boot({ date: '2026-10-02' });
  const emptyDraft = plain(blank._buildDraftFromForm());
  delete emptyDraft.base;
  const app = preSixOneDevice(emptyDraft);
  app._migrateSyncV1();
  assert.deepStrictEqual(Object.keys(JSON.parse(app.__storage.getItem('spt_drafts_v1'))), ['2026-10-02']);
  assert.strictEqual(app._openActiveDateAtBoot(), true);
  assert.strictEqual(field(app, 'sync-day-banner').style.display, 'none', 'no notice for a draft with nothing in it');
  assert.strictEqual(app._formHasEdits(), false);
  app.selectActiveDate('2026-10-01');                     // leaving saves the draft: nothing differs, so it goes
  assert.strictEqual(app._getDateDraft('2026-10-02'), null);
  assert.strictEqual(app.__storage.getItem('spt_draft_v2'), null);
  assert.strictEqual(days(app)['2026-10-02'], undefined, 'no day is created');
});

// ── signing in: Cloud Sync OFF, one sync per session ─────────────────────────

test('Cloud Sync OFF: signing in reads preferences only — nothing is pulled or uploaded (D6)', async () => {
  const cloud = makeCloud({ rows: [cloudRow('2026-09-10')], prefs: { cloud_sync_enabled: false } });
  const app = boot({ local: { '2026-09-11': localDay() }, cloud });
  await flush();
  assert.strictEqual(cloud.selects.length, 0);
  assert.strictEqual(cloud.upserts.length, 0);
  assert.strictEqual(cloud.prefWrites.length, 0);
  assert.deepStrictEqual(Object.keys(days(app)), ['2026-09-11']);
  assert.strictEqual(R(app, 'cloudSyncEnabled'), false);
});

test('one sync per signed-in session: start-up and token-refresh events do not sync again', async () => {
  const cloud = makeCloud({ rows: [cloudRow('2026-09-10')] });
  boot({ cloud });
  await flush();
  cloud.emit('INITIAL_SESSION');
  cloud.emit('TOKEN_REFRESHED');
  cloud.emit('SIGNED_IN');
  await flush();
  assert.strictEqual(cloud.selects.length, 1, 'exactly one pull');
});

test('signing out and back in starts one new sync', async () => {
  const cloud = makeCloud({ rows: [cloudRow('2026-09-10')] });
  const app = boot({ cloud });
  await flush();
  await app.signOutCloud();
  await flush();
  assert.strictEqual(R(app, 'currentSupabaseUser'), null);
  cloud.signIn();
  cloud.emit('TOKEN_REFRESHED');
  await flush();
  assert.strictEqual(cloud.selects.length, 2);
});

// ── pull and reconcile ──────────────────────────────────────────────────────

test('a device and cloud that already match upload nothing, now or on the next sync', async () => {
  const dates = ['2026-09-08', '2026-09-09', '2026-09-10'];
  const cloud = makeCloud({ rows: dates.map(d => cloudRow(d)) });
  const local = Object.fromEntries(dates.map(d => [d, localDay()]));
  const app = boot({ local, cloud });
  await flush();
  assert.strictEqual(cloud.upserts.length, 0);
  dates.forEach(d => assert.strictEqual(note(app, d).h, rowFp(app, cloudRow(d))));
  await app.syncNow();
  assert.strictEqual(cloud.upserts.length, 0);
  assert.match(field(app, 'backup-status').textContent || field(app, 'backup-status').innerHTML, /Already in sync/);
});

test('only changed days are uploaded, once', async () => {
  const dates = ['2026-09-08', '2026-09-09', '2026-09-10'];
  const cloud = makeCloud({ rows: dates.map(d => cloudRow(d)) });
  const app = boot({ local: Object.fromEntries(dates.map(d => [d, localDay()])), cloud, date: '2026-09-09' });
  await flush();
  app.loadActiveDate();
  field(app, 'reflection-win').value = 'changed here';
  assert.strictEqual(app.saveDay(), true);
  await flush();
  assert.deepStrictEqual(cloud.uploaded(), ['2026-09-09']);
  assert.strictEqual(cloud.rows.get('2026-09-09').reflection.win, 'changed here');
  await app.syncNow();
  assert.deepStrictEqual(cloud.uploaded(), ['2026-09-09'], 'nothing more on the next sync');
});

test('a day only in the cloud is stored exactly as the cloud has it — never rescored', async () => {
  const row = cloudRow('2026-04-01', { scoring_version: null, score: 133.5, max_score: 140, gaze: { value: 'relapse', trigger: 't' } });
  const cloud = makeCloud({ rows: [row] });
  const app = boot({ cloud });
  await flush();
  const d = days(app)['2026-04-01'];
  assert.strictEqual(d.score, 133.5);
  assert.strictEqual(d.maxScore, 140);
  assert.ok(!('scoringVersion' in d), 'legacy stays legacy');
  assert.strictEqual(recFp(app, '2026-04-01', d), rowFp(app, row));
  assert.strictEqual(cloud.upserts.length, 0, 'nothing sent back');
});

test('a day unchanged here takes the cloud’s newer version exactly', async () => {
  const old = cloudRow('2026-09-10');
  const cloud = makeCloud({ rows: [old] });
  const app = boot({ local: { '2026-09-10': { ...localDay(), _sync: { v: 1, h: rowFp(boot(), old), at: 'x' } } }, cloud });
  const newer = cloudRow('2026-09-10', { score: 61.25, reflection: { win: 'other device', improve: '' }, saved_at: '2026-09-11T09:00:00.000Z' });
  cloud.store(newer);
  await flush();
  const d = days(app)['2026-09-10'];
  assert.strictEqual(d.reflection.win, 'other device');
  assert.strictEqual(d.score, 61.25);
  assert.strictEqual(cloud.upserts.length, 0);
});

test('a day changed on both sides is held with both versions; nothing is uploaded and nobody wins silently (D2)', async () => {
  const base = cloudRow('2026-09-10');
  const probe = boot();
  const cloud = makeCloud({ rows: [cloudRow('2026-09-10', { reflection: { win: 'cloud edit', improve: '' }, saved_at: '2026-09-11T00:00:00Z' })] });
  const mine = localDay({ reflection: { win: 'device edit', improve: '' }, savedAt: '2026-09-11T01:00:00Z', _sync: { v: 1, h: rowFp(probe, base), at: 'x' } });
  const app = boot({ local: { '2026-09-10': mine }, cloud });
  await flush();
  const d = days(app)['2026-09-10'];
  assert.strictEqual(d.reflection.win, 'device edit', 'this device’s version is untouched');
  assert.strictEqual(d._sync.held.reason, 'both-changed');
  assert.strictEqual(d._sync.held.other.reflection.win, 'cloud edit');
  assert.strictEqual(cloud.upserts.length, 0);
  assert.strictEqual(cloud.rows.get('2026-09-10').reflection.win, 'cloud edit', 'the cloud is untouched');
  assert.match(field(app, 'sync-issues').innerHTML, /2026-09-10[\s\S]*Keep this device[\s\S]*Use the other version/);
  await app.syncNow();
  assert.strictEqual(cloud.upserts.length, 0, 'still held on the next sync');
});

test('a never-confirmed day that differs from the cloud is held too', async () => {
  const cloud = makeCloud({ rows: [cloudRow('2026-09-10')] });
  const app = boot({ local: { '2026-09-10': localDay({ reflection: { win: 'local only', improve: '' } }) }, cloud });
  await flush();
  assert.strictEqual(note(app, '2026-09-10').held.reason, 'never-confirmed');
  assert.strictEqual(cloud.upserts.length, 0);
});

test('resolving: Keep this device uploads it unchanged; Use the other version stores the cloud’s exactly', async () => {
  const cloud = makeCloud({ rows: [cloudRow('2026-09-10', { score: 70 }), cloudRow('2026-09-11', { score: 20, scoring_version: null })] });
  const app = boot({ cloud, local: {
    '2026-09-10': localDay({ score: 44, reflection: { win: 'mine', improve: '' } }),
    '2026-09-11': localDay({ score: 45, reflection: { win: 'mine too', improve: '' } }),
  } });
  await flush();
  app.syncKeepThisDevice('2026-09-10');
  app.syncUseOtherVersion('2026-09-11');
  await flush();
  assert.deepStrictEqual(cloud.uploaded(), ['2026-09-10']);
  assert.strictEqual(cloud.rows.get('2026-09-10').score, 44, 'uploaded exactly as stored here');
  const d11 = days(app)['2026-09-11'];
  assert.strictEqual(d11.score, 20);
  assert.ok(!('scoringVersion' in d11), 'the other version is kept as it was, not rescored');
  assert.ok(!note(app, '2026-09-10').held && !note(app, '2026-09-11').held);
  assert.strictEqual(field(app, 'sync-issues').style.display, 'none');
});

test('a confirmed day that is missing from the cloud is uploaded again', async () => {
  const probe = boot();
  const cloud = makeCloud({ rows: [] });
  const app = boot({ cloud, local: { '2026-09-10': { ...localDay(), _sync: { v: 1, h: recFp(probe, '2026-09-10', localDay()), at: 'x' } } } });
  await flush();
  assert.deepStrictEqual(cloud.uploaded(), ['2026-09-10']);
});

test('the pull reads every page, 500 rows at a time', async () => {
  const rows = [];
  for (let i = 0; i < 1203; i++) rows.push(cloudRow(new Date(Date.UTC(2023, 0, 1) + i * 864e5).toISOString().slice(0, 10)));
  const cloud = makeCloud({ rows });
  const app = boot({ cloud });
  await flush(80);
  assert.deepStrictEqual(cloud.selects.map(s => [s.from, s.to]), [[0, 499], [500, 999], [1000, 1499]]);
  assert.strictEqual(Object.keys(days(app)).length, 1203);
  assert.strictEqual(cloud.upserts.length, 0);
});

test('a failed page changes nothing on this device', async () => {
  const rows = [];
  for (let i = 0; i < 700; i++) rows.push(cloudRow(new Date(Date.UTC(2024, 0, 1) + i * 864e5).toISOString().slice(0, 10)));
  const cloud = makeCloud({ rows });
  cloud.failPage = from => (from === 500 ? { message: 'Failed to fetch' } : null);
  const local = { '2026-09-10': localDay({ reflection: { win: 'local', improve: '' } }) };
  const app = boot({ cloud, local });
  const before = app.__storage.getItem('spt_v2');
  await flush(80);
  assert.strictEqual(app.__storage.getItem('spt_v2'), before);
  assert.strictEqual(cloud.upserts.length, 0);
  assert.match(field(app, 'backup-status').textContent || field(app, 'backup-status').innerHTML, /Cloud sync failed/);
});

// ── upload ──────────────────────────────────────────────────────────────────

test('changed days are uploaded in batches of 50', async () => {
  const local = {};
  for (let i = 0; i < 120; i++) local[new Date(Date.UTC(2025, 0, 1) + i * 864e5).toISOString().slice(0, 10)] = localDay();
  const cloud = makeCloud({ rows: [] });
  boot({ cloud, local });
  await flush(80);
  assert.deepStrictEqual(cloud.upserts.map(u => u.rows.length), [50, 50, 20]);
  assert.strictEqual(cloud.rows.size, 120);
});

test('a day the database rejects does not block the others, is shown, and is not retried until it changes (D8)', async () => {
  const cloud = makeCloud({ rows: [] });
  const app = boot({ cloud, date: '2026-04-02', local: {
    '2026-04-01': localDay(), '2026-04-02': localDay({ score: -5, scoringVersion: undefined }), '2026-04-03': localDay(),
  } });
  await flush();
  assert.deepStrictEqual([...cloud.rows.keys()].sort(), ['2026-04-01', '2026-04-03']);
  assert.strictEqual(days(app)['2026-04-02'].score, -5, 'the rejected day is not altered');
  assert.strictEqual(note(app, '2026-04-02').err.kind, 'validation');
  assert.match(field(app, 'sync-issues').innerHTML, /2026-04-02[\s\S]*below 0/);
  const sent = cloud.upserts.length;
  await app.syncNow();
  assert.strictEqual(cloud.upserts.length, sent, 'not retried while unchanged');
  // Once the user changes and saves it, it is tried again.
  app.loadActiveDate();
  field(app, 'reflection-win').value = 'fixed';
  app.saveDay();
  await flush();
  assert.ok(cloud.rows.has('2026-04-02'));
  assert.ok(!note(app, '2026-04-02').err);
});

test('a network failure leaves the days pending for the next sync', async () => {
  const cloud = makeCloud({ rows: [] });
  let fail = true;
  cloud.failUpsert = () => (fail ? { message: 'TypeError: Failed to fetch' } : null);
  const app = boot({ cloud, local: { '2026-09-10': localDay(), '2026-09-11': localDay() } });
  await flush();
  assert.strictEqual(cloud.rows.size, 0);
  assert.strictEqual(note(app, '2026-09-10').err.kind, 'transient');
  fail = false;
  await app.syncNow();
  assert.strictEqual(cloud.rows.size, 2);
  assert.ok(!note(app, '2026-09-10').err);
});

test('a day edited while its upload is in flight stays pending', async () => {
  const cloud = makeCloud({ rows: [] });
  const app = boot({ cloud, local: { '2026-09-10': localDay() } });
  let once = true;
  cloud.beforeUpsert = () => {
    if (!once) return; once = false;
    const h = app.getStorage(); h['2026-09-10'] = { ...h['2026-09-10'], reflection: { win: 'edited meanwhile', improve: '' }, savedAt: '2026-09-12T00:00:00Z' }; app.setStorage(h);
  };
  await flush();
  const n = note(app, '2026-09-10');
  assert.strictEqual(n.h, recFp(app, '2026-09-10', localDay()), 'records the version that reached the cloud');
  assert.notStrictEqual(n.h, recFp(app, '2026-09-10', days(app)['2026-09-10']), 'the newer edit is still pending');
  await app.syncNow();
  assert.strictEqual(cloud.rows.get('2026-09-10').reflection.win, 'edited meanwhile');
  assert.ok(!note(app, '2026-09-10').held, 'uploaded, not held');
});

test('one sync at a time; requests made meanwhile queue exactly one more run', async () => {
  const cloud = makeCloud({ rows: [cloudRow('2026-09-10')], signedIn: false });
  const app = boot({ cloud });
  await flush();
  R(app, `currentSupabaseUser={id:${JSON.stringify(UID)}};cloudSyncEnabled=true;`);
  cloud.session = { user: { id: UID } };
  let release; cloud.gate = new Promise(r => { release = r; });
  const a = app.syncNow(), b = app.syncNow(), c = app.syncNow();
  await flush();
  assert.strictEqual(cloud.selects.length, 1, 'the second and third requests wait');
  cloud.gate = null; release();
  await Promise.all([a, b, c]);
  await flush();
  assert.strictEqual(cloud.selects.length, 2, 'one queued re-run, not two');
  assert.strictEqual(cloud.maxInFlight, 1);
  assert.strictEqual(R(app, '_cloudSyncBusy'), false);
});

test('a day saved while a sync is running is uploaded, not lost or held', async () => {
  const cloud = makeCloud({ rows: [cloudRow('2026-09-10')] });
  let release; cloud.gate = new Promise(r => { release = r; });
  const confirmed = { ...localDay(), _sync: { v: 1, h: rowFp(boot(), cloudRow('2026-09-10')), at: 'x' } };
  const app = boot({ cloud, date: '2026-09-10', local: { '2026-09-10': confirmed } });
  await flush();
  app._openActiveDateAtBoot();
  field(app, 'reflection-win').value = 'saved mid-sync';
  assert.strictEqual(app.saveDay(), true);
  cloud.gate = null; release();
  await flush(80);
  assert.strictEqual(cloud.rows.get('2026-09-10').reflection.win, 'saved mid-sync');
  assert.ok(!note(app, '2026-09-10').held);
  assert.strictEqual(cloud.selects.length, 2, 'the save queued one more run');
  assert.strictEqual(cloud.maxInFlight, 1);
});

test('a held version that exists only on this device survives later cloud changes', async () => {
  const probe = boot();
  const tabB = localDay({ reflection: { win: 'other tab', improve: '' }, savedAt: '2026-09-11T00:00:00Z' });
  const held = { reason: 'stale-base', at: 'x', other: tabB, otherFp: recFp(probe, '2026-09-10', tabB), otherSide: 'local' };
  const mine = localDay({ reflection: { win: 'this tab', improve: '' }, savedAt: '2026-09-11T01:00:00Z', _sync: { v: 1, h: null, at: null, held } });
  const cloud = makeCloud({ rows: [cloudRow('2026-09-10', { reflection: { win: 'third device', improve: '' } })] });
  const app = boot({ cloud, local: { '2026-09-10': mine } });
  await flush();
  const n = note(app, '2026-09-10');
  assert.strictEqual(n.held.other.reflection.win, 'other tab', 'the local-only version is kept');
  assert.strictEqual(days(app)['2026-09-10'].reflection.win, 'this tab');
  assert.strictEqual(cloud.upserts.length, 0);
});

// ── the open day: cloud updates while editing (D3, D4) ───────────────────────

test('a cloud update with no edits on screen reloads the open day', async () => {
  const cloud = makeCloud({ rows: [cloudRow('2026-09-10')] });
  const app = boot({ cloud, date: '2026-09-10', local: { '2026-09-10': localDay() } });
  await flush();
  app._openActiveDateAtBoot();
  cloud.store(cloudRow('2026-09-10', { reflection: { win: 'newer', improve: '' }, saved_at: '2026-09-11T00:00:00Z' }));
  await app.syncNow();
  assert.strictEqual(field(app, 'reflection-win').value, 'newer');
});

test('a cloud update while editing asks first (D4); saving anyway keeps both versions (D3)', async () => {
  const cloud = makeCloud({ rows: [cloudRow('2026-09-10')] });
  const app = boot({ cloud, date: '2026-09-10', local: { '2026-09-10': localDay() } });
  await flush();
  app._openActiveDateAtBoot();
  field(app, 'reflection-win').value = 'typing here';
  cloud.store(cloudRow('2026-09-10', { reflection: { win: 'other device', improve: '' }, saved_at: '2026-09-11T00:00:00Z' }));
  await app.syncNow();
  assert.strictEqual(field(app, 'reflection-win').value, 'typing here', 'edits are not discarded');
  assert.match(field(app, 'sync-day-banner').innerHTML, /updated on another device[\s\S]*Load saved version[\s\S]*Keep editing/);
  app.syncDismissBanner();
  assert.strictEqual(app.saveDay(), true);
  await flush();
  const d = days(app)['2026-09-10'];
  assert.strictEqual(d.reflection.win, 'typing here');
  assert.strictEqual(d._sync.held.reason, 'stale-base');
  assert.strictEqual(d._sync.held.other.reflection.win, 'other device');
  assert.strictEqual(cloud.rows.get('2026-09-10').reflection.win, 'other device', 'nothing overwritten');
  assert.strictEqual(cloud.uploaded().length, 0);
  app.syncKeepThisDevice('2026-09-10');
  await flush();
  assert.strictEqual(cloud.rows.get('2026-09-10').reflection.win, 'typing here', 'uploaded once the user chose');
});

test('Load saved version replaces the edits with the cloud’s version', async () => {
  const cloud = makeCloud({ rows: [cloudRow('2026-09-10')] });
  const app = boot({ cloud, date: '2026-09-10', local: { '2026-09-10': localDay() } });
  await flush();
  app._openActiveDateAtBoot();
  field(app, 'reflection-win').value = 'typing here';
  app.saveDraft();
  cloud.store(cloudRow('2026-09-10', { reflection: { win: 'other device', improve: '' }, saved_at: '2026-09-11T00:00:00Z' }));
  await app.syncNow();
  app.syncLoadSavedVersion();
  assert.strictEqual(field(app, 'reflection-win').value, 'other device');
  assert.strictEqual(app._getDateDraft('2026-09-10'), null);
  assert.strictEqual(field(app, 'sync-day-banner').style.display, 'none');
});

// ── preferences (D9) ────────────────────────────────────────────────────────

test('preferences are uploaded only when their content changed (D9)', async () => {
  const cloud = makeCloud({ rows: [], prefs: null });
  const app = boot({ cloud });
  await flush();
  assert.strictEqual(cloud.prefWrites.length, 1, 'no saved preferences yet: written once');
  await app.syncNow();
  await app._savePreferencesIfChanged();
  assert.strictEqual(cloud.prefWrites.length, 1, 'unchanged: not written again');
  R(app, 'isSistersMode=true');
  await app.syncNow();
  assert.strictEqual(cloud.prefWrites.length, 2);
  assert.strictEqual(cloud.prefs.sisters_mode, true);
});

test('preferences read at sign-in become the baseline, so an unchanged device sends none', async () => {
  const probe = makeCloud({ rows: [], prefs: null });
  const first = boot({ cloud: probe });
  await flush();
  const stored = probe.prefs;                       // exactly what this device sends
  const cloud = makeCloud({ rows: [], prefs: { ...stored, updated_at: '2026-09-01T00:00:00+00:00' } });
  boot({ cloud });
  await flush();
  assert.ok(first);
  assert.strictEqual(cloud.prefWrites.length, 0);
});
