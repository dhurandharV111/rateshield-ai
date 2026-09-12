'use strict';
// Headless QA harness: boots the real app in jsdom for every sector, checks for
// JS errors and NaN/undefined/Infinity in the rendered page, perturbs every input,
// verifies charts move, and asserts that every surface quoting safe hires, runway
// and AI savings agrees with the others (they all call the same Model functions).
const test = require('node:test');
const assert = require('node:assert/strict');
const { SECTORS, boot, setVal, txt } = require('./helpers/loadApp');
const { badValues } = require('./helpers/loadApp');

const INPUT_IDS = [
  'f-cpi', 'f-un', 'f-tr', 'f-gdp', 'f-pce',
  'sl-rev-h', 'sl-head', 'sl-sal', 'sl-hire', 'sl-debt', 'sl-cash', 'sl-margin-h',
  'sl-rev-ai', 'sl-margin', 'sl-labour', 'sl-rawmat', 'sl-fixed',
  'cd-cash', 'cd-opex', 'cd-buffer', 'cd-checking', 'cd-mmf', 'cd-tbill', 'cd-cd',
  'fed-slider', 'sl-debt-fixed-pct', 'sl-debt-fixed-rate', 'sl-debt-term',
  'sl-eq-price', 'sl-eq-output', 'sl-eq-vc', 'sl-eq-fc', 'sl-eq-elas'
];
const OUTPUT_IDS = ['pred-rate', 'sec-impact-text', 'hiring-result', 'ai-result', 'lr-total', 'lr-annual', 'lr-exposed', 'lr-amort',
  'eq-kpis', 'eq-rec', 'ceo-content', 'hm-score', 'hm-liq', 'hm-ai', 'cd-idle', 'cd-current', 'cd-optimized', 'cd-gap', 'cd-t1-amt', 'cd-t2-amt', 'cd-t3-amt'];

function snapshot(window) {
  const s = {};
  OUTPUT_IDS.forEach((id) => { s[id] = txt(window, id); });
  return s;
}

test('every sector boots with zero JS errors and no NaN/undefined/Infinity on screen', () => {
  SECTORS.forEach((sector) => {
    const { window, errors } = boot(sector);
    window.runScenario('base');
    assert.deepEqual(errors, [], sector + ' errors');
    assert.deepEqual(badValues(window, sector), [], sector + ' bad values');
  });
});

test('every input moves at least one visible output (each from a fresh baseline)', () => {
  INPUT_IDS.forEach((id) => {
    const { window, errors } = boot('manufacturing');
    const el = window.document.getElementById(id);
    assert.ok(el, 'missing input #' + id);
    const before = snapshot(window);
    const cur = parseFloat(el.value) || 0;
    const bump = id === 'sl-debt-fixed-pct' ? Math.min(100, cur + 30) : cur !== 0 ? cur * 1.5 + 1 : 5;
    setVal(window, id, bump);
    const after = snapshot(window);
    assert.ok(OUTPUT_IDS.some((k) => before[k] !== after[k]), `#${id} changed no output`);
    assert.deepEqual(errors, [], id + ' errors');
  });
});

test('charts update when their governing inputs change', () => {
  const { window } = boot('manufacturing');
  const snap = () => ({
    f: JSON.stringify(window.fChart.data.datasets.map((d) => d.data)),
    h: JSON.stringify(window.hChart.data.datasets.map((d) => d.data)),
    ai: JSON.stringify(window.aiChart.data.datasets.map((d) => d.data)),
    l: JSON.stringify(window.lChart.data.datasets.map((d) => d.data))
  });
  const before = snap();
  setVal(window, 'f-cpi', '8');
  setVal(window, 'sl-hire', '40');
  setVal(window, 'sl-labour', '55');
  setVal(window, 'sl-debt', '9');
  const after = snap();
  assert.notEqual(before.f, after.f, 'fChart');
  assert.notEqual(before.h, after.h, 'hChart');
  assert.notEqual(before.ai, after.ai, 'aiChart');
  assert.notEqual(before.l, after.l, 'lChart');
});

