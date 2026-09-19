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
  assert.deepEqual([S.fedFunds.id, S.fedFunds.units], ['DFF', 'lin'], 'current rate is the DAILY effective rate, not the monthly average');
  assert.ok(!Object.values(S).some((s) => s.id === 'FEDFUNDS'), 'nothing else needs the monthly FEDFUNDS series');
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
  DFF: [{ date: '2026-08-14', value: '3.64' }],
  CPIAUCSL: [{ date: '2026-08-01', value: '2.9' }],
  PCEPILFE: [{ date: '2026-07-01', value: '2.6' }],
  UNRATE: [{ date: '2026-08-01', value: '4.3' }],
  A191RL1Q225SBEA: [{ date: '2026-04-01', value: '2.4' }],
  DGS10: [{ date: '2026-09-11', value: '.' }, { date: '2026-09-10', value: '4.05' }]
}, over);

test('buildSnapshot passes each latest value through directly (no % change computed) and rounds to 2dp', () => {
  const snap = fred.buildSnapshot(fixture(), '2026-08-15'); // "now" pinned a day after the fixture's DFF date
  assert.equal(snap.fedFunds, 3.64);
  assert.equal(snap.cpi, 2.9);
  assert.equal(snap.corePce, 2.6);
  assert.equal(snap.unemployment, 4.3);
  assert.equal(snap.gdpGrowth, 2.4, 'A191RL1Q225SBEA value used as reported');
  assert.equal(snap.treasury10y, 4.05);
  assert.equal(snap.asOf, '2026-08-14', 'as-of is the exact DFF observation date');
  assert.equal(snap.fedFundsDate, '2026-08-14');
  assert.equal(snap.dates.A191RL1Q225SBEA, '2026-04-01');
  assert.deepEqual(snap.warnings, []);
  assert.equal(fred.buildSnapshot({}).fedFunds, null);
  assert.equal(fred.buildSnapshot(fixture({ A191RL1Q225SBEA: [{ date: '2026-04-01', value: '2.456' }] })).gdpGrowth, 2.46);
});

test('snapshot echoes the raw FRED observations per series so values can be traced', () => {
  const snap = fred.buildSnapshot(fixture());
  assert.equal(snap.raw.corePce.series, 'PCEPILFE');
  assert.equal(snap.raw.corePce.units, 'pc1');
  assert.deepEqual(snap.raw.corePce.observations, [{ date: '2026-07-01', value: '2.6' }]);
  assert.equal(snap.raw.cpi.series, 'CPIAUCSL');
  assert.equal(snap.raw.cpi.units, 'pc1');
  assert.equal(snap.raw.gdpGrowth.series, 'A191RL1Q225SBEA');
  assert.equal(snap.raw.treasury10y.observations.length, 2);
});

test('cross-check: core PCE more than 1 pt above headline CPI is flagged, not dropped', () => {
  const ok = fred.buildSnapshot(fixture({ PCEPILFE: [{ date: '2026-07-01', value: '3.34' }], CPIAUCSL: [{ date: '2026-08-01', value: '3.35' }] }));
  assert.equal(ok.corePce, 3.34);
  assert.ok(!ok.warnings.some((w) => w.includes('exceeds CPIAUCSL')), 'within 1 pt → no flag');
  const odd = fred.buildSnapshot(fixture({ PCEPILFE: [{ date: '2026-07-01', value: '3.34' }], CPIAUCSL: [{ date: '2026-08-01', value: '2.0' }] }));
  assert.equal(odd.corePce, 3.34, 'value is kept');
  assert.ok(odd.warnings.some((w) => w.includes('PCEPILFE') && w.includes('exceeds CPIAUCSL')), 'flagged for investigation');
  assert.equal(fred.CORE_PCE_VS_CPI_MAX_GAP, 1.0);
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
  assert.equal(fred.buildSnapshot(fixture({ DFF: [{ date: '2026-08-14', value: '40' }] })).fedFunds, null);
});

test('market-expectation series: DGS6MO and DGS2 are fetched and passed through', () => {
  const S = fred.SERIES;
  assert.deepEqual([S.treasury6mo.id, S.treasury6mo.units], ['DGS6MO', 'lin']);
  assert.deepEqual([S.treasury2y.id, S.treasury2y.units], ['DGS2', 'lin']);
  const snap = fred.buildSnapshot(fixture({ DGS6MO: [{ date: '2026-09-11', value: '.' }, { date: '2026-09-10', value: '3.91' }], DGS2: [{ date: '2026-09-10', value: '3.52' }] }));
  assert.equal(snap.treasury6mo, 3.91);
  assert.equal(snap.treasury2y, 3.52);
  assert.equal(snap.raw.treasury6mo.series, 'DGS6MO');
  assert.equal(fred.buildSnapshot(fixture()).treasury6mo, null, 'missing series → null, app keeps its snapshot');
  assert.deepEqual(fred.SANITY.treasury6mo, [0, 25]);
});

