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
  'f-cpi', 'f-un', 'f-tr', 'f-gdp', 'f-pce', 'f-cpi-3mo', 'f-pce-3mo', 'f-tr-3mo', 'f-tr6mo', 'f-tr2y', 'f-cme-hike', 'f-cme-cut',
  'sl-rev-h', 'sl-head', 'sl-sal', 'sl-hire', 'sl-debt', 'sl-cash', 'sl-margin-h',
  'sl-rev-ai', 'sl-margin', 'sl-labour', 'sl-rawmat', 'sl-fixed',
  'cd-cash', 'cd-opex', 'cd-buffer', 'cd-checking', 'cd-mmf', 'cd-tbill', 'cd-cd',
  'fed-slider', 'sl-debt-fixed-pct', 'sl-debt-fixed-rate', 'sl-debt-term',
  'sl-eq-price', 'sl-eq-output', 'sl-eq-vc', 'sl-eq-fc', 'sl-eq-elas'
];
const OUTPUT_IDS = ['pred-rate', 'sec-impact-text', 'mkt-label', 'pt-mkt-hike', 'pt-mkt-cut', 'pt-cme-hike', 'pt-cme-cut', 'hiring-result', 'ai-result', 'lr-total', 'lr-annual', 'lr-exposed', 'lr-amort',
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
  const cases = [
    { margin: '7', scenario: 'base' },       // cash-flow positive
    { margin: '-6', scenario: 'base' },      // loss year → finite net-burn runway
    { margin: '7', scenario: 'recession' },  // non-base scenario changes env + inputs
    { margin: '-3', scenario: 'inflation' }
  ];
  SECTORS.forEach((sectorKey) => cases.forEach((c) => {
    const { window } = boot(sectorKey);
    let sector = sectorKey;
    // non-default inputs so agreement is not an accident of defaults
    setVal(window, 'sl-hire', '23');
    setVal(window, 'sl-cash', '0.9');
    setVal(window, 'sl-margin', c.margin);
    setVal(window, 'sl-labour', '41');
    window.baselineMargin = parseFloat(c.margin);
    window.runScenario(c.scenario);
    window.updateAll();
    // simulator metrics were computed inside runScenario on the same inputs the modules now show
    window.calcSafeHires(window.SCENARIOS[c.scenario]);
    window.calcAIGain(window.SCENARIOS[c.scenario], parseFloat(window.document.getElementById('sl-rev-ai').value), parseFloat(window.document.getElementById('sl-labour').value));
    const M = window.RS_METRICS;
    sector = sector + '/' + c.scenario + '/m' + c.margin;
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
    assert.ok(txt(window, 'ceo-content').includes('Safe hires: ' + M.workforce.safeHires + ' of'), sector + ' CEO text');
    assert.equal(txt(window, 'hm-ai'), '$' + M.ai.aiSavingsM.toFixed(1) + 'M', sector + ' health AI text');
    assert.equal(txt(window, 'sm-ai-val'), '$' + (Math.round(M.ai.aiSavingsM * 10) / 10).toFixed(1) + 'M/yr', sector + ' simulator AI text');
    if (parseFloat(c.margin) < 0) assert.ok(isFinite(M.workforce.runwayMonths), sector + ' loss year has finite runway');
  }));
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

test('"Current rate" reads the live daily DFF after prefill with its observation date, and a restored saved profile cannot clobber live market data', async () => {
  const { window, errors } = boot('manufacturing');
  const today = new Date().toISOString().slice(0, 10);
  const snapshot = { asOf: today, fedFundsDate: today, fedFunds: 3.64, cpi: 2.9, corePce: 2.6, unemployment: 4.3, gdpGrowth: 2.4, treasury10y: 4.05, dates: { DFF: today } };
  window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(snapshot) });
  assert.equal(await window.loadFredData(), true);
  assert.equal(txt(window, 'cur-r'), '3.64% · as of ' + today, 'Rate path "Current rate" shows the live DFF value and its date');
  assert.equal(window.RS_METRICS.forecast.currentSource, 'DFF (live, daily)');
  const asOf = window.RS_METRICS.forecast.currentAsOf;
  assert.ok(Math.abs((new Date(asOf) - new Date(today)) / 86400000) <= 7, 'as-of date within 7 days of today');
  assert.ok(txt(window, 'fed-source-note').includes('DFF daily 3.64% (' + today + ')'));
  assert.equal(parseFloat(window.document.getElementById('f-gdp').value), 2.4);
  // a saved profile (loaded later) with stale market values must not overwrite the live ones
  window.restoreInputs({ 'fed-slider': '3.75', 'f-cpi': '3.2', 'f-gdp': '2.1', 'sl-head': '300' });
  assert.equal(parseFloat(window.document.getElementById('fed-slider').value), 3.64, 'saved fed rate ignored');
  assert.equal(parseFloat(window.document.getElementById('f-cpi').value), 2.9, 'saved CPI ignored');
  assert.equal(parseFloat(window.document.getElementById('f-gdp').value), 2.4, 'saved GDP ignored');
  assert.equal(parseFloat(window.document.getElementById('sl-head').value), 300, 'business inputs still restored');
  assert.equal(txt(window, 'cur-r'), '3.64% · as of ' + today);
  assert.equal(txt(window, 'fed-current-tag'), '3.64%');
  // the Fed input remains a what-if lever: dragging it changes loans but not the "Current rate" row
  setVal(window, 'fed-slider', '6');
  assert.equal(txt(window, 'cur-r'), '3.64% · as of ' + today);
  assert.ok(window.document.getElementById('fed-slider')._userSet, 'manual edit marks the input as user-set');
  // ...and a later live refresh respects the manual edit
  window.applyMarketData(Object.assign({}, snapshot, { fedFunds: 3.5 }));
  assert.equal(parseFloat(window.document.getElementById('fed-slider').value), 6);
  assert.equal(window.CONFIG.currentFedRate, 3.5);
  assert.deepEqual(errors, []);
});