test('initCharts isolates a failing canvas so the other charts still initialise', () => {
  const { window } = boot('manufacturing');
  window.document.getElementById('lChart').getContext = () => { throw new Error('simulated canvas failure'); };
  ['fChart', 'hChart', 'aiChart', 'lChart', 'eqChart', 'profChart', 'eqBasicChart', 'eqScChart'].forEach((k) => { window[k] = null; });
  assert.doesNotThrow(() => window.initCharts());
  assert.ok(window.fChart && window.hChart && window.aiChart);
  assert.equal(window.lChart, null);
});

test('Workforce, Executive Health, CEO Summary and Scenario Simulator quote identical safe hires, runway and AI savings', () => {
  SECTORS.forEach((sector) => {
    const { window } = boot(sector);
    // non-default inputs so agreement is not an accident of defaults
    setVal(window, 'sl-hire', '23');
    setVal(window, 'sl-cash', '0.9');
    setVal(window, 'sl-margin', '7');
    setVal(window, 'sl-labour', '41');
    window.runScenario('base');
    window.updateAll();
    const M = window.RS_METRICS;
    assert.ok(M.workforce && M.ceo && M.simulator && M.health && M.ai, sector + ' metrics recorded');
    assert.equal(M.ceo.safeHires, M.workforce.safeHires, sector + ' safe hires CEO vs Workforce');
    assert.equal(M.simulator.safeHires, M.workforce.safeHires, sector + ' safe hires Simulator vs Workforce');
    assert.equal(M.ceo.runwayMonths, M.workforce.runwayMonths, sector + ' runway CEO vs Workforce');
    assert.equal(M.simulator.runwayMonths, M.workforce.runwayMonths, sector + ' runway Simulator vs Workforce');
    assert.equal(M.health.runwayMonths, M.workforce.runwayMonths, sector + ' runway Health vs Workforce');
    assert.ok(Math.abs(M.ceo.aiSavingsM - M.ai.aiSavingsM) < 1e-9, sector + ' AI savings CEO vs AI module');
    assert.ok(Math.abs(M.simulator.aiSavingsM - M.ai.aiSavingsM) < 1e-9, sector + ' AI savings Simulator vs AI module');
    assert.ok(Math.abs(M.health.aiSavingsM - M.ai.aiSavingsM) < 1e-9, sector + ' AI savings Health vs AI module');
    // and the rendered text agrees with the recorded numbers
    assert.ok(txt(window, 'hiring-result').includes('Hire ' + M.workforce.safeHires + ' of'), sector + ' hiring text');
    assert.ok(txt(window, 'sm-hire').startsWith(M.simulator.safeHires + ' '), sector + ' simulator text');
  });
});

test('runway is net-burn based: profitable business shows "Cash-flow positive" plus payroll coverage; loss year shows months', () => {
  const { window, errors } = boot('manufacturing');
  setVal(window, 'sl-margin-h', '9');
  const hr = txt(window, 'hiring-result');
  assert.ok(hr.includes('Cash-flow positive'), 'workforce module shows cash-flow positive');
  assert.ok(/Payroll coverage: [\d.]+ months/.test(hr), 'workforce module shows payroll coverage');
  assert.equal(txt(window, 'hm-liq'), 'CF positive');
  assert.ok(txt(window, 'ceo-content').includes('cash-flow positive'));
  assert.equal(window.RS_METRICS.workforce.runwayMonths, Infinity);
  // now a loss year: runway must be cash ÷ net burn, finite, and NOT cash ÷ payroll
  setVal(window, 'sl-margin-h', '-5');
  const M = window.RS_METRICS.workforce;
  assert.ok(isFinite(M.runwayMonths) && M.runwayMonths > 0);
  assert.ok(M.runwayMonths > M.payrollCoverageMonths, 'net-burn runway exceeds payroll coverage when the loss is smaller than payroll');
  assert.ok(/[\d.]+ mo/.test(txt(window, 'hiring-result')));
  assert.ok(!txt(window, 'hiring-result').includes('Cash-flow positive'));
  // margin typed in the Workforce table is the same value as the AI module's margin
  assert.equal(window.document.getElementById('sl-margin').value, '-5');
  assert.deepEqual(errors, []);
});