test('momentum: the snapshot carries PCEPILFE and DGS10 values from 3 months earlier, read from the observation window', () => {
  assert.equal(fred.shiftMonths('2026-07-01', 3), '2026-04-01');
  assert.equal(fred.shiftMonths('2026-03-31', 1), '2026-02-28', 'day clamped to the shorter month');
  assert.equal(fred.shiftMonths('2026-01-15', 3), '2025-10-15', 'crosses the year boundary');
  const monthly = [
    { date: '2026-07-01', value: '3.34' }, { date: '2026-06-01', value: '3.2' }, { date: '2026-05-01', value: '3.1' },
    { date: '2026-04-01', value: '3.0' }, { date: '2026-03-01', value: '2.9' }
  ];
  assert.deepEqual(fred.valueMonthsAgo(monthly, '2026-07-01', 3), { value: 3.0, date: '2026-04-01' });
  const daily = [
    { date: '2026-09-11', value: '4.95' }, { date: '2026-09-10', value: '4.9' }, { date: '2026-06-12', value: '.' },
    { date: '2026-06-11', value: '4.40' }, { date: '2026-06-10', value: '4.38' }
  ];
  assert.deepEqual(fred.valueMonthsAgo(daily, '2026-09-11', 3), { value: 4.40, date: '2026-06-11' }, 'first numeric observation on or before the target date');
  assert.equal(fred.valueMonthsAgo(monthly.slice(0, 2), '2026-07-01', 3), null, 'window too short → null, never interpolated');
  const cpiMonthly = [
    { date: '2026-08-01', value: '3.4' }, { date: '2026-07-01', value: '3.3' }, { date: '2026-06-01', value: '3.1' },
    { date: '2026-05-01', value: '3.0' }, { date: '2026-04-01', value: '2.9' }
  ];
  const snap = fred.buildSnapshot(fixture({ PCEPILFE: monthly, DGS10: daily, CPIAUCSL: cpiMonthly }));
  assert.equal(snap.cpi, 3.4);
  assert.equal(snap.cpi3moAgo, 3.0, 'headline CPI three months before the latest observation');
  assert.equal(snap.dates.CPIAUCSL_3mo, '2026-05-01');
  assert.ok(fred.SERIES.cpi.limit >= 4);
  assert.equal(fred.buildSnapshot(fixture()).cpi3moAgo, null);
  assert.equal(snap.corePce, 3.34);
  assert.equal(snap.corePce3moAgo, 3.0);
  assert.equal(snap.dates.PCEPILFE_3mo, '2026-04-01');
  assert.equal(snap.treasury10y, 4.95);
  assert.equal(snap.treasury10y3moAgo, 4.4);
  assert.equal(snap.dates.DGS10_3mo, '2026-06-11');
  assert.ok(snap.notes.corePce3moAgo.includes('3 months'));
  const short = fred.buildSnapshot(fixture());
  assert.equal(short.corePce3moAgo, null, 'default fixture has one observation → null');
  assert.equal(short.treasury10y3moAgo, null);
  assert.ok(fred.SERIES.corePce.limit >= 4 && fred.SERIES.treasury10y.limit >= 70, 'windows are long enough to reach 3 months back');
});

test('current rate comes from DFF and its observation date is within 7 days of today when the fetch succeeds', () => {
  const today = new Date().toISOString().slice(0, 10);
  const twoDaysAgo = fred.shiftMonths(today, 0) && new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
  const fresh = fred.buildSnapshot(fixture({ DFF: [{ date: today, value: '.' }, { date: twoDaysAgo, value: '3.88' }] }));
  assert.equal(fresh.fedFunds, 3.88);
  assert.equal(fresh.fedFundsDate, twoDaysAgo);
  assert.equal(fresh.asOf, twoDaysAgo);
  assert.equal(fresh.raw.fedFunds.series, 'DFF');
  assert.ok(fresh.fedFundsAgeDays >= 0 && fresh.fedFundsAgeDays <= 7, `age ${fresh.fedFundsAgeDays} days`);
  assert.ok(!fresh.warnings.some((w) => w.includes('stale')));
  // a monthly-average-style date (weeks old) is flagged as stale
  const stale = fred.buildSnapshot(fixture({ DFF: [{ date: '2026-08-01', value: '3.64' }] }), '2026-09-18');
  assert.equal(stale.fedFundsAgeDays, 48);
  assert.ok(stale.warnings.some((w) => w.includes('DFF observation 2026-08-01') && w.includes('stale')));
  assert.equal(stale.fedFunds, 3.64, 'value is kept, only flagged');
  assert.equal(fred.daysBetween('2026-09-11', '2026-09-18'), 7);
  assert.equal(fred.STALE_DAYS, 7);
});