test('FRED prefill applies a snapshot and falls back to CONFIG when the fetch fails', async () => {
  const { window, errors } = boot('manufacturing');
  const before = window.CONFIG.currentFedRate;
  // failure path: fetch rejects → false, nothing changes
  const failed = await window.loadFredData();
  assert.equal(failed, false);
  assert.equal(window.CONFIG.currentFedRate, before);
  // success path
  window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ asOf: '2026-08-14', fedFunds: 3.64, cpi: 2.9, corePce: 2.6, unemployment: 4.3, gdpGrowth: 4.5, treasury10y: 4.05 }) });
  const ok = await window.loadFredData();
  assert.equal(ok, true);
  assert.equal(window.CONFIG.currentFedRate, 3.64);
  assert.equal(window.CONFIG.fedRateAsOf, '2026-08-14');
  assert.equal(parseFloat(window.document.getElementById('fed-slider').value), 3.64);
  assert.equal(parseFloat(window.document.getElementById('f-cpi').value), 2.9);
  assert.equal(parseFloat(window.document.getElementById('f-gdp').value), 4.5);
  assert.equal(txt(window, 'fed-asof-label'), 'Current rate — 2026-08-14');
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
  assert.equal(txt(window, 'cur-r'), window.CONFIG.currentFedRate.toFixed(2) + '% · as of ' + window.CONFIG.fedRateAsOf);
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

test('simulator: the recession scenario shows fewer safe hires than the base case in every sector', () => {
  SECTORS.forEach((sector) => {
    const { window, errors } = boot(sector);
    window.runScenario('base');
    const base = window.RS_METRICS.simulator.safeHires;
    window.runScenario('recession');
    const rec = window.RS_METRICS.simulator.safeHires;
    assert.ok(rec < base, `${sector}: recession ${rec} should be < base ${base}`);
    assert.ok(txt(window, 'sm-hire').startsWith(rec + ' '));
    assert.ok(txt(window, 'm2-analyst-tbody').includes('Demand factor'));
    assert.deepEqual(errors, []);
  });
});

test('simulator: AI Acceleration raises AI savings above base via the automatable share, with pricing pressure on its own line', () => {
  SECTORS.forEach((sector) => {
    const { window, errors } = boot(sector);
    window.runScenario('base');
    const baseAi = window.RS_METRICS.simulator.aiSavingsM;
    const basePrice = window.RS_METRICS.simulator.optPrice;
    assert.equal(window.SCENARIO_MODS.automatableMult, 1);
    assert.ok(txt(window, 'sim-pressure-line').startsWith('Pricing pressure: none'));
    window.runScenario('ai');
    const aiAi = window.RS_METRICS.simulator.aiSavingsM;
    assert.ok(aiAi > baseAi, `${sector}: AI scenario savings ${aiAi} should exceed base ${baseAi}`);
    assert.equal(window.SCENARIO_MODS.automatableMult, 1.5);
    const share = window.Model.aiSavings({ revenueM: 10, marginPct: 10, labourPctOfCosts: 30, sector, automatableMult: 1.5 }).automatable;
    assert.ok(share <= window.CONFIG.ai.automatableCap);
    // the AI module on the page reflects the same boosted share
    assert.ok(txt(window, 'ai-result').includes(Math.round(share * 100) + '% automatable'));
    // margin was not lowered; pricing pressure is reported separately
    assert.equal(parseFloat(window.document.getElementById('sl-margin').value), window.baselineMargin);
    const line = txt(window, 'sim-pressure-line');
    assert.ok(line.includes('unit variable cost −18%') || line.includes('unit variable cost -18%'), line);
    assert.ok(line.includes('vs base $' + Math.round(basePrice).toLocaleString()));
    // and returning to base resets the multiplier
    window.runScenario('base');
    assert.equal(window.SCENARIO_MODS.automatableMult, 1);
    assert.ok(Math.abs(window.RS_METRICS.simulator.aiSavingsM - baseAi) < 1e-9);
    assert.deepEqual(errors, []);
  });
});

