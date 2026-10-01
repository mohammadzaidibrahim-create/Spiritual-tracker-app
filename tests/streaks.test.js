// P0 step 4 — engagement streaks. Owner decisions P0-01..P0-04: a day is active
// when it holds at least one genuine user-recorded input, whatever its score;
// hayd days are paused; backfilled days count; earned badges are never revoked.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadApp, makeStorage, plain } = require('./harness.js');

// A fixed "today" keeps every test independent of the real date.
const TODAY = new Date(2026, 5, 15, 12);            // 2026-06-15, local
const key = (offset) => {                            // offset in days from TODAY
  const d = new Date(TODAY); d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const SAVED = '2026-06-15T20:00:00.000Z';
const ACTIVE = { score: 50, maxScore: 60, gaze: 'success', savedAt: SAVED };
const EMPTY = {
  score: 0, maxScore: 60, gaze: 'nottracked', khushu: '', trigger: '', musicFree: false, fast: false,
  salahData: { Fajr: 0, Dhuhr: 0 }, voluntary: { tahajjud: false, extraNafl: [] }, dhikrData: [{ name: 'Istighfar', count: 0 }],
  quran: { done: false, mins: '0', pages: '0' }, habitsCount: 0, habits: [{ name: 'Walk', done: false }],
  customSectionData: { c1: { tasks: [{ id: 't', done: false }] } }, reflection: { win: '  ', improve: '' }, savedAt: SAVED,
};
const HAYD = { ...EMPTY, isHaydMode: true, isSistersMode: true };
const appWith = (days) => loadApp({ storage: makeStorage({ spt_v2: JSON.stringify(days) }) });
const streaks = (app) => plain(app.calcStreaks(TODAY));

test('an empty save is not an active day', () => {
  assert.strictEqual(loadApp()._streakDayState(EMPTY), 'inactive');
  assert.strictEqual(loadApp()._streakDayState(undefined), 'missing');
});

test('any single genuine input makes a day active', () => {
  const app = loadApp();
  const inputs = {
    salah: { salahData: { Fajr: 2 } }, nafl: { voluntary: { tahajjud: true } },
    extraNafl: { voluntary: { extraNafl: [{ name: 'x', checked: true }] } }, khushu: { khushu: 'high' },
    gazeSuccess: { gaze: 'success' }, gazeCompromised: { gaze: 'compromised' }, gazeRelapse: { gaze: 'relapse' },
    trigger: { trigger: 'late night' }, music: { musicFree: true }, fast: { fast: true },
    dhikr: { dhikrData: [{ name: 'Istighfar', count: 100 }] }, quranRead: { quran: { done: true } },
    quranMins: { quran: { mins: '15' } }, kahf: { quran: { kahf: true } }, habitsCount: { habitsCount: 1 },
    habitsArray: { habits: [{ name: 'Walk', done: true }] },
    custom: { customSectionData: { c1: { tasks: [{ id: 't', done: true }] } } },
    reflectionWin: { reflection: { win: 'Prayed Fajr on time' } }, reflectionImprove: { reflection: { improve: 'Sleep earlier' } },
  };
  for (const [name, patch] of Object.entries(inputs)) {
    assert.strictEqual(app._streakDayState({ ...EMPTY, ...patch }), 'active', name);
  }
});

test('recording a relapse is engagement: the day is active whatever its score', () => {
  const app = loadApp();
  for (const day of [
    { gaze: 'relapse', score: -10 },                         // v1 legacy, old deduction stored
    { gaze: 'relapse', score: 0, scoringVersion: 2 },        // v2
    { gaze: 'relapse', score: 0, scoringVersion: 3 },        // v3 (signed gaze, total floored at 0)
  ]) assert.strictEqual(app._streakDayState({ ...EMPTY, ...day }), 'active');
});

test('a calendar gap breaks the best streak (gaps used to be ignored)', () => {
  const days = {};
  for (const o of [-8, -7, -6]) days[key(o)] = ACTIVE;           // run of 3
  for (const o of [-4, -3, -2, -1]) days[key(o)] = ACTIVE;       // gap at -5, then a run of 4
  const s = streaks(appWith(days));
  assert.strictEqual(s.bestStreak, 4);
  assert.strictEqual(s.currentStreak, 4);
  assert.strictEqual(s.legacyBestStreak, 7, 'the earlier counting ignored the gap');
});

test('today in progress never breaks the current streak, and counts once active', () => {
  const days = { [key(-2)]: ACTIVE, [key(-1)]: ACTIVE };
  assert.strictEqual(streaks(appWith(days)).currentStreak, 2, 'today unsaved');
  assert.strictEqual(streaks(appWith({ ...days, [key(0)]: EMPTY })).currentStreak, 2, 'today saved but empty');
  assert.strictEqual(streaks(appWith({ ...days, [key(0)]: ACTIVE })).currentStreak, 3, 'today active');
  assert.strictEqual(streaks(appWith({ [key(-3)]: ACTIVE, [key(-1)]: EMPTY })).currentStreak, 0, 'an empty past day breaks it');
});

test('hayd days are paused: they neither extend nor break a streak', () => {
  const s = streaks(appWith({ [key(-3)]: ACTIVE, [key(-2)]: HAYD, [key(-1)]: ACTIVE }));
  assert.strictEqual(s.currentStreak, 2);
  assert.strictEqual(s.pausedInCurrent, 1);
  assert.strictEqual(s.bestStreak, 2);
  assert.strictEqual(loadApp()._streakDayState({ ...HAYD, gaze: 'success' }), 'paused', 'paused even with inputs');
});

test('an unsaved day is not paused, even between hayd days', () => {
  const s = streaks(appWith({ [key(-5)]: ACTIVE, [key(-4)]: HAYD, [key(-2)]: HAYD, [key(-1)]: ACTIVE }));
  assert.strictEqual(s.currentStreak, 1, 'the missing day at -3 ends the streak');
});

test('a backfilled day counts and joins the runs either side of it', () => {
  const app = appWith({ [key(-3)]: ACTIVE, [key(-1)]: ACTIVE });
  assert.strictEqual(streaks(app).currentStreak, 1);
  app.selectActiveDate(key(-2));                                  // open the missed day
  app.selectGaze({ dataset: { val: 'success' }, classList: { add() {} } });
  assert.strictEqual(app.saveDay(), true);
  const s = streaks(app);
  assert.strictEqual(s.currentStreak, 3);
  assert.strictEqual(s.bestStreak, 3);
});

test('future-dated records are ignored', () => {
  const s = streaks(appWith({ [key(-1)]: ACTIVE, [key(2)]: ACTIVE, [key(3)]: ACTIVE }));
  assert.strictEqual(s.currentStreak, 1);
  assert.strictEqual(s.bestStreak, 1);
});

test('cloud-pulled days are classified by their inputs', () => {
  const app = loadApp();
  const row = (extra) => plain(app._rowToLocalPayload({ record_date: '2026-06-01', score: 0, max_score: 60,
    gaze: { value: 'nottracked' }, habits: { count: 0, mins: 0, names: [] }, reflection: {}, ...extra }));
  assert.strictEqual(app._streakDayState(row({})), 'inactive');
  assert.strictEqual(app._streakDayState(row({ habits: { count: 1, mins: 10, names: ['Walk'] } })), 'active');
  assert.strictEqual(app._streakDayState(row({ gaze: { value: 'relapse', trigger: 'x' } })), 'active');
  assert.strictEqual(app._streakDayState(row({ is_hayd_mode: true })), 'paused');
});

test('earned badges are kept: no later save can lower the earlier best streak', () => {
  const days = {};
  for (const o of [-9, -8, -7, -5, -4, -3]) days[key(o)] = { ...ACTIVE, savedAt: '2026-09-01T10:00:00.000Z' };
  const app = appWith(days);
  assert.strictEqual(streaks(app).legacyBestStreak, 6, 'gap at -6 ignored by the earlier counting');
  assert.strictEqual(streaks(app).bestStreak, 3);
  // A pre-cutover day re-saved after the cutover under new scoring drops out
  // of the earlier counting; it cannot reset that count to zero.
  const after = { ...days, [key(-8)]: { ...ACTIVE, score: 5, savedAt: '2026-11-01T10:00:00.000Z' } };
  assert.strictEqual(streaks(appWith(after)).legacyBestStreak, 5);
});

test('scoring version and score never change whether a day is active', () => {
  const app = loadApp();
  const base = { ...EMPTY, musicFree: true };
  const states = [{ score: 10 }, { score: 0, scoringVersion: 2 }, { score: 0, scoringVersion: 3, gaze: 'relapse' }, { score: 999 }]
    .map((v) => app._streakDayState({ ...base, ...v }));
  assert.deepStrictEqual(states, ['active', 'active', 'active', 'active']);
});
