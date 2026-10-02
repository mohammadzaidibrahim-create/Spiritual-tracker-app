// Canonical, version-aware section scoring (report-correctness step, R-1..R-4).
// One definition of each section's points serves the live score and every
// read-back of a saved day; recorded days are independent of points.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const { loadApp, plain } = require('./harness.js');

const pickGaze = (app, val) => app.selectGaze({ dataset: { val }, classList: { add() {} } });
const el = (app, id) => app.__document.getElementById(id);
const pts = (app, day) => plain(app.daySectionPoints(day));
const rec = (app, day) => plain(app.daySectionRecorded(day));

test('gaze points follow each day’s own scoring version', () => {
  const app = loadApp();
  const gaze = (g, v) => pts(app, { gaze: g, scoringVersion: v }).gaze;
  for (const v of [undefined, null, 3]) {                    // legacy and v3: signed
    assert.deepStrictEqual([gaze('nottracked', v), gaze('success', v), gaze('compromised', v), gaze('relapse', v)], [0, 10, -5, -10], String(v));
  }
  assert.deepStrictEqual([gaze('success', 2), gaze('compromised', 2), gaze('relapse', 2)], [10, 0, 0], 'v2: lapses score 0');
});

test('legacy sections are not floored; v2 and v3 floor every section except gaze', () => {
  const app = loadApp();
  const day = (v) => ({ scoringVersion: v, dhikrData: [{ count: -500 }],
    customSectionData: { c1: { name: 'C', tasks: [{ id: 't', points: -5, done: true }] } } });
  assert.strictEqual(pts(app, day(undefined)).dhikr, -5);
  assert.strictEqual(pts(app, day(undefined)).custom.c1, -5);
  for (const v of [2, 3]) {
    assert.strictEqual(pts(app, day(v)).dhikr, 0, `v${v} dhikr`);
    assert.strictEqual(pts(app, day(v)).custom.c1, 0, `v${v} custom`);
  }
});

test('section formulas from stored inputs', () => {
  const app = loadApp();
  const day = { scoringVersion: 3, gaze: 'success', musicFree: true, fast: true, habitsCount: 2,
    salahData: { Fajr: 3, Dhuhr: 3, Asr: 1, Maghrib: 1, Isha: 1 },
    voluntary: { tahajjud: true, ishraq: true, chast: false, extraNafl: [{ checked: true }, { checked: false }] },
    dhikrData: [{ count: 100 }, { count: '250' }], quran: { done: true, onepage: true, kahf: true, nightly: true, mins: '15' },
    customSectionData: { c1: { tasks: [{ points: 2, done: true }, { points: 3, done: false }] } } };
  assert.deepStrictEqual(pts(app, day), { custom: { c1: 2 }, salah: 13, gaze: 10, music: 10, dhikr: 3.5, quran: 37, fast: 20, habits: 20 });
  const hayd = pts(app, { ...day, isHaydMode: true });
  assert.strictEqual(hayd.salah, 0, 'no salah points in hayd');
  assert.strictEqual(hayd.fast, 0, 'no fast points in hayd');
  assert.strictEqual(hayd.quran, 37, 'Qur’an still counts in hayd');
});

test('one formula, two entry points: live scores equal the read-back of the saved day', () => {
  const app = loadApp();
  for (const [i, v] of ['3', '1', '2', '0', '3'].entries()) el(app, 'salah-' + i).value = v;
  el(app, 'vol-tahajjud').checked = true; el(app, 'music-free').checked = true;
  el(app, 'quran-read').checked = true; el(app, 'quran-nightly').checked = true; el(app, 'fast-done').checked = true;
  app._addDhikrItem('Istighfar');
  const [id] = vm.runInContext('dhikrItems.map(d => d.id)', app);
  app.updateDhikrCount(id, '450');
  pickGaze(app, 'compromised');
  const live = { salah: app.calcSalahScore(), gaze: app.calcGazeScore(), music: app.calcMusicScore(), dhikr: app.calcDhikrScore(),
    quran: app.calcQuranScore(), fast: app.calcFastScore(), habits: app.calcHabitsScore() };
  assert.strictEqual(app.saveDay(), true);
  const [day] = Object.values(JSON.parse(app.__storage.getItem('spt_v2')));
  const back = pts(app, day);
  for (const k of Object.keys(live)) {
    assert.strictEqual(back[k], live[k], `${k}: read-back equals live`);
    assert.strictEqual(day[k + 'Score'], live[k], `${k}: stored field equals live`);
  }
  assert.strictEqual(day.score, app._dayTotalPoints(Object.values(live).reduce((a, b) => a + b, 0), 3));
});