test('Financing Strategy renders the backtest hit rate from Model.backtest', () => {
  const { window } = boot('manufacturing');
  const bt = window.Model.backtest();
  const nm = ' · Next-meeting calls: ' + bt.nextMeeting.hits + ' of ' + bt.nextMeeting.total;
  assert.equal(txt(window, 'backtest-line'), 'Backtest: ' + bt.hits + ' of ' + bt.total + ' historical episodes, direction correct' + nm);
  assert.equal(txt(window, 'backtest-label'), 'Backtest (12-month direction, ±' + window.CONFIG.analog.backtestDeadZone + ' = hold)');
  // rendered exactly once, as its own full-width row directly below "Model confidence"
  const panel = window.document.getElementById('backtest-row').parentElement;
  assert.ok(panel.textContent.includes('Rate path'), 'row lives in the Rate path card');
  assert.equal((panel.textContent.match(/historical episodes/g) || []).length, 1, '"historical episodes" appears exactly once in the panel');
  const visible = window.document.body.cloneNode(true);
  visible.querySelectorAll('script,style').forEach((n) => n.remove());
  assert.equal((visible.textContent.match(/historical episodes/g) || []).length, 1, 'and exactly once in the visible page text');
  const rows = Array.from(panel.querySelectorAll('.dr'));
  const confIdx = rows.findIndex((r) => r.textContent.includes('Model confidence'));
  assert.equal(rows[confIdx + 1].id, 'backtest-row', 'directly below Model confidence');
  assert.equal(window.getComputedStyle(rows[confIdx + 1]).display, 'block', 'full-width row, not a two-column flex row');
  assert.equal(bt.total, 13); assert.equal(bt.nextMeeting.total, 1);
  const m = window.RS_METRICS.forecast.backtest;
  assert.equal(m.hits, bt.hits); assert.equal(m.total, bt.total); assert.equal(m.hitRate, bt.hitRate);
  assert.equal(m.nextMeeting.hits, bt.nextMeeting.hits); assert.equal(m.nextMeeting.total, 1);
  // with today's live-style inputs the analog is a historical year, never 2026
  window.applyMarketData({ asOf: 'September 2026', fedFunds: 3.63, cpi: 3.4, corePce: 3.3, unemployment: 4.1, gdpGrowth: 1.5, treasury10y: 4.95 });
  window.updateAll();
  assert.notEqual(window.RS_METRICS.forecast.analogYear, 2026);
  assert.ok(!txt(window, 'analog-tag').startsWith('2026'));
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

test('market-implied row: computed from the 6-month Treasury vs Fed funds, disagreement line toggles, CME row only when typed', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require('./helpers/loadApp').HTML_PATH, 'utf8');
  assert.ok(!src.split('\n').some((line) => /Source:[^<]*CME/.test(line)), 'CME FedWatch is never cited as a data source');
  const allowed = [/^ (hike|cut) % \(optional\)/, /^ \(entered by you\)/, /^ hike\/cut % box/, /^ \/ StreetStats \/ Bank note/];
  assert.ok(src.split('CME FedWatch').every((frag, i) => i === 0 || allowed.some((re) => re.test(frag))),
    'every remaining "CME FedWatch" string is an input label, the "entered by you" row, the FedWatch-box hint, or the consensus source placeholder');
  const { window, errors } = boot('manufacturing');
  const C = window.CONFIG;
  // snapshot defaults: 6-mo at the policy rate → hold, bars rendered from Model.marketProbabilities
  let M = window.RS_METRICS.forecast;
  const expected = window.Model.marketProbabilities(M.market.sixMonthSpread);
  assert.deepEqual([txt(window, 'pt-mkt-hike'), txt(window, 'pt-mkt-hold'), txt(window, 'pt-mkt-cut')], [expected.hike + '%', expected.hold + '%', expected.cut + '%']);
  assert.ok(txt(window, 'mkt-label').startsWith('Market-implied (6-mo Treasury vs Fed funds)'));
  assert.ok(txt(window, 'mkt-label').includes('→ ' + M.market.direction));
  assert.equal(window.document.getElementById('cme-row').style.display, 'none', 'CME row hidden until the user types a value');
  // push the 6-month bill 40 bp above Fed funds: market says hike; model (predicting cuts) disagrees
  setVal(window, 'f-tr6mo', String(C.currentFedRate + 0.40));
  M = window.RS_METRICS.forecast;
  assert.equal(M.market.direction, 'hike');
  assert.ok(parseInt(txt(window, 'pt-mkt-hike'), 10) > 85);
  assert.equal(M.disagree, M.modelDirection !== 'hike');
  assert.equal(window.document.getElementById('mkt-disagree').style.display, M.disagree ? '' : 'none');
  assert.ok(txt(window, 'mkt-disagree').includes('the market is usually right on the next meeting'));
  // align the market with the model → line disappears
  const modelDir = M.modelDirection;
  setVal(window, 'f-tr6mo', String(C.currentFedRate + (modelDir === 'hike' ? 0.4 : modelDir === 'cut' ? -0.4 : 0)));
  assert.equal(window.RS_METRICS.forecast.disagree, false);
  assert.equal(window.document.getElementById('mkt-disagree').style.display, 'none');
  // CME row: typed values only
  setVal(window, 'f-cme-hike', '70');
  assert.equal(window.document.getElementById('cme-row').style.display, '');
  assert.equal(txt(window, 'pt-cme-hike'), '70%');
  assert.equal(txt(window, 'pt-cme-hold'), '—', 'hold unknown until cut is entered');
  setVal(window, 'f-cme-cut', '5');
  assert.equal(txt(window, 'pt-cme-cut'), '5%');
  assert.equal(txt(window, 'pt-cme-hold'), '25%');
  const cme = window.RS_METRICS.forecast.cme;
  assert.equal(cme.hike, 70); assert.equal(cme.cut, 5); assert.equal(cme.hold, 25);
  // live FRED data pre-fills the two Treasury inputs and the source note names the series
  window.applyMarketData({ asOf: 'September 2026', fedFunds: 3.63, cpi: 3.4, corePce: 3.3, unemployment: 4.1, gdpGrowth: 1.5, treasury10y: 4.95, treasury6mo: 3.90, treasury2y: 3.55 });
  assert.ok(txt(window, 'fed-source-note').includes('DGS6MO 3.9%'));
  assert.equal(parseFloat(window.document.getElementById('f-tr2y').value), 3.55);
  assert.equal(window.CONFIG.macroDefaults.tr6mo, 3.9);
  assert.ok(txt(window, 'mkt-label').includes('2-yr spread'));
  assert.deepEqual(badValues(window, 'market'), []);
  assert.deepEqual(errors, []);
});

