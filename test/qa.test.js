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
  'sl-rev-h', 'sl-head', 'sl-sal', 'sl-hire', 'sl-debt', 'sl-cash',
  'sl-rev-ai', 'sl-margin', 'sl-labour', 'sl-rawmat', 'sl-fixed',
  'cd-cash', 'cd-opex', 'cd-buffer', 'cd-checking', 'cd-mmf', 'cd-tbill', 'cd-cd',
  'fed-slider', 'sl-debt-fixed-pct', 'sl-debt-fixed-rate',
  'sl-eq-price', 'sl-eq-output', 'sl-eq-vc', 'sl-eq-fc', 'sl-eq-elas'
];
const OUTPUT_IDS = ['pred-rate', 'sec-impact-text', 'hiring-result', 'ai-result', 'lr-total', 'lr-annual', 'lr-exposed',
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

test('negative margin renders without NaN and the simulator does not floor it to +2%', () => {
  const { window, errors } = boot('manufacturing');
  setVal(window, 'sl-margin', '-25');
  assert.deepEqual(badValues(window, 'neg-margin'), []);
  window.baselineMargin = -20;
  window.runScenario('recession');
  assert.ok(parseFloat(window.document.getElementById('sl-margin').value) < 0);
  assert.deepEqual(errors, []);
});
