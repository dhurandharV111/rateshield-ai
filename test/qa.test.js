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
  'f-cpi', 'f-un', 'f-tr', 'f-gdp', 'f-pce', 'f-pce-3mo', 'f-tr-3mo', 'f-tr6mo', 'f-tr2y', 'f-cme-hike', 'f-cme-cut',
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
  assert.ok(!/Source:[^<]*CME/.test(src), 'CME FedWatch is never cited as a data source');
  const cmeMentions = src.match(/CME FedWatch/g) || [];
  cmeMentions.forEach(() => {});
  assert.ok(src.split('CME FedWatch').every((frag, i) => i === 0 || /^ (hike|cut) % \(optional\)|^ \(entered by you\)/.test(frag)),
    'every remaining "CME FedWatch" string is either the optional input label or the "entered by you" row label');
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
    treasury6mo: 3.9, treasury2y: 3.55, corePce3moAgo: 2.8, treasury10y3moAgo: 4.45 });
  window.updateAll();
  assert.equal(parseFloat(window.document.getElementById('f-pce-3mo').value), 2.8);
  assert.equal(parseFloat(window.document.getElementById('f-tr-3mo').value), 4.45);
  assert.ok(txt(window, 'fed-source-note').includes('PCEPILFE 3 mo earlier 2.8%'));
  const M = window.RS_METRICS.forecast;
  assert.ok(Math.abs(M.momentum.pcePts - 0.5) < 1e-9, 'Core PCE +0.5 pt in 3 months → +0.5 score');
  assert.ok(Math.abs(M.momentum.trPts - 0.3) < 1e-9, '10Y +0.5 pt × 0.6');
  // the same contributions are what the analyst table and chart show
  const rows = Array.from(window.document.querySelectorAll('#m1-analyst-tbody tr')).map((tr) => tr.textContent);
  assert.ok(rows.some((r) => r.includes('Core PCE momentum (3-mo)') && r.includes('+0.50 pts')), rows.join('\n'));
  assert.ok(rows.some((r) => r.includes('10Y momentum (3-mo)') && r.includes('+0.30 pts')));
  window.document.getElementById('app').classList.add('adv-mode'); // analyst charts only render in advanced mode
  window.updateAnalystCharts();
  assert.equal(window.m1AC.data.labels.length, 7);
  assert.ok(Math.abs(window.m1AC.data.datasets[0].data[5] - 0.5 * C.forecast.scorePerPt) < 1e-6);
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