test('momentum inputs: pre-filled from FRED, overridable, and feed the forecast, analyst table, chart and simulator alike', () => {
  const { window, errors } = boot('manufacturing');
  const C = window.CONFIG;
  // snapshot: 3-month-ago inputs equal today's values → zero momentum
  assert.equal(parseFloat(window.document.getElementById('f-pce-3mo').value), C.macroDefaults.pce3mo);
  assert.equal(window.RS_METRICS.forecast.momentum.pcePts, 0);
  assert.equal(window.RS_METRICS.forecast.momentum.trPts, 0);
  const before = txt(window, 'pred-rate');
  // live FRED data fills both inputs
  window.applyMarketData({ asOf: 'September 2026', fedFunds: 3.63, cpi: 3.4, corePce: 3.3, unemployment: 4.1, gdpGrowth: 1.5, treasury10y: 4.95,
    treasury6mo: 3.9, treasury2y: 3.55, cpi3moAgo: 3.0, corePce3moAgo: 2.8, treasury10y3moAgo: 4.45 });
  window.updateAll();
  assert.equal(parseFloat(window.document.getElementById('f-cpi-3mo').value), 3.0, 'CPI 3 months ago pre-filled from FRED');
  assert.ok(Math.abs(window.RS_METRICS.forecast.momentum.cpiPts - 0.32) < 1e-9, 'CPI +0.4 pt × 0.8');
  assert.ok(txt(window, 'fed-source-note').includes('CPIAUCSL 3 mo earlier 3%'));
  assert.equal(parseFloat(window.document.getElementById('f-pce-3mo').value), 2.8);
  assert.equal(parseFloat(window.document.getElementById('f-tr-3mo').value), 4.45);
  assert.ok(txt(window, 'fed-source-note').includes('PCEPILFE 3 mo earlier 2.8%'));
  const M = window.RS_METRICS.forecast;
  assert.ok(Math.abs(M.momentum.pcePts - 0.5) < 1e-9, 'Core PCE +0.5 pt in 3 months → +0.5 score');
  assert.ok(Math.abs(M.momentum.trPts - 0.3) < 1e-9, '10Y +0.5 pt × 0.6');
  // the same contributions are what the analyst table and chart show
  const rows = Array.from(window.document.querySelectorAll('#m1-analyst-tbody tr')).map((tr) => tr.textContent);
  assert.ok(rows.some((r) => r.includes('CPI momentum (3-mo)') && r.includes('+0.32 pts')), rows.join('\n'));
  assert.ok(rows.some((r) => r.includes('Core PCE momentum (3-mo)') && r.includes('+0.50 pts')), rows.join('\n'));
  assert.ok(rows.some((r) => r.includes('10Y momentum (3-mo)') && r.includes('+0.30 pts')));
  window.document.getElementById('app').classList.add('adv-mode'); // analyst charts only render in advanced mode
  window.updateAnalystCharts();
  assert.equal(window.m1AC.data.labels.length, 9);
  assert.ok(Math.abs(window.m1AC.data.datasets[0].data[5] - 0.32 * C.forecast.scorePerPt) < 1e-6, 'CPI momentum bar');
  assert.ok(Math.abs(window.m1AC.data.datasets[0].data[6] - 0.5 * C.forecast.scorePerPt) < 1e-6, 'PCE momentum bar');
  // a user override wins over the next live refresh and moves the forecast
  setVal(window, 'f-pce-3mo', '5.5');
  assert.ok(window.RS_METRICS.forecast.momentum.pcePts < 0, 'PCE falling from 5.5 → negative momentum');
  window.applyMarketData({ asOf: 'September 2026', fedFunds: 3.63, corePce3moAgo: 2.8 });
  assert.equal(parseFloat(window.document.getElementById('f-pce-3mo').value), 5.5, 'manual edit protected');
  // the scenario simulator's base case uses the same momentum inputs as Module 1
  window.runScenario('base');
  assert.equal(txt(window, 'sm-rate').replace(/[^\d.]/g, ''), window.RS_METRICS.forecast.predicted12.toFixed(2).replace(/[^\d.]/g, ''));
  assert.notEqual(txt(window, 'pred-rate'), before + '__never__');
  assert.deepEqual(badValues(window, 'momentum'), []);
  assert.deepEqual(errors, []);
});