test('AI savings: the module quotes the CONFIG per-sector automatable share and labour is a share of costs, not revenue', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require('./helpers/loadApp').HTML_PATH, 'utf8');
  assert.ok(!/aiAutoRate/.test(src), 'no duplicate aiAutoRate table left in SECTORS');
  assert.ok(!/\/0\.65|÷ 0\.65/.test(src), 'labour-share automation proxy removed');
  const { window } = boot('professional');
  const share = Math.round(window.CONFIG.ai.automatableShare.professional * 100);
  assert.ok(txt(window, 'ai-result').includes(share + '% automatable'));
  assert.ok(txt(window, 'ai-result').includes('% of costs'));
  const m3 = txt(window, 'm3-analyst-tbody');
  assert.ok(m3.includes('% of costs') && m3.includes(share + '% automatable'));
});

test('rate sensitivity is labelled as variable-cost increase per 1 pt Fed move everywhere, with CONFIG values', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require('./helpers/loadApp').HTML_PATH, 'utf8');
  assert.ok(!/profit impact per 1% Fed/.test(src), 'old "profit impact" wording removed');
  assert.ok(!/cost rise per 1% rate increase/.test(src), 'old "cost rise per 1%" wording removed');
  assert.ok(!/% profit\/1% rate/.test(src), 'old "% profit/1% rate" wording removed');
  const { window } = boot('realestate');
  const C = window.CONFIG.rateSensitivity;
  const m4 = txt(window, 'rs-note-m4');
  assert.ok(m4.includes('variable-cost increase per 1 pt Fed move'));
  assert.ok(m4.includes('Real Estate ' + (C.realestate * 100).toFixed(1) + '% (highest)'), m4);
  assert.ok(m4.includes('Construction ' + (C.construction * 100).toFixed(1) + '%'));
  assert.ok(txt(window, 'rs-note-m5').includes('Retail ' + (C.retail * 100).toFixed(1) + '%'));
  assert.ok(txt(window, 'eq-banner-desc').includes((C.realestate * 100).toFixed(1) + '% variable-cost increase per 1 pt Fed move'));
  assert.ok(txt(window, 'eq-lev-tbody').includes('VC increase / 1 pt Fed'));
  assert.ok(txt(window, 'm5-analyst-tbody').includes('VC increase per 1 pt Fed move'));
});

test('current Fed rate and as-of date come from CONFIG, not literals, and render in the UI', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require('./helpers/loadApp').HTML_PATH, 'utf8');
  const literals = src.split('\n').filter((l) => /3\.75/.test(l) && !/currentFedRate: 3\.75|rlevels=/.test(l));
  assert.deepEqual(literals, [], 'no hard-coded 3.75 outside CONFIG / the rate-table grid');
  assert.ok(!/April 2026/.test(src.replace(/fedRateAsOf: 'April 2026'/, '')), 'as-of date only in CONFIG');
  const { window } = boot('manufacturing');
  const C = window.CONFIG;
  assert.equal(txt(window, 'fed-asof-label'), 'Current rate — ' + C.fedRateAsOf);
  assert.equal(txt(window, 'fed-current-tag'), C.currentFedRate.toFixed(2) + '%');
  assert.ok(txt(window, 'fed-unit-note').includes(C.fedRateAsOf));
  assert.equal(parseFloat(window.document.getElementById('fed-slider').value), C.currentFedRate);
  assert.equal(parseFloat(window.document.getElementById('f-cpi').value), C.macroDefaults.cpi);
  // sector action text substitutes the live rate rather than a typed constant
  const { window: w2 } = boot('construction');
  assert.ok(txt(w2, 'ai-actions').includes('At ' + w2.CONFIG.currentFedRate.toFixed(2) + '% Fed rate'));
});

