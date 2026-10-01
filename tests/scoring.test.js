// Scoring. Step 3 (P0-05/P0-06) introduced versioned scoring; Step 3b (V3-1..V3-5)
// makes gaze a signed measurement of a lapse's severity: success +10,
// compromised -5, relapse -10. Every other section scores >= 0 and the daily
// total is floored at 0. Saved days keep their version and stored scores; only
// an explicit save rescores a day, under the current version (3).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadApp, makeStorage, plain } = require('./harness.js');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// selectGaze() only needs the clicked element's value and classList.
const pickGaze = (app, val) => app.selectGaze({ dataset: { val }, classList: { add() {} } });
const tick = (app, id) => { app.__document.getElementById(id).checked = true; };
const savedDays = (app) => JSON.parse(app.__storage.getItem('spt_v2') || '{}');
const el = (app, id) => app.__document.getElementById(id);

test('gaze is signed: success +10, compromised -5, relapse -10, not tracked 0', () => {
  const app = loadApp();
  for (const [val, pts] of [['nottracked', 0], ['success', 10], ['compromised', -5], ['relapse', -10]]) {
    pickGaze(app, val);
    assert.strictEqual(app.calcGazeScore(), pts, `gaze "${val}"`);
  }
});

test('a lapse alone never makes the day negative', () => {
  for (const val of ['relapse', 'compromised']) {
    const app = loadApp();
    pickGaze(app, val);
    assert.strictEqual(app.calcTotalScore(), 0, val);
  }
});

test('every section except gaze stays >= 0', () => {
  // Dhikr: a typed negative count must not subtract.
  const app = loadApp();
  app._addDhikrItem('Istighfar');
  const [id] = vm.runInContext('dhikrItems.map(d => d.id)', app);
  app.updateDhikrCount(id, '-500');
  assert.strictEqual(app.calcDhikrScore(), 0);

  // Custom section: negative points can arrive via stored or synced config.
  const storage = makeStorage({
    spt_section_config_v1: JSON.stringify({
      order: ['custom_neg'], enabled: { custom_neg: true },
      custom: [{ id: 'custom_neg', icon: '📝', name: 'Neg', tasks: [{ id: 't1', name: 'x', points: -5 }] }],
    }),
  });
  const app2 = loadApp({ storage });
  app2.loadSectionConfig();
  app2.toggleCustomTask('custom_neg', 't1', true);
  assert.strictEqual(app2.calcCustomSectionsScore(), 0);
  pickGaze(app2, 'relapse');
  assert.strictEqual(app2.calcGazeScore(), -10, 'gaze is the one signed section');
  assert.strictEqual(app2.calcTotalScore(), 0);
});

test('positive sections offset a lapse', () => {
  const app = loadApp();
  tick(app, 'music-free'); tick(app, 'quran-read');           // +10 +10
  pickGaze(app, 'relapse');
  assert.strictEqual(app.calcTotalScore(), 10);
  pickGaze(app, 'compromised');
  assert.strictEqual(app.calcTotalScore(), 15);
  const app2 = loadApp();
  tick(app2, 'music-free');                                    // +10
  pickGaze(app2, 'relapse');
  assert.strictEqual(app2.calcTotalScore(), 0, 'relapse -10 + music-free +10 = 0');
});

test('the displayed total always equals the saved total', () => {
  for (const setup of [
    (a) => pickGaze(a, 'relapse'),                                                   // floored: 0
    (a) => { tick(a, 'music-free'); pickGaze(a, 'relapse'); },                       // 0
    (a) => { tick(a, 'music-free'); tick(a, 'quran-read'); pickGaze(a, 'relapse'); }, // 10
    (a) => { tick(a, 'music-free'); pickGaze(a, 'success'); },                       // 20
  ]) {
    const app = loadApp();
    setup(app);
    app.updateScore();
    const total = app.calcTotalScore();
    assert.ok(total >= 0);
    assert.strictEqual(String(el(app, 'score-number').textContent), String(total), 'score ring number');
    assert.strictEqual(String(el(app, 'sticky-score-number').textContent), String(total), 'sticky score');
  }
});