test('Fed stance row: "No brief yet" and zero contribution without a brief; a mocked fed_briefs row renders the score, date and why-tooltip and moves the forecast', () => {
  const { window, errors } = boot('manufacturing');
  assert.equal(txt(window, 'f-fed-stance-val'), 'No brief yet');
  assert.equal(window.RS_METRICS.forecast.fedStance.pts, 0);
  assert.equal(window.RS_METRICS.forecast.fedStance.score, null);
  const before = window.RS_METRICS.forecast.score;
  const brief = { id: 1, brief_date: '2026-09-20', stance_score: 1.5, next_meeting_lean: 'hike', next_meeting_date: '2026-10-28',
    summary: 'Officials signalled further tightening. A hike in October is the base case.', key_phrases: ['further tightening'],
    sources: [{ title: 'FOMC statement', url: 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20260916a.htm', published: '2026-09-16' }], fed_funds_at_brief: 3.88 };
  assert.equal(window.applyFedBrief(brief), true);
  window.updateAll();
  const val = window.document.getElementById('f-fed-stance-val');
  assert.equal(val.textContent, '+1.50 hawkish');
  assert.ok(val.title.startsWith('Why: Officials signalled further tightening.'), val.title);
  assert.ok(val.title.includes('Contribution +1.13'));
  assert.equal(txt(window, 'f-fed-stance-unit'), 'brief of 20 Sep · read-only');
  assert.ok(!window.document.querySelector('#f-fed-stance-row input'), 'read-only: no input element');
  const M = window.RS_METRICS.forecast;
  assert.ok(Math.abs(M.fedStance.pts - 1.125) < 1e-9);
  assert.equal(M.fedStance.briefDate, '2026-09-20');
  assert.ok(Math.abs(M.score - before - 1.125) < 1e-9, 'forecast score moved by the stance contribution');
  const rows = Array.from(window.document.querySelectorAll('#m1-analyst-tbody tr')).map((tr) => tr.textContent);
  assert.ok(rows.some((r) => r.includes('Fed stance (daily brief)') && r.includes('+1.50') && r.includes('+1.13 pts')), rows.join('\n'));
  // simulator base case carries the same term
  window.runScenario('base');
  assert.equal(txt(window, 'sm-rate').replace(/[^\d.]/g, ''), M.predicted12.toFixed(2));
  // a malformed row is ignored and the app returns to "No brief yet"
  assert.equal(window.applyFedBrief({ stance_score: 'hawkish' }), false);
  assert.equal(txt(window, 'f-fed-stance-val'), 'No brief yet');
  assert.equal(window.applyFedBrief(null), false);
  assert.deepEqual(badValues(window, 'fed-stance'), []);
  assert.deepEqual(errors, []);
});

test('Rate Outlook card: the Fed watch strip renders from a mocked fed_briefs row above the rate-path chart', () => {
  const { window, errors } = boot('manufacturing');
  const card = window.document.getElementById('rate-outlook');
  assert.ok(card, 'Rate Outlook card exists');
  const chart = window.document.getElementById('fChart').closest('.chart-wrap');
  assert.equal(card.nextElementSibling, chart, 'strip sits directly above the 18-month rate-path chart');
  assert.equal(txt(window, 'fed-watch-line'), 'Fed stance: no brief yet');
  assert.equal(txt(window, 'fed-watch-asof'), 'No brief yet');
  window.applyFedBrief({ id: 2, brief_date: '2026-09-20', stance_score: 1.5, next_meeting_lean: 'hike', next_meeting_date: '2026-10-28',
    summary: 'Officials signalled further tightening after the energy-driven re-acceleration. A 25 bp hike on 28 October is the base case.',
    key_phrases: ['further tightening'], fed_funds_at_brief: 3.88,
    sources: [{ title: 'Federal Reserve issues FOMC statement', url: 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20260916a.htm', published: '2026-09-16' },
              { title: 'Speech', url: 'https://example.com/not-the-fed', published: '2026-09-18' }] });
  assert.equal(txt(window, 'fed-watch-line'), 'Fed stance: hawkish +1.5 · last statement 18 Sep · next meeting 28 Oct (lean: hike)');
  assert.equal(txt(window, 'fed-watch-summary'), 'Officials signalled further tightening after the energy-driven re-acceleration. A 25 bp hike on 28 October is the base case.');
  assert.equal(txt(window, 'fed-watch-asof'), 'as of 20 Sep · Fed funds 3.88%');
  const links = Array.from(window.document.querySelectorAll('#fed-watch-sources a')).map((a) => a.href);
  assert.deepEqual(links, ['https://www.federalreserve.gov/newsevents/pressreleases/monetary20260916a.htm'], 'only federalreserve.gov links are rendered');
  // a brief with no sources (copied forward) still renders
  window.applyFedBrief({ brief_date: '2026-09-21', stance_score: -0.75, next_meeting_lean: 'cut', next_meeting_date: '2026-10-28', summary: 'Copied.', sources: [] });
  assert.equal(txt(window, 'fed-watch-line'), 'Fed stance: dovish -0.8 · last statement none since 21 Sep · next meeting 28 Oct (lean: cut)');
  assert.equal(txt(window, 'fed-watch-sources'), '');
  assert.deepEqual(badValues(window, 'fed-watch'), []);
  assert.deepEqual(errors, []);
});

test('"Run brief now": visible only for the owner email, calls /api/fed-brief with the owner session token (never a secret in the page), applies the returned brief', async () => {
  const fs = require('fs');
  const src = fs.readFileSync(require('./helpers/loadApp').HTML_PATH, 'utf8');
  assert.ok(!/CRON_SECRET|SERVICE_ROLE/.test(src), 'no server secret names anywhere in the page');
  const { window, errors } = boot('manufacturing');
  const btn = window.document.getElementById('run-brief-btn');
  assert.equal(btn.style.display, 'none', 'hidden by default');
  window.setOwnerUi('someone@else.com');
  assert.equal(btn.style.display, 'none', 'hidden for other users');
  window.setOwnerUi('Rajatinpa@gmail.com');
  assert.equal(btn.style.display, '', 'visible for the owner (case-insensitive)');
  // no supabase session available in tests → a clear message, no request
  assert.equal(await window.runFedBriefNow(), false);
  assert.equal(btn.textContent, 'Sign in first');
  // stub a signed-in owner and the endpoint
  const calls = [];
  window.supabase = { auth: { getSession: () => Promise.resolve({ data: { session: { access_token: 'aaa.bbb.ccc', user: { email: 'rajatinpa@gmail.com' } } } }) } };
  const brief = { brief_date: '2026-09-20', stance_score: 1.25, next_meeting_lean: 'hike', next_meeting_date: '2026-10-28', summary: 'Hawkish. Hike likely.', key_phrases: [], sources: [], fed_funds_at_brief: 3.88 };
  window.fetch = (url, opts) => { calls.push({ url, opts }); return Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true, via: 'owner', action: 'generated', anthropicCalled: true, brief }) }); };
  assert.equal(await window.runFedBriefNow(), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/fed-brief');
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer aaa.bbb.ccc', 'owner session token, not a cron secret');
  assert.equal(btn.textContent, 'Brief generated · stance +1.25');
  assert.equal(txt(window, 'f-fed-stance-val'), '+1.25 hawkish');
  assert.ok(txt(window, 'fed-watch-line').startsWith('Fed stance: hawkish +1.3'));
  assert.equal(window.LAST_BRIEF_RUN.action, 'generated');
  // a 401 from the endpoint is surfaced, not swallowed
  window.fetch = () => Promise.resolve({ status: 401, json: () => Promise.resolve({ error: 'Unauthorized', reason: 'not the owner' }) });
  assert.equal(await window.runFedBriefNow(), false);
  assert.equal(btn.textContent, 'Brief failed: not the owner');
  assert.deepEqual(errors, []);
});

test('Scenario Simulator base-case sentence is generated from the live inputs, never hard-coded', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require('./helpers/loadApp').HTML_PATH, 'utf8');
  assert.ok(!/CPI 3\.2% · Unemployment 4\.2%/.test(src), 'no hard-coded macro sentence in the page');
  const { window, errors } = boot('manufacturing');
  window.runScenario('base');
  const sentence = () => {
    const v = (id) => Math.round(parseFloat(window.document.getElementById(id).value) * 100) / 100 + '%';
    return 'CPI ' + v('f-cpi') + ' · Unemployment ' + v('f-un') + ' · GDP ' + v('f-gdp') + ' · 10Y Treasury ' + v('f-tr') + ' · Core PCE ' + v('f-pce') + '.';
  };
  assert.ok(txt(window, 'sim-desc-text').startsWith(sentence()), txt(window, 'sim-desc-text'));
  assert.ok(txt(window, 'sim-desc-text').includes('Current environment (snapshot ' + window.CONFIG.fedRateAsOf + ')'));
  // live FRED arrives after the simulator initialised → the sentence follows without a click
  window.applyMarketData({ asOf: '2026-09-18', fedFunds: 3.88, cpi: 3.4, corePce: 3.3, unemployment: 4.1, gdpGrowth: 1.5, treasury10y: 4.95 });
  assert.equal(txt(window, 'sim-desc-text').split('. ')[0] + '.', 'CPI 3.4% · Unemployment 4.1% · GDP 1.5% · 10Y Treasury 4.95% · Core PCE 3.3%.');
  assert.ok(txt(window, 'sim-desc-text').startsWith(sentence()), 'matches the Financing Strategy inputs exactly');
  assert.ok(txt(window, 'sim-desc-text').includes('live FRED as of 2026-09-18'));
  assert.ok(/environment — /.test(txt(window, 'sim-desc-text')), 'environment phrase derived from the model, not fixed text');
  // other scenarios still describe their own fixed assumptions
  window.runScenario('recession');
  assert.ok(txt(window, 'sim-desc-text').startsWith('CPI 2.1% · Unemployment 6.2% · GDP -0.8%'));
  window.runScenario('base');
  assert.ok(txt(window, 'sim-desc-text').startsWith(sentence()));
  assert.deepEqual(errors, []);
});

