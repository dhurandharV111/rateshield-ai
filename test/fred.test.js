'use strict';
// Unit tests for the pure helpers in api/fred.js (no network).
const test = require('node:test');
const assert = require('node:assert/strict');

let fred;
test('api/fred.js loads as an ES module with pure helpers', async () => {
  fred = await import('../api/fred.js');
  assert.equal(typeof fred.default, 'function');
  assert.equal(typeof fred.buildSnapshot, 'function');
});

test('latestValue skips FRED "." placeholders', () => {
  const r = fred.latestValue([{ date: '2026-08-15', value: '.' }, { date: '2026-08-14', value: '4.21' }]);
  assert.deepEqual(r, { value: 4.21, date: '2026-08-14' });
  assert.equal(fred.latestValue([{ date: 'x', value: '.' }]), null);
});

test('yoyPct computes year-over-year % from an index series (newest first)', () => {
  const obs = [];
  for (let i = 0; i < 14; i++) obs.push({ date: `2026-${String(12 - i).padStart(2, '0')}-01`, value: String(100 * Math.pow(1.03, (13 - i) / 12)) });
  const r = fred.yoyPct(obs, 12);
  assert.ok(Math.abs(r.value - 3) < 1e-9, 'a 3%/yr index should read 3.0%');
  assert.equal(fred.yoyPct(obs.slice(0, 5), 12), null);
});

test('buildSnapshot produces the fields the app applies, rounded to 2dp', () => {
  const idx = (n, per, growth) => Array.from({ length: n }, (_, i) => ({ date: `2026-${String(((24 - i) % 12) + 1).padStart(2, '0')}-01`, value: String(100 * Math.pow(1 + growth, (n - 1 - i) / per)) }));
  const snap = fred.buildSnapshot({
    FEDFUNDS: [{ date: '2026-08-01', value: '3.64' }],
    UNRATE: [{ date: '2026-08-01', value: '4.3' }],
    DGS10: [{ date: '2026-09-11', value: '.' }, { date: '2026-09-10', value: '4.05' }],
    CPIAUCSL: idx(14, 12, 0.029),
    PCEPILFE: idx(14, 12, 0.026),
    GDP: idx(6, 4, 0.045)
  });
  assert.equal(snap.fedFunds, 3.64);
  assert.equal(snap.unemployment, 4.3);
  assert.equal(snap.treasury10y, 4.05);
  assert.equal(snap.cpi, 2.9);
  assert.equal(snap.corePce, 2.6);
  assert.equal(snap.gdpGrowth, 4.5);
  assert.equal(snap.asOf, 'August 2026');
  assert.equal(fred.buildSnapshot({}).fedFunds, null);
});