test('max score and percentage are unaffected by a lapse', () => {
  const app = loadApp();
  pickGaze(app, 'success');
  const max = app.calcMaxScore();
  pickGaze(app, 'relapse');
  assert.strictEqual(app.calcMaxScore(), max, 'gaze still contributes its +10 to the maximum');
  app.updateScore();
  assert.strictEqual(el(app, 'sticky-score-pct').textContent, '0%', 'never a negative percentage');
});

test('a negative gaze value is shown signed, in neutral amber, never red', () => {
  const app = loadApp();
  pickGaze(app, 'relapse');
  app.updateScore();
  assert.strictEqual(el(app, 'gaze-pts-badge').textContent, '-10 pts');
  assert.strictEqual(el(app, 'gaze-pts-badge').style.color, 'var(--amber)');
  assert.strictEqual(String(el(app, 'bd-gaze').textContent), '-10');
  assert.strictEqual(el(app, 'bd-gaze').style.color, 'var(--amber)');
  pickGaze(app, 'success');
  app.updateScore();
  assert.strictEqual(el(app, 'bd-gaze').style.color, 'var(--green)');
});

test('a saved day is stamped scoringVersion 3, with signed gaze and a floored total', () => {
  const app = loadApp();
  pickGaze(app, 'relapse');
  assert.strictEqual(app.saveDay(), true);
  const [day] = Object.values(savedDays(app));
  assert.strictEqual(day.scoringVersion, 3);
  assert.strictEqual(day.score, 0);
  assert.strictEqual(day.gazeScore, -10, 'the section keeps its signed value');
  assert.strictEqual(day.gaze, 'relapse', 'the observation itself is still recorded');
});

test('cloud row: a v3 lapse day uploads a score >= 0 and scoring_version 3; a legacy day sends null', () => {
  const app = loadApp();
  // No sign-in flow in the sandbox; set the session the mapper reads.
  vm.runInContext("currentSupabaseUser = { id: 'u-test' }", app);
  pickGaze(app, 'relapse');
  app.saveDay();
  const [[key, day]] = Object.entries(savedDays(app));
  const row = app._localPayloadToRow(key, day);
  assert.strictEqual(row.scoring_version, 3);
  assert.ok(row.score >= 0, 'passes daily_records CHECK (score >= 0)');
  assert.strictEqual(app._localPayloadToRow('2026-04-01', { score: 50 }).scoring_version, null);
});

test('a pulled row keeps its scoring version; a legacy row stays unlabelled', () => {
  const app = loadApp();
  assert.strictEqual(plain(app._rowToLocalPayload({ scoring_version: 2, score: 20 })).scoringVersion, 2);
  assert.strictEqual(plain(app._rowToLocalPayload({ scoring_version: 3, score: 10 })).scoringVersion, 3);
  assert.ok(!('scoringVersion' in plain(app._rowToLocalPayload({ scoring_version: null, score: 50 }))));
});

test('a v3 lapse day survives the sync round trip: score, version, observation and trigger', () => {
  const app = loadApp();
  vm.runInContext("currentSupabaseUser = { id: 'u-test' }", app);
  tick(app, 'music-free'); tick(app, 'quran-read');
  pickGaze(app, 'relapse');
  el(app, 'trigger-text').value = 'late night';
  app.saveDay();
  const [[key, day]] = Object.entries(savedDays(app));
  const back = plain(app._rowToLocalPayload({ record_date: key, ...app._localPayloadToRow(key, day) }));
  assert.strictEqual(back.score, 10);
  assert.strictEqual(back.scoringVersion, 3);
  assert.strictEqual(back.gaze, 'relapse');
  assert.strictEqual(back.trigger, 'late night');
  // Per-section scores (gazeScore etc.) are not carried by the cloud row yet;
  // reconstructing them on pull is the Step 6 round-trip fix.
});