test('consensus form: hidden for non-owners, visible for the owner; empty rates + FedWatch box → derived m3 with source "FedWatch (manual)"; posts with the owner token', async () => {
  const { window, errors } = boot('manufacturing');
  const form = window.document.getElementById('consensus-form');
  assert.equal(form.style.display, 'none', 'hidden by default');
  window.setOwnerUi('someone@else.com');
  assert.equal(form.style.display, 'none', 'hidden for non-owners');
  window.setOwnerUi('rajatinpa@gmail.com');
  assert.equal(form.style.display, '', 'visible for the owner');
  assert.equal(window.document.getElementById('cs-asof').value, new Date().toISOString().slice(0, 10), 'as_of defaults to today');
  // nothing entered anywhere → clear message, no request
  let built = window.consensusFormBody();
  assert.ok(built.error && built.error.includes('at least one horizon'));
  // FedWatch box only → derived 3-month point
  setVal(window, 'f-cme-hike', '70'); setVal(window, 'f-cme-cut', '5');
  built = window.consensusFormBody();
  const cur = Math.round(window.CONFIG.currentFedRate * 100) / 100;
  assert.equal(built.body.source, 'FedWatch (manual)');
  assert.ok(Math.abs(built.body.m3 - (cur + 0.25 * 0.65)) < 1e-3, 'm3 = current + 0.25 × (70 − 5) / 100 (3 dp)');
  assert.equal(built.body.m6, null);
  assert.ok(built.body.note.includes('derived'));
  assert.ok(Math.abs(window.fedWatchM3(3.88, 70, 5) - (3.88 + 0.25 * 0.65)) < 1e-3);
  // typed rates win over the FedWatch box
  window.document.getElementById('cs-source').value = 'Bank note';
  window.document.getElementById('cs-m12').value = '4.25';
  built = window.consensusFormBody();
  assert.equal(built.body.source, 'Bank note'); assert.equal(built.body.m12, 4.25); assert.equal(built.body.m3, null);
  // submit → POST /api/consensus with the owner's session token
  const calls = [];
  window.supabase = { auth: { getSession: () => Promise.resolve({ data: { session: { access_token: 'aaa.bbb.ccc', user: { email: 'rajatinpa@gmail.com', user_metadata: {} } } } }) } };
  window.fetch = (url, opts) => { calls.push({ url, opts }); return Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true, row: Object.assign({ id: 1, m3: null, m6: null, m18: null }, JSON.parse(opts.body)) }) }); };
  assert.equal(await window.submitConsensus({ preventDefault() {} }), true);
  assert.equal(calls[0].url, '/api/consensus');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer aaa.bbb.ccc');
  assert.equal(JSON.parse(calls[0].opts.body).m12, 4.25);
  assert.ok(txt(window, 'cs-status').startsWith('Logged: Bank note'));
  window.fetch = () => Promise.resolve({ status: 400, json: () => Promise.resolve({ error: 'Invalid consensus path', problems: ['m12 must be between 0 and 10 %'] }) });
  window.document.getElementById('cs-m12').value = '12';
  assert.equal(await window.submitConsensus({ preventDefault() {} }), false);
  assert.equal(txt(window, 'cs-status'), 'Not logged: m12 must be between 0 and 10 %');
  assert.deepEqual(errors, []);
});

