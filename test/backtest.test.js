'use strict';
// Directional backtest of the rate forecast against the historical episodes in
// CONFIG.analog.years. Prints the per-episode table and the hit rate.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadModel } = require('./helpers/loadModel');

const { CONFIG, Model } = loadModel();

test('every episode carries a Fed funds level and either the realised 12-month change or a next-meeting outcome', () => {
  assert.ok(CONFIG.analog.years.length >= 14);
  CONFIG.analog.years.forEach((y) => {
    assert.equal(typeof y.fedFunds, 'number', `${y.year} fedFunds`);
    assert.ok(y.fedFunds >= 0 && y.fedFunds <= 20, `${y.year} fedFunds plausible`);
    const has12 = typeof y.actualChange12m === 'number', hasNext = typeof y.actualNextMeeting === 'number';
    assert.ok(has12 || hasNext, `${y.year} needs an outcome to be scored on`);
    if (has12) assert.ok(Math.abs(y.actualChange12m) <= 6, `${y.year} 12-month move plausible`);
    if (hasNext) assert.ok(Math.abs(y.actualNextMeeting) <= 1, `${y.year} single-meeting move plausible`);
  });
  assert.equal(Model.historicalEpisodes().length, 13, '13 episodes with a realised 12-month outcome');
  const y2026 = CONFIG.analog.years.find((y) => y.year === 2026);
  assert.ok(y2026, 'September 2026 episode present');
  assert.equal(y2026.label, 'Energy-driven re-acceleration');
  assert.deepEqual([y2026.cpi, y2026.un, y2026.tr, y2026.gdp, y2026.pce, y2026.fedFunds], [3.4, 4.1, 4.95, 1.5, 3.3, 3.63]);
  assert.equal(y2026.actualChange12m, null);
  assert.equal(y2026.actualNextMeeting, 0.25);
  assert.equal(y2026.source, 'FOMC statement 2026-09-16');
});

