// Report correctness (R-1..R-4). Reports derive section points from each day's
// stored inputs under its own scoring version, count "recorded days" by what
// was filled in (not by points), and handle a negative gaze average without
// hiding it, inflating other shares, or producing a negative percentage.
// All fixtures are synthetic.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadApp, makeStorage, plain } = require('./harness.js');

// A day as it arrives from the cloud: real inputs, per-section score fields zeroed.
const pulled = (app, date, extra = {}) => plain(app._rowToLocalPayload({
  record_date: date, score: 60, max_score: 73, scoring_version: null, saved_at: `${date}T18:00:00Z`,
  fardh_salah: { Fajr: 1, Dhuhr: 1, Asr: 3, Maghrib: 1, Isha: 1 }, nafl_salah: { tahajjud: true, ishraq: true, chast: false, extraNafl: [] },
  khushu: { value: 'medium' }, gaze: { value: 'success', trigger: '' }, music_free: true,
  dhikr: [{ count: 1000 }, { count: 700 }], quran: { done: true, onepage: true, kahf: false, nightly: true, mins: '15', pages: '2' },
  fasting: { done: false }, habits: { count: 0, mins: 0, names: [] }, custom_sections: {}, reflection: {}, is_hayd_mode: false, ...extra }));
const month = (app, n, f) => { const h = {}; for (let i = 1; i <= n; i++) { const d = `2026-06-${String(i).padStart(2, '0')}`; h[d] = pulled(app, d, f ? f(i) : {}); } return h; };
const report = (app, h) => app.buildAnalytics(Object.keys(h), h);
// Rows of both per-section blocks, keyed by section name.
const perfRows = (html) => Object.fromEntries([...html.matchAll(/<div class="breakdown-name">([^<]+)<\/div><div class="breakdown-meta">([^<]+)<\/div><\/div><div class="breakdown-bar-wrap"><div class="breakdown-bar-fill" style="width:([^%]+)%[^"]*"><\/div><\/div><div class="breakdown-pct">([^<]+)<\/div>/g)]
  .map(m => [m[1], { meta: m[2], width: m[3], pct: m[4] }]));
const contribRows = (html) => Object.fromEntries([...html.matchAll(/<div class="contribution-top"><span>([^<]+)<\/span><strong>([^<]+)<\/strong><\/div><div class="contribution-track"><div class="contribution-fill" style="width:([^%]+)%"><\/div><\/div><div class="contribution-meta"><span>([^<]+)<\/span><span>([^<]+)<\/span>/g)]
  .map(m => [m[1], { perDay: m[2], width: m[3], recorded: m[4], share: m[5] }]));

test('recorded days count sections that were filled in, not sections that scored points', () => {
  const app = loadApp();
  const h = month(app, 3, () => ({ gaze: { value: 'compromised', trigger: '' }, music_free: false }));
  const html = report(app, h);
  const perf = perfRows(html), contrib = contribRows(html);
  for (const name of ['Salah', 'Gaze', 'Dhikr', 'Quran']) {
    assert.match(perf[name].meta, /• 3\/3 recorded days/, `Section Performance: ${name}`);
    assert.strictEqual(contrib[name].recorded, '3/3 recorded days', `Where your points come from: ${name}`);
  }
  assert.ok(!('Music-Free' in perf) && !('Music-Free' in contrib), 'never music-free, no points: no row');
});

test('days pulled from the cloud report their real section points', () => {
  const app = loadApp();
  const contrib = contribRows(report(app, month(app, 2)));
  assert.strictEqual(contrib.Salah.perDay, '10 pts/day');      // 1+1+3+1+1 + tahajjud 2 + ishraq 1
  assert.strictEqual(contrib.Gaze.perDay, '10 pts/day');
  assert.strictEqual(contrib.Dhikr.perDay, '17 pts/day');      // (1000+700)/100
  assert.strictEqual(contrib.Quran.perDay, '17 pts/day');      // read 10 + one page 5 + nightly 2
  assert.strictEqual(contrib['Music-Free'].perDay, '10 pts/day');
});

test('both per-section blocks agree: same rows, points, recorded days and shares', () => {
  const app = loadApp();
  const html = report(app, month(app, 10, (i) => ({ gaze: { value: i % 3 ? 'success' : 'compromised', trigger: '' }, music_free: i % 2 === 0 })));
  const perf = perfRows(html), contrib = contribRows(html);
  assert.deepStrictEqual(Object.keys(perf), Object.keys(contrib));
  for (const name of Object.keys(perf)) {
    assert.ok(perf[name].meta.startsWith(contrib[name].perDay.replace(' pts/day', '') + ' pts/day'), `${name} pts/day`);
    assert.ok(perf[name].meta.includes(contrib[name].recorded), `${name} recorded days`);
    assert.strictEqual(perf[name].pct, contrib[name].share.replace(' of avg tracked points', ''), `${name} share`);
  }
});

test('a negative gaze average is shown in both blocks, never as a percentage or a donut slice', () => {
  const app = loadApp();
  const charts = [];
  app.setTimeout = (fn) => { fn(); return 0; };
  app.Chart = class { constructor(ctx, cfg) { charts.push(cfg); } destroy() {} };
  app.Chart.defaults = {};
  const html = report(app, month(app, 4, () => ({ gaze: { value: 'relapse', trigger: '' } })));
  const perf = perfRows(html), contrib = contribRows(html);
  assert.match(perf.Gaze.meta, /^-10 pts\/day • 4\/4 recorded days • lowers the daily total$/);
  assert.strictEqual(perf.Gaze.pct, '—');
  assert.strictEqual(perf.Gaze.width, '0');
  assert.strictEqual(contrib.Gaze.share, 'lowers the daily total');
  assert.ok(!/-\d+%/.test(html), 'no negative percentage anywhere');
  const pie = charts.find(c => c.type === 'doughnut');
  assert.ok(pie && !pie.data.labels.includes('Gaze'), 'gaze is not a donut slice');
  assert.ok(pie.data.datasets[0].data.every(v => v > 0));
});

test('donut centre is the average stored daily total', () => {
  const app = loadApp();
  const h = month(app, 2);
  h['2026-06-01'].score = 70; h['2026-06-02'].score = 41;
  assert.match(report(app, h), /<strong>55\.5<\/strong><span>avg pts\/day<\/span>/);
});

test('Salah average, Dhikr-complete days and suggestions use the derived points', () => {
  const storage = makeStorage();
  const app = loadApp({ storage });
  // Strong prayer and dhikr whose stored per-section fields were zeroed by the pull.
  const h = month(app, 14, () => ({ fardh_salah: { Fajr: 3, Dhuhr: 3, Asr: 3, Maghrib: 3, Isha: 3 } }));
  const html = report(app, h);
  assert.match(html, /Avg Salah \/ Day<\/span><strong>18 pts<\/strong>/);   // 15 + tahajjud 2 + ishraq 1
  assert.match(html, /Dhikr Complete<\/span><strong>14 days<\/strong>/);
  storage.setItem('spt_v2', JSON.stringify(h));
  const titles = plain(app.getRecommendationData()).suggestions.map(s => s.title);
  assert.ok(!titles.includes('Bring dhikr back into the day'), 'dhikr reached 17 pts/day');
  assert.ok(!titles.includes('Strengthen the prayer foundation'), 'salah 18 of 19 tracked pts');
});

test('a month like the reported one: 30 pulled days give 30/30 recorded and the real averages', () => {
  const app = loadApp();
  // 23 success / 7 compromised gaze, music-free on 25 days, Kahf on 5.
  const h = month(app, 30, (i) => ({ score: 60, gaze: { value: i <= 23 ? 'success' : 'compromised', trigger: '' },
    music_free: i <= 25, quran: { done: true, onepage: true, kahf: i % 6 === 0, nightly: true, mins: '15', pages: '2' } }));
  const html = report(app, h), perf = perfRows(html);
  for (const name of ['Salah', 'Gaze', 'Dhikr', 'Quran']) assert.match(perf[name].meta, /• 30\/30 recorded days/, name);
  assert.match(perf['Music-Free'].meta, /• 25\/30 recorded days/);
  assert.match(perf.Gaze.meta, /^6\.5 pts\/day/);              // (23*10 - 7*5) / 30
  assert.match(perf.Quran.meta, /^20\.3 pts\/day/);            // 17 + 20*5/30
  assert.match(perf['Music-Free'].meta, /^8\.3 pts\/day/);
});

test('reports and suggestions never write to storage', () => {
  const storage = makeStorage();
  const app = loadApp({ storage });
  const h = month(app, 5);
  storage.setItem('spt_v2', JSON.stringify(h));
  const writes = storage.writes, before = storage.getItem('spt_v2');
  report(app, h);
  app.getRecommendationData();
  assert.strictEqual(storage.writes, writes);
  assert.strictEqual(storage.getItem('spt_v2'), before);
});