test('Outlook vs. consensus chart: three series without a consensus row, four with; table, gap row and source line agree with RS_METRICS', () => {
  const { window, errors } = boot('manufacturing');
  const M = window.RS_METRICS.forecast;
  assert.ok(window.outlookChart, 'chart created');
  assert.equal(JSON.stringify(window.outlookChart.data.labels), JSON.stringify(['Now', '3mo', '6mo', '12mo', '18mo']));
  assert.equal(window.outlookChart.data.datasets.length, 3, 'blended, model, market');
  assert.equal(JSON.stringify(window.outlookChart.data.datasets.map((d) => d.label)), JSON.stringify(['RateShield outlook (blended)', 'RateShield model only', 'Market-implied (FRED Treasuries)']));
  assert.equal(window.outlookChart.data.datasets[0].borderWidth, 3, 'blended is bold');
  assert.equal(JSON.stringify(window.outlookChart.data.datasets[1].borderDash), '[6,4]', 'model is dashed');
  assert.equal(window.outlookChart.data.datasets[2].borderDash, undefined, 'market is solid');
  const cur = M.current;
  assert.equal(M.outlook.model[0], cur); assert.equal(M.outlook.market[0], cur); assert.equal(M.outlook.blended[0], cur, 'shared origin');
  assert.equal(M.outlook.model[12], M.predicted12, 'model path is the Rate path panel');
  assert.equal(txt(window, 'r6'), M.outlook.model[6].toFixed(2) + '%');
  assert.equal(M.outlook.consensus, null);
  assert.ok(txt(window, 'ol-consensus').includes('none logged'));
  assert.ok(txt(window, 'ol-gap').includes('—'));
  assert.equal(txt(window, 'outlook-src'), 'Market: FRED DGS6MO/DGS2 · Consensus: none logged · RateShield: model + blend');
  // a consensus row → fourth series, labelled with source and date; gap row filled
  assert.equal(window.applyConsensus({ id: 3, as_of: '2026-09-20', source: 'Bank note', m3: 3.9, m6: null, m12: 4.7, m18: 4.7, note: null }), true);
  window.updateAll();
  const M2 = window.RS_METRICS.forecast;
  assert.equal(window.outlookChart.data.datasets.length, 4);
  assert.equal(window.outlookChart.data.datasets[3].label, 'Consensus — Bank note (2026-09-20)');
  assert.equal(JSON.stringify(window.outlookChart.data.datasets[3].borderDash), '[2,3]', 'consensus is dotted');
  assert.equal(JSON.stringify(window.outlookChart.data.datasets[3].data), JSON.stringify([cur, 3.9, null, 4.7, 4.7]));
  assert.ok(Math.abs(M2.outlook.gap[12] - (M2.outlook.blended[12] - 4.7)) < 1e-9);
  assert.equal(M2.outlook.gap[6], null);
  const gapCells = Array.from(window.document.querySelectorAll('#ol-gap td')).map((td) => td.textContent);
  assert.equal(gapCells[4], (M2.outlook.gap[12] >= 0 ? '+' : '') + M2.outlook.gap[12].toFixed(2) + ' pt');
  assert.equal(gapCells[3], '—');
  assert.equal(txt(window, 'outlook-src'), 'Market: FRED DGS6MO/DGS2 · Consensus: Bank note, entered 2026-09-20 · RateShield: model + blend');
  const blendedCells = Array.from(window.document.querySelectorAll('#ol-blended td')).map((td) => td.textContent);
  assert.equal(blendedCells[4], M2.outlook.blended[12].toFixed(2) + '%');
  // malformed rows are ignored
  assert.equal(window.applyConsensus({ as_of: '2026-09-20', source: 'x' }), false);
  window.updateAll();
  assert.equal(window.outlookChart.data.datasets.length, 3);
  assert.deepEqual(badValues(window, 'outlook'), []);
  assert.deepEqual(errors, []);
});

test('difference sentence: generated from the live inputs, names at least two of them, never "analysts"', () => {
  const { window, errors } = boot('manufacturing');
  const visible = window.document.body.cloneNode(true);
  visible.querySelectorAll('script,style').forEach((n) => n.remove());
  assert.ok(!/analysts? say|according to analysts/i.test(visible.textContent), 'the app reads FRED and the Fed, not analysts');
  window.applyMarketData({ asOf: '2026-09-18', fedFunds: 3.63, cpi: 3.4, corePce: 3.3, unemployment: 4.1, gdpGrowth: 1.5, treasury10y: 4.95, treasury6mo: 4.03, treasury2y: 4.39, cpi3moAgo: 4.2, corePce3moAgo: 3.3, treasury10y3moAgo: 4.4 });
  window.applyConsensus({ as_of: '2026-09-20', source: 'Bank note', m3: 3.9, m6: 4.2, m12: 4.7, m18: 4.7 });
  window.updateAll();
  const M = window.RS_METRICS.forecast;
  const line = txt(window, 'outlook-diff');
  assert.equal(line, M.outlook.sentence);
  assert.ok(line.startsWith("At 12 months RateShield's outlook is " + M.outlook.blended[12].toFixed(2) + '%, consensus is 4.70% (gap ' + (M.outlook.gap[12] >= 0 ? '+' : '') + M.outlook.gap[12].toFixed(2) + ' pt).'), line);
  // names at least two live inputs (their values appear in the sentence)
  const liveValues = ['3.4%', '3.3%', '4.1%', '4.95%', '1.5%', '4.2%', '4.4%'];
  const named = liveValues.filter((v) => line.includes(v));
  assert.ok(named.length >= 2, 'names at least two live inputs: ' + line);
  assert.equal(M.outlook.drivers.length, 2);
  M.outlook.drivers.forEach((d) => assert.ok(line.includes(d.text)));
  assert.ok(line.includes('inflation falling from 4.2% to 3.4%') || line.includes('inflation at 3.4%'), line);
  // the sentence follows the inputs: a hot CPI print changes the drivers
  setVal(window, 'f-cpi', '9');
  const line2 = txt(window, 'outlook-diff');
  assert.notEqual(line2, line);
  assert.ok(line2.includes('9%'), line2);
  assert.deepEqual(errors, []);
});

test('3-month forecast error line renders from the forecast_error_summary view', () => {
  const { window, errors } = boot('manufacturing');
  assert.equal(txt(window, 'forecast-error-line'), '3-month forecast error: no scored meetings yet.');
  assert.equal(window.applyForecastErrors({ n_meetings: 0 }), false);
  assert.equal(window.applyForecastErrors({ n_meetings: 3, rateshield_mae: 0.21, market_mae: 0.17, consensus_mae: 0.3, consensus_n: 2, last_meeting: '2026-10-28' }), true);
  assert.equal(txt(window, 'forecast-error-line'), '3-month forecast error, last 3 meetings: RateShield 0.21 pt · Market 0.17 pt · Consensus 0.30 pt (2 of 3 had a consensus)');
  assert.equal(window.applyForecastErrors({ n_meetings: 1, rateshield_mae: 0.05, market_mae: 0.1, consensus_mae: null, consensus_n: 0 }), true);
  assert.equal(txt(window, 'forecast-error-line'), '3-month forecast error, last 1 meeting: RateShield 0.05 pt · Market 0.10 pt · Consensus — (0 of 1 had a consensus)');
  assert.equal(window.applyForecastErrors(null), false);
  assert.equal(txt(window, 'forecast-error-line'), '3-month forecast error: no scored meetings yet.');
  assert.deepEqual(errors, []);
});