test('backtest: direction hit rate is reported for all episodes', () => {
  const bt = Model.backtest();
  assert.equal(bt.total, Model.historicalEpisodes().length);
  assert.ok(bt.hits >= 0 && bt.hits <= bt.total);
  assert.ok(Math.abs(bt.hitRate - bt.hits / bt.total) < 1e-12);
  bt.rows.forEach((r) => {
    assert.ok(['up', 'down', 'hold'].includes(r.predictedDir));
    assert.ok(['up', 'down', 'hold'].includes(r.actualDir));
    assert.equal(r.hit, r.predictedDir === r.actualDir);
    assert.ok(isFinite(r.predicted) && isFinite(r.predictedChange));
  });

  const pad = (s, n) => String(s).padEnd(n);
  console.log('\n  Rate-forecast direction backtest (predicted 12-month move vs realised FEDFUNDS move, ±' + CONFIG.analog.backtestDeadZone + ' = hold)');
  console.log('  ' + pad('year', 6) + pad('episode', 34) + pad('fed Dec', 9) + pad('pred 12m', 10) + pad('pred Δ', 9) + pad('actual Δ', 10) + pad('pred', 6) + pad('actual', 8) + 'hit');
  bt.rows.forEach((r) => {
    console.log('  ' + pad(r.year, 6) + pad(r.label, 34) + pad(r.current.toFixed(2), 9) + pad(r.predicted.toFixed(2), 10) +
      pad((r.predictedChange >= 0 ? '+' : '') + r.predictedChange.toFixed(2), 9) + pad((r.actualChange12m >= 0 ? '+' : '') + r.actualChange12m.toFixed(2), 10) +
      pad(r.predictedDir, 6) + pad(r.actualDir, 8) + (r.hit ? '✓' : '✗'));
  });
  console.log('  Hit rate: ' + bt.hits + ' of ' + bt.total + ' (' + Math.round(bt.hitRate * 100) + '%)\n');

  // Same episodes with the momentum term switched off, so the two hit rates can be compared.
  const off = Model.backtest({ momentum: false });
  const F = CONFIG.forecast;
  console.log('  Momentum terms ON  (cpi ×' + F.cpi.momentumWeight + ', pce ×' + F.pce.momentumWeight + ', 10Y ×' + F.tr.momentumWeight + ', clamp ±' + F.momentumClamp + '): ' + bt.hits + ' of ' + bt.total + ' (' + Math.round(bt.hitRate * 100) + '%)');
  console.log('  Momentum terms OFF: ' + off.hits + ' of ' + off.total + ' (' + Math.round(off.hitRate * 100) + '%)');
  const changed = bt.rows.filter((r) => { const o = off.rows.find((x) => x.year === r.year); return o && o.hit !== r.hit; });
  console.log('  Episodes whose verdict momentum changes: ' + (changed.length ? changed.map((r) => r.year + ' (' + (r.hit ? 'gained' : 'lost') + ')').join(', ') : 'none') + '\n');
  assert.equal(off.total, bt.total);
  assert.ok(bt.hits >= off.hits - 1, 'momentum may cost at most one historical episode');

  // Next-meeting scoreboard (episodes without a 12-month outcome yet).
  const nm = bt.nextMeeting, nmOff = off.nextMeeting;
  console.log('  Next-meeting calls (model\'s most likely FOMC outcome vs the actual decision):');
  console.log('  ' + pad('year', 6) + pad('episode', 34) + pad('fed now', 9) + pad('pred 12m', 10) + pad('hike/hold/cut', 16) + pad('pred', 6) + pad('actual', 8) + 'hit');
  nm.rows.forEach((r) => {
    const o = nmOff.rows.find((x) => x.year === r.year);
    console.log('  ' + pad(r.year, 6) + pad(r.label, 34) + pad(r.current.toFixed(2), 9) + pad(r.predicted.toFixed(2), 10) +
      pad(r.probs.hike + '/' + r.probs.hold + '/' + r.probs.cut, 16) + pad(r.predictedDir, 6) + pad(r.actualDir + ' (' + (r.actualNextMeeting >= 0 ? '+' : '') + r.actualNextMeeting + ')', 12) + (r.hit ? '✓' : '✗') +
      '   momentum OFF: pred 12m ' + o.predicted.toFixed(2) + ' → ' + o.predictedDir + ' ' + (o.hit ? '✓' : '✗'));
  });
  console.log('  Next-meeting calls: ' + nm.hits + ' of ' + nm.total + ' with momentum ON · ' + nmOff.hits + ' of ' + nmOff.total + ' with momentum OFF');
  // What it would take: score needed for the model's most likely outcome to be a hike from today's level.
  const y2026 = CONFIG.analog.years.find((y) => y.year === 2026);
  if (y2026) {
    const baseScore = Model.rateSignalScore(y2026, { momentum: false });
    let needed = null;
    for (let extra = 0; extra <= 6; extra = Math.round((extra + 0.05) * 100) / 100) {
      const p = Model.fomcProbabilities(Model.predictedRate(baseScore + extra), y2026.fedFunds);
      if (Model.fomcDirection(p) === 'hike') { needed = extra; break; }
    }
    const c26 = Model.rateSignalContributions(y2026);
    console.log('  2026 momentum contributions: CPI ' + c26.cpiMom.toFixed(2) + ' · core PCE ' + c26.pceMom.toFixed(2) + ' · 10Y ' + c26.trMom.toFixed(2));
    console.log('  2026: score without momentum ' + baseScore.toFixed(2) + ', momentum contribution ' +
      (Model.rateSignalScore(y2026) - baseScore).toFixed(2) + ' (cpiMom3m ' + y2026.cpiMom3m + ', pceMom3m ' + y2026.pceMom3m + ', trMom3m ' + y2026.trMom3m + ', ' + y2026.momentumSource + ')' +
      '; extra score needed for a "hike" call: ' + (needed === null ? '> 6' : '+' + needed.toFixed(2)) + ' (momentum is capped at +3.0 in total)\n');
  }
  const withStance = CONFIG.analog.years.filter((y) => typeof y.fedStance === 'number');
  console.log('  Fed stance term: ' + (withStance.length ? withStance.length + ' episodes carry fedStance' : 'no episode carries fedStance yet (all null → contributes 0)') + '\n');
  assert.equal(nm.total, CONFIG.analog.years.filter((y) => typeof y.actualNextMeeting === 'number').length);
  nm.rows.forEach((r) => {
    assert.ok(['up', 'down', 'hold'].includes(r.predictedDir) && ['up', 'down', 'hold'].includes(r.actualDir));
    assert.equal(r.hit, r.predictedDir === r.actualDir);
    assert.equal(r.probs.hike + r.probs.hold + r.probs.cut, 100);
  });
  const r2026 = nm.rows.find((r) => r.year === 2026);
  assert.equal(r2026.actualDir, 'up', '+25 bp on 2026-09-16 is a hike');

  // Regression floor: the model must at least beat a coin flip on direction.
  assert.ok(bt.hitRate >= 0.5, `hit rate ${bt.hitRate} below 50%`);
});

test('backtest: a known episode is scored the way the rule says', () => {
  const bt = Model.backtest();
  const y2000 = bt.rows.find((r) => r.year === 2000);
  assert.equal(y2000.actualDir, 'down'); // 6.40 → 1.82 over 2001
  assert.equal(y2000.predictedDir, 'down');
  assert.equal(y2000.hit, true);
  const y2009 = bt.rows.find((r) => r.year === 2009);
  assert.equal(y2009.actualDir, 'hold'); // +0.06 within the dead zone
});

test('every episode carries a fedStance slot (null until filled from the FOMC statement archives) and the backtest honours it when set', () => {
  CONFIG.analog.years.forEach((y) => assert.ok('fedStance' in y, `${y.year} has fedStance`));
  const saved = CONFIG.analog.years;
  // give 2022 a hawkish stance: the December 2022 predicted level rises, so a populated field changes the verdict path
  CONFIG.analog.years = saved.map((y) => (y.year === 2022 ? Object.assign({}, y, { fedStance: 2 }) : y));
  const withStance = Model.backtest().rows.find((r) => r.year === 2022);
  CONFIG.analog.years = saved;
  const without = Model.backtest().rows.find((r) => r.year === 2022);
  assert.ok(withStance.predicted > without.predicted, 'a +2 stance lifts the predicted level (+1.5 score → +0.6 pts)');
});