test('a day read back after the cloud round trip earns exactly the same points', () => {
  const app = loadApp();
  vm.runInContext("currentSupabaseUser = { id: 'u-test' }", app);
  el(app, 'salah-0').value = '3'; el(app, 'vol-ishraq').checked = true; el(app, 'quran-read').checked = true;
  app._addDhikrItem('Durood');
  const [id] = vm.runInContext('dhikrItems.map(d => d.id)', app);
  app.updateDhikrCount(id, '1700');
  pickGaze(app, 'relapse');
  app.saveDay();
  const [[key, day]] = Object.entries(JSON.parse(app.__storage.getItem('spt_v2')));
  const pulled = plain(app._rowToLocalPayload({ record_date: key, ...app._localPayloadToRow(key, day) }));
  assert.strictEqual(pulled.salahScore, 0, 'precondition: the pull still zeroes stored per-section fields (Step 6)');
  assert.deepStrictEqual(pts(app, pulled), pts(app, day), 'derived points do not depend on those fields');
});

test('recorded is independent of points', () => {
  const app = loadApp();
  assert.strictEqual(rec(app, { gaze: 'compromised' }).gaze, true);
  assert.strictEqual(rec(app, { gaze: 'relapse' }).gaze, true);
  assert.strictEqual(rec(app, { gaze: 'nottracked' }).gaze, false);
  assert.strictEqual(rec(app, { khushu: 'low' }).salah, true, 'khushu alone records salah');
  assert.strictEqual(rec(app, { salahData: { Fajr: 0, Dhuhr: 0 } }).salah, false, '"Missed" cannot be told from unanswered');
  assert.strictEqual(rec(app, { quran: { mins: '10' } }).quran, true, 'minutes alone record Qur’an (0 points)');
  assert.strictEqual(pts(app, { quran: { mins: '10' } }).quran, 0);
  assert.strictEqual(rec(app, { dhikrData: [{ count: 0 }] }).dhikr, false);
  assert.strictEqual(rec(app, { musicFree: false }).music, false);
  assert.strictEqual(rec(app, { habitsCount: 1 }).habits, true);
  assert.strictEqual(rec(app, { customSectionData: { c1: { tasks: [{ done: true, points: 0 }] } } }).custom.c1, true);
});

test('section recorded flags agree with the Step 4 active-day rule', () => {
  const app = loadApp();
  const anyRecorded = (d) => { const r = rec(app, d); return Object.entries(r).some(([k, v]) => k === 'custom' ? Object.values(v).some(Boolean) : v); };
  const reflection = (d) => !!(String((d.reflection || {}).win || '').trim() || String((d.reflection || {}).improve || '').trim());
  const cases = [{}, { gaze: 'nottracked' }, { salahData: { Fajr: 2 } }, { voluntary: { chast: true } }, { voluntary: { extraNafl: [{ checked: true }] } },
    { khushu: 'high' }, { gaze: 'success' }, { gaze: 'relapse' }, { trigger: 'late' }, { musicFree: true }, { fast: true },
    { dhikrData: [{ count: 5 }] }, { quran: { kahf: true } }, { quran: { pages: '1' } }, { habitsCount: 1 }, { habits: [{ done: true }] },
    { customSectionData: { c: { tasks: [{ done: true }] } } }, { reflection: { win: 'x' } }, { quran: { mins: '0' }, dhikrData: [{ count: 0 }] }];
  for (const d of cases) assert.strictEqual(app._dayHasGenuineInput(d), anyRecorded(d) || reflection(d), JSON.stringify(d));
});

test('reading a day back never changes it', () => {
  const app = loadApp();
  const day = { scoringVersion: 2, gaze: 'relapse', salahData: { Fajr: 3 }, salahScore: 0, gazeScore: 0, score: 3 };
  const before = JSON.stringify(day);
  app.daySectionPoints(day); app.daySectionRecorded(day);
  assert.strictEqual(JSON.stringify(day), before);
});