test('FRED prefill applies a snapshot and falls back to CONFIG when the fetch fails', async () => {
  const { window, errors } = boot('manufacturing');
  const before = window.CONFIG.currentFedRate;
  // failure path: fetch rejects → false, nothing changes
  const failed = await window.loadFredData();
  assert.equal(failed, false);
  assert.equal(window.CONFIG.currentFedRate, before);
  // success path
  window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ asOf: 'August 2026', fedFunds: 3.64, cpi: 2.9, corePce: 2.6, unemployment: 4.3, gdpGrowth: 4.5, treasury10y: 4.05 }) });
  const ok = await window.loadFredData();
  assert.equal(ok, true);
  assert.equal(window.CONFIG.currentFedRate, 3.64);
  assert.equal(window.CONFIG.fedRateAsOf, 'August 2026');
  assert.equal(parseFloat(window.document.getElementById('fed-slider').value), 3.64);
  assert.equal(parseFloat(window.document.getElementById('f-cpi').value), 2.9);
  assert.equal(parseFloat(window.document.getElementById('f-gdp').value), 4.5);
  assert.equal(txt(window, 'fed-asof-label'), 'Current rate — August 2026');
  assert.equal(txt(window, 'fed-current-tag'), '3.64%');
  assert.ok(txt(window, 'fed-source-note').includes('Live FRED'));
  assert.equal(window.SCENARIOS.base.fed, 3.64);
  assert.equal(window.applyMarketData(null), false);
  assert.equal(window.applyMarketData({ fedFunds: 'garbage' }), false);
  assert.deepEqual(badValues(window, 'fred'), []);
  assert.deepEqual(errors, []);
});

test('confidence, historical analog and FOMC probabilities are computed from the inputs, not constants', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require('./helpers/loadApp').HTML_PATH, 'utf8');
  assert.ok(!/1995 — 74% match|74% match|>74%</.test(src), 'no hard-coded analog/confidence in markup or prose');
  const { window } = boot('manufacturing');
  const M = window.RS_METRICS.forecast;
  assert.equal(txt(window, 'conf'), M.confidence + '%');
  assert.equal(txt(window, 'analog-tag'), M.analogYear + ' — ' + M.analogMatch + '% match');
  assert.ok(txt(window, 'analog-label').includes('Euclidean'));
  const probs = ['pt-hike', 'pt-hold', 'pt-cut'].map((id) => parseInt(txt(window, id), 10));
  assert.equal(probs[0] + probs[1] + probs[2], 100);
  assert.deepEqual(probs, [M.fomc.hike, M.fomc.hold, M.fomc.cut]);
  // move the inputs to a 2022-style inflation shock: analog, confidence and probabilities all move
  setVal(window, 'f-cpi', '7.8'); setVal(window, 'f-pce', '5.1'); setVal(window, 'f-un', '3.6'); setVal(window, 'f-tr', '3.0');
  const M2 = window.RS_METRICS.forecast;
  assert.equal(M2.analogYear, 2022);
  assert.equal(txt(window, 'analog-tag'), '2022 — ' + M2.analogMatch + '% match');
  assert.notEqual(txt(window, 'conf'), M.confidence + '%');
  assert.ok(M2.fomc.hike > M.fomc.hike, 'inflation shock raises hike probability');
  assert.ok(txt(window, 'sec-impact-text').length > 0);
  // the "current rate" row is the actual policy rate, not a treasury proxy
  assert.equal(txt(window, 'cur-r'), window.CONFIG.currentFedRate.toFixed(2) + '%');
  assert.ok(src.includes('FOMC probabilities (model-implied)'));
});