test('opening a legacy (v1) day never rescores it; an explicit save rescores it under v3', () => {
  const legacyDay = { score: 0, maxScore: 37, gaze: 'relapse', gazeScore: -10, musicFree: true, musicScore: 10,
    savedAt: '2026-04-01T20:00:00.000Z' };
  const legacy = JSON.stringify({ '2026-04-01': legacyDay });
  const app = loadApp({ storage: makeStorage({ spt_v2: legacy }) });
  app.selectActiveDate('2026-04-01');
  assert.strictEqual(app.__storage.getItem('spt_v2'), legacy, 'stored legacy day must be byte-identical');
  assert.strictEqual(app.saveDay(), true);
  const day = savedDays(app)['2026-04-01'];
  assert.strictEqual(day.scoringVersion, 3);
  assert.strictEqual(day.gazeScore, -10);
  assert.strictEqual(day.score, 0, 'music-free +10, relapse -10');
});

test('opening a v2 day never rescores it; an explicit save rescores it under v3', () => {
  const v2Day = { score: 20, maxScore: 37, gaze: 'relapse', gazeScore: 0, musicFree: true, musicScore: 10,
    quran: { done: true }, quranScore: 10, scoringVersion: 2, savedAt: '2026-10-01T15:00:00.000Z' };
  const v2 = JSON.stringify({ '2026-09-20': v2Day });
  const app = loadApp({ storage: makeStorage({ spt_v2: v2 }) });
  app.selectActiveDate('2026-09-20');
  assert.strictEqual(app.__storage.getItem('spt_v2'), v2, 'stored v2 day must be byte-identical');
  assert.strictEqual(app.saveDay(), true);
  const day = savedDays(app)['2026-09-20'];
  assert.strictEqual(day.scoringVersion, 3);
  assert.strictEqual(day.gazeScore, -10);
  assert.strictEqual(day.score, 10, 'music-free +10, Qur’an +10, relapse -10');
});

test('a v3 lapse lowers the score but the day stays active for the streak', () => {
  const app = loadApp();
  pickGaze(app, 'relapse');
  app.saveDay();
  const [day] = Object.values(savedDays(app));
  assert.strictEqual(day.score, 0);
  assert.strictEqual(app._streakDayState(day), 'active');
  assert.strictEqual(plain(app.calcStreaks()).currentStreak, 1);
});

test('backup export and restore keep scoringVersion', () => {
  const app = loadApp();
  pickGaze(app, 'success');
  app.saveDay();
  const backup = plain(app.buildBackupPayload());
  const fresh = loadApp();
  assert.strictEqual(fresh.applyBackupPayload(backup, { confirmFn: () => true }).ok, true);
  const [day] = Object.values(savedDays(fresh));
  assert.strictEqual(day.scoringVersion, 3);
});

test('reports: a negative gaze average is shown and does not inflate other shares', () => {
  const app = loadApp();
  const day = { score: 20, maxScore: 60, salahScore: 20, gazeScore: -10, musicScore: 10, dhikrScore: 0,
    quranScore: 0, fastScore: 0, habitsScore: 0, gaze: 'relapse', scoringVersion: 3 };
  const history = { '2026-06-01': day, '2026-06-02': day };
  const html = app.buildAnalytics(Object.keys(history), history);
  assert.match(html, /Gaze<\/span><strong>-10 pts\/day/, 'the gaze row is shown even with no positive days');
  assert.match(html, /lowers the daily total/);
  assert.match(html, /67% of avg tracked points/, 'Salah 20 of 30 positive points, not 20 of 20');
});

test('gaze chips show signed severity in neutral amber, with the floor note', () => {
  assert.match(INDEX, /compromised:-5,relapse:-10/, 'gaze score map is signed');
  assert.match(INDEX, /color:var\(--amber\)">−5 pts</);
  assert.match(INDEX, /color:var\(--amber\)">−10 pts</);
  assert.ok(!/#ff6b6b">−\s?(5|10) pts/.test(INDEX), 'no red severity chip');
  assert.match(INDEX, /id="gaze-score-note"[^>]*>[^<]*never below 0/);
});
