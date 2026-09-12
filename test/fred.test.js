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

test('series map: the exact FRED ids and units requested', () => {
  const S = fred.SERIES;
  assert.deepEqual([S.fedFunds.id, S.fedFunds.units], ['FEDFUNDS', 'lin']);
  assert.deepEqual([S.cpi.id, S.cpi.units], ['CPIAUCSL', 'pc1'], 'CPI is CPIAUCSL year-over-year % (units=pc1)');
  assert.deepEqual([S.corePce.id, S.corePce.units], ['PCEPILFE', 'pc1'], 'Core PCE is PCEPILFE year-over-year % (units=pc1)');
  assert.deepEqual([S.unemployment.id, S.unemployment.units], ['UNRATE', 'lin']);
  assert.deepEqual([S.gdpGrowth.id, S.gdpGrowth.units], ['A191RL1Q225SBEA', 'lin'], 'real GDP % change SAAR, used directly');
  assert.deepEqual([S.treasury10y.id, S.treasury10y.units], ['DGS10', 'lin']);
  assert.ok(!Object.values(S).some((s) => s.id === 'GDP'), 'nominal GDP level series is no longer used');
  assert.ok(fred.seriesUrl(S.cpi, 'KEY').includes('series_id=CPIAUCSL&units=pc1&'));
  assert.ok(fred.seriesUrl(S.gdpGrowth, 'KEY').includes('series_id=A191RL1Q225SBEA&units=lin&'));
});

test('latestValue skips FRED "." placeholders', () => {
  const r = fred.latestValue([{ date: '2026-08-15', value: '.' }, { date: '2026-08-14', value: '4.21' }]);
  assert.deepEqual(r, { value: 4.21, date: '2026-08-14' });
  assert.equal(fred.latestValue([{ date: 'x', value: '.' }]), null);
  assert.equal(fred.latestValue(undefined), null);
});

const fixture = (over) => Object.assign({
  FEDFUNDS: [{ date: '2026-08-01', value: '3.64' }],
  CPIAUCSL: [{ date: '2026-08-01', value: '2.9' }],
  PCEPILFE: [{ date: '2026-07-01', value: '2.6' }],
  UNRATE: [{ date: '2026-08-01', value: '4.3' }],
  A191RL1Q225SBEA: [{ date: '2026-04-01', value: '2.4' }],
  DGS10: [{ date: '2026-09-11', value: '.' }, { date: '2026-09-10', value: '4.05' }]
}, over);

test('buildSnapshot passes each latest value through directly (no % change computed) and rounds to 2dp', () => {
  const snap = fred.buildSnapshot(fixture());
  assert.equal(snap.fedFunds, 3.64);
  assert.equal(snap.cpi, 2.9);
  assert.equal(snap.corePce, 2.6);
  assert.equal(snap.unemployment, 4.3);
  assert.equal(snap.gdpGrowth, 2.4, 'A191RL1Q225SBEA value used as reported');
  assert.equal(snap.treasury10y, 4.05);
  assert.equal(snap.asOf, 'August 2026');
  assert.equal(snap.dates.A191RL1Q225SBEA, '2026-04-01');
  assert.deepEqual(snap.warnings, []);
  assert.equal(fred.buildSnapshot({}).fedFunds, null);
  assert.equal(fred.buildSnapshot(fixture({ A191RL1Q225SBEA: [{ date: '2026-04-01', value: '2.456' }] })).gdpGrowth, 2.46);
});

test('sanity bound: GDP growth above 8% or below −10% is rejected (nulled with a warning)', () => {
  assert.deepEqual(fred.SANITY.gdpGrowth, [-10, 8]);
  const nominalLike = fred.buildSnapshot(fixture({ A191RL1Q225SBEA: [{ date: '2026-04-01', value: '8.01' }] }));
  assert.equal(nominalLike.gdpGrowth, null, '8.01% must not pass');
  assert.ok(nominalLike.warnings.some((w) => w.includes('A191RL1Q225SBEA') && w.includes('sanity bound')));
  const crash = fred.buildSnapshot(fixture({ A191RL1Q225SBEA: [{ date: '2026-04-01', value: '-10.5' }] }));
  assert.equal(crash.gdpGrowth, null, '−10.5% must not pass');
  const edgeHi = fred.buildSnapshot(fixture({ A191RL1Q225SBEA: [{ date: '2026-04-01', value: '8' }] }));
  assert.equal(edgeHi.gdpGrowth, 8, 'exactly 8% is allowed');
  const edgeLo = fred.buildSnapshot(fixture({ A191RL1Q225SBEA: [{ date: '2026-04-01', value: '-10' }] }));
  assert.equal(edgeLo.gdpGrowth, -10, 'exactly −10% is allowed');
  // the other series get their own bounds too
  assert.equal(fred.buildSnapshot(fixture({ FEDFUNDS: [{ date: '2026-08-01', value: '40' }] })).fedFunds, null);
});