test('rule: changing the consensus row leaves the blended and model values (and the forecast) unchanged; only display and gap move', () => {
  const { window, errors } = boot('manufacturing');
  const snap = () => { const M = window.RS_METRICS.forecast; return { score: M.score, pred: M.predicted12, blended: JSON.stringify(M.outlook.blended), model: JSON.stringify(M.outlook.model), market: JSON.stringify(M.outlook.market), rate: txt(window, 'pred-rate'), r6: txt(window, 'r6'), r12: txt(window, 'r12'), r18: txt(window, 'r18'), fomc: JSON.stringify(M.fomc) }; };
  const before = snap();
  [{ as_of: '2026-09-20', source: 'Bank note', m3: 3.9, m6: 4.2, m12: 4.7, m18: 4.7 },
   { as_of: '2026-09-21', source: 'CME FedWatch', m3: 0.25, m6: 0.25, m12: 0.25, m18: 0.25 },
   { as_of: '2026-09-21', source: 'StreetStats', m3: 9.5, m6: null, m12: 9.9, m18: null }].forEach((row) => {
    assert.equal(window.applyConsensus(row), true);
    window.updateAll();
    const after = snap();
    assert.equal(JSON.stringify(after), JSON.stringify(before), 'consensus ' + row.source + ' changed a forecast value');
    const M = window.RS_METRICS.forecast;
    assert.equal(M.outlook.consensus[12], row.m12, 'display reflects the row');
    if (row.m12 !== null) assert.ok(Math.abs(M.outlook.gap[12] - (M.outlook.blended[12] - row.m12)) < 1e-9, 'only the gap moves');
  });
  window.applyConsensus(null); window.updateAll();
  assert.equal(JSON.stringify(snap()), JSON.stringify(before));
  assert.deepEqual(errors, []);
});

test('rule: the functions reach only federalreserve.gov, FRED, Anthropic and Supabase; the page fetches only its own /api routes', () => {
  const fs = require('fs'), path = require('path');
  const apiDir = path.join(__dirname, '..', 'api');
  const allowed = ['www.federalreserve.gov', 'api.stlouisfed.org', 'api.anthropic.com', 'wfmhlmqsvcxaplwtdtjz.supabase.co', 'rateshieldai.com'];
  fs.readdirSync(apiDir).filter((f) => f.endsWith('.js')).forEach((f) => {
    const src = fs.readFileSync(path.join(apiDir, f), 'utf8');
    const hosts = Array.from(new Set((src.match(/https?:\/\/([a-zA-Z0-9.-]+)/g) || []).map((u) => u.replace(/^https?:\/\//, ''))));
    hosts.forEach((h) => assert.ok(allowed.includes(h), f + ' references ' + h));
    assert.ok(!/https?:\/\/[^\s'"`]*(cmegroup|bloomberg|reuters|wsj\.com|ft\.com|cnbc|news)/i.test(src), f + ' must never fetch bank, news or CME pages');
  });
  const page = fs.readFileSync(require('./helpers/loadApp').HTML_PATH, 'utf8');
  const targets = (page.match(/fetch\(\s*'([^']+)'/g) || []).map((m) => m.match(/'([^']+)'/)[1]);
  assert.ok(targets.length >= 4);
  targets.forEach((t) => assert.ok(t.startsWith('/api/'), 'page fetches ' + t));
  assert.ok(!/fetch\(\s*[`"]/.test(page), 'every page fetch uses a literal /api route');
});

test('owner controls: sign-out hides the consensus form and "Run brief now"; a consensus row with no numeric horizon is ignored (three series)', () => {
  const { window, errors } = boot('manufacturing');
  window.setOwnerUi('rajatinpa@gmail.com');
  assert.equal(window.document.getElementById('consensus-form').style.display, '');
  assert.equal(window.document.getElementById('run-brief-btn').style.display, '');
  window.supabase = null; // no session in tests; signOut must still hide the owner controls
  window.signOut();
  assert.equal(window.document.getElementById('consensus-form').style.display, 'none');
  assert.equal(window.document.getElementById('run-brief-btn').style.display, 'none');
  assert.equal(window.applyConsensus({ as_of: '2026-09-21', source: 'Bank note', m3: null, m6: null, m12: null, m18: null }), false);
  window.updateAll();
  assert.equal(window.outlookChart.data.datasets.length, 3);
  assert.equal(window.RS_METRICS.forecast.outlook.consensus, null);
  assert.ok(txt(window, 'outlook-diff').startsWith('No consensus path logged yet.'));
  assert.deepEqual(errors, []);
});

test('Outlook chart is a <canvas> in a fixed-height wrapper, created with the other charts, and the Chart stub holds three datasets on boot', () => {
  const { window, errors } = boot('manufacturing');
  const card = window.document.getElementById('rate-outlook');
  assert.equal(card.querySelectorAll('img').length, 0, 'no <img> anywhere in the card');
  const canvas = window.document.getElementById('outlookChart');
  assert.equal(canvas.tagName, 'CANVAS');
  const wrap = window.document.getElementById('outlook-chart-wrap');
  assert.equal(canvas.parentElement, wrap);
  assert.equal(wrap.style.height, '240px', 'the responsive chart has a sized container to fill');
  assert.ok(wrap.classList.contains('chart-wrap'));
  assert.ok(window.outlookChart, 'chart exists after boot');
  assert.equal(window.outlookChart.config.type, 'line');
  assert.equal(window.outlookChart.data.datasets.length, 3, 'blended, model, market — with no consensus row');
  window.outlookChart.data.datasets.forEach((d) => { assert.equal(d.data.length, 5); d.data.forEach((v) => assert.ok(typeof v === 'number' && isFinite(v), d.label + ' has a value at every horizon')); });
  // initCharts creates it in the shared lifecycle (before any render) and updateAll self-heals it
  window.outlookChart = null;
  window.initCharts();
  assert.ok(window.outlookChart, 'initCharts creates the outlook chart');
  window.updateAll();
  assert.equal(window.outlookChart.data.datasets.length, 3);
  window.outlookChart = null;
  window.updateAll();
  assert.ok(window.outlookChart && window.outlookChart.data.datasets.length === 3, 'updateAll rebuilds a missing outlook chart');
  assert.deepEqual(errors, []);
});
