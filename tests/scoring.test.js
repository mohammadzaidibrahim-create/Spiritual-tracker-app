// P0 step 3 — scoring hotfix. Owner decisions P0-05 (a recorded lapse is
// observation, never a deduction; every section total is >= 0) and P0-06
// (legacy scores stay exactly as stored; new saves carry scoringVersion 2).
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
const savedDays = (app) => JSON.parse(app.__storage.getItem('spt_v2') || '{}');

test('a recorded lapse scores 0 — never a deduction', () => {
  const app = loadApp();
  for (const [val, pts] of [['nottracked', 0], ['success', 10], ['compromised', 0], ['relapse', 0]]) {
    pickGaze(app, val);
    assert.strictEqual(app.calcGazeScore(), pts, `gaze "${val}"`);
  }
});

test('a relapse-only day totals 0, not -10', () => {
  const app = loadApp();
  pickGaze(app, 'relapse');
  assert.strictEqual(app.calcTotalScore(), 0);
});

test('section totals never go below zero', () => {
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
  assert.ok(app2.calcTotalScore() >= 0);
});

test('a saved day is stamped scoringVersion 2 and never stores a negative score', () => {
  const app = loadApp();
  pickGaze(app, 'relapse');
  assert.strictEqual(app.saveDay(), true);
  const days = savedDays(app);
  const [key] = Object.keys(days);
  assert.strictEqual(days[key].scoringVersion, 2);
  assert.strictEqual(days[key].score, 0);
  assert.strictEqual(days[key].gazeScore, 0);
  assert.strictEqual(days[key].gaze, 'relapse', 'the observation itself is still recorded');
});

test('cloud row carries scoring_version; a legacy day sends null', () => {
  const app = loadApp();
  // No sign-in flow in the sandbox; set the session the mapper reads.
  vm.runInContext("currentSupabaseUser = { id: 'u-test' }", app);
  assert.strictEqual(app._localPayloadToRow('2026-10-01', { score: 20, scoringVersion: 2 }).scoring_version, 2);
  assert.strictEqual(app._localPayloadToRow('2026-04-01', { score: 50 }).scoring_version, null);
});

test('a pulled row keeps its scoring version; a legacy row stays unlabelled', () => {
  const app = loadApp();
  assert.strictEqual(plain(app._rowToLocalPayload({ scoring_version: 2, score: 20 })).scoringVersion, 2);
  assert.ok(!('scoringVersion' in plain(app._rowToLocalPayload({ scoring_version: null, score: 50 }))));
});

test('legacy history is never rescored by opening it', () => {
  const legacy = JSON.stringify({
    '2026-04-01': { score: -10, maxScore: 60, gaze: 'relapse', gazeScore: -10, savedAt: '2026-04-01T20:00:00.000Z' },
  });
  const app = loadApp({ storage: makeStorage({ spt_v2: legacy }) });
  app.selectActiveDate('2026-04-01');   // opens the day in the tracker
  assert.strictEqual(app.__storage.getItem('spt_v2'), legacy, 'stored legacy day must be byte-identical');
});

test('backup export and restore keep scoringVersion', () => {
  const app = loadApp();
  pickGaze(app, 'success');
  app.saveDay();
  const backup = plain(app.buildBackupPayload());
  const fresh = loadApp();
  assert.strictEqual(fresh.applyBackupPayload(backup, { confirmFn: () => true }).ok, true);
  const [day] = Object.values(savedDays(fresh));
  assert.strictEqual(day.scoringVersion, 2);
});

test('the gaze options no longer advertise deductions', () => {
  assert.ok(!/[−-]\s?(5|10) pts/.test(INDEX), 'a "−5 pts"/"−10 pts" chip is back');
  assert.match(INDEX, /compromised:0,relapse:0/, 'gaze score map must not deduct');
});
