'use strict';
// Directional backtest of the rate forecast against the historical episodes in
// CONFIG.analog.years. Prints the per-episode table and the hit rate.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadModel } = require('./helpers/loadModel');

const { CONFIG, Model } = loadModel();

test('every historical episode carries a December Fed funds level and the realised 12-month change', () => {
  assert.ok(CONFIG.analog.years.length >= 13);
  CONFIG.analog.years.forEach((y) => {
    assert.equal(typeof y.fedFunds, 'number', `${y.year} fedFunds`);
    assert.ok(y.fedFunds >= 0 && y.fedFunds <= 20, `${y.year} fedFunds plausible`);
    assert.equal(typeof y.actualChange12m, 'number', `${y.year} actualChange12m`);
    assert.ok(Math.abs(y.actualChange12m) <= 6, `${y.year} 12-month move plausible`);
  });
});

test('backtest: direction hit rate is reported for all episodes', () => {
  const bt = Model.backtest();
  assert.equal(bt.total, CONFIG.analog.years.length);
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