test('pricing guardrails render: low/base/high range, far-from-current warning, and tiny elasticity stays finite', () => {
  const { window, errors } = boot('manufacturing');
  assert.ok(/Recommended price range: \$[\d,]+ \(low\) · \$[\d,]+ \(base\) · \$[\d,]+ \(high\)/.test(txt(window, 'eq-price-range')), txt(window, 'eq-price-range'));
  assert.ok(txt(window, 'm5b-rec-price-sub').startsWith('Range $'));
  // push current price far below the optimum → warning banner appears everywhere
  const optP = window.RS_METRICS && window.Model.optimalPricing({ price: 850, output: 8000, vc: 578, fc: 1700000, elas: 1.4, fed: window.CONFIG.currentFedRate, sector: 'manufacturing', env: window.gEnv }).optP;
  setVal(window, 'sl-eq-price', String(Math.round(optP * 0.5)));
  assert.ok(window.document.getElementById('eq-range-warning'), 'warning banner rendered');
  assert.ok(txt(window, 'eq-range-warning').includes('only reliable near it'));
  assert.ok(txt(window, 'm5b-rec-price-sub').includes('far from current price'));
  assert.ok(txt(window, 'ceo-content').includes('range $'));
  // near the optimum → no banner
  setVal(window, 'sl-eq-price', String(Math.round(optP)));
  assert.equal(window.document.getElementById('eq-range-warning'), null);
  // elasticity below the floor does not produce NaN/Infinity and says so
  setVal(window, 'sl-eq-elas', '0.1');
  assert.deepEqual(badValues(window, 'tiny-elas'), []);
  assert.ok(txt(window, 'eq-price-range').includes('elasticity floored at ' + window.CONFIG.pricing.minElasticity));
  assert.deepEqual(errors, []);
});

test('debt module: interest-only figures are labelled as interest, SBA is the variable ceiling, and an amortising payment uses the term input', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require('./helpers/loadApp').HTML_PATH, 'utf8');
  assert.ok(!/Monthly payment =/.test(src), '"Monthly payment" formula renamed');
  assert.ok(src.includes('Monthly interest = (balance × annual_rate ÷ 100) ÷ 12'));
  assert.ok(src.includes('Amortising payment = P × (r ÷ 12)'));
  const { window, errors } = boot('manufacturing');
  assert.ok(/\/mo interest$/.test(txt(window, 'lr-prime-pay')), txt(window, 'lr-prime-pay'));
  assert.ok(txt(window, 'm4-analyst-tbody').includes('SBA variable ceiling (Prime + 2.75%)'));
  assert.ok(src.includes('SBA variable ceiling (Prime + 2.75%)</div>'), 'SBA card formula label');
  const amort = txt(window, 'lr-amort');
  assert.ok(/Full amortising payment \(10-yr term\): \$[\d,]+\/mo principal \+ interest/.test(amort), amort);
  const D = window.RS_METRICS.debt;
  assert.ok(D.amortisingPayment > D.monthlyInterest, 'principal + interest exceeds interest only');
  assert.ok(txt(window, 'm4-amort-th').includes('10-yr term'));
  // shorter term → higher amortising payment, interest unchanged
  setVal(window, 'sl-debt-term', '5');
  const D2 = window.RS_METRICS.debt;
  assert.equal(D2.termYears, 5);
  assert.ok(D2.amortisingPayment > D.amortisingPayment);
  assert.equal(D2.monthlyInterest, D.monthlyInterest);
  assert.ok(txt(window, 'lr-amort').includes('5-yr term'));
  assert.deepEqual(badValues(window, 'debt'), []);
  assert.deepEqual(errors, []);
});

test('negative margin renders without NaN and the simulator does not floor it to +2%', () => {
  const { window, errors } = boot('manufacturing');
  setVal(window, 'sl-margin', '-25');
  assert.deepEqual(badValues(window, 'neg-margin'), []);
  window.baselineMargin = -20;
  window.runScenario('recession');
  assert.ok(parseFloat(window.document.getElementById('sl-margin').value) < 0);
  assert.deepEqual(errors, []);
});
