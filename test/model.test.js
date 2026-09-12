'use strict';
// Unit tests for every pure function in the Model block of index.html.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadModel } = require('./helpers/loadModel');

const { CONFIG, Model } = loadModel();
const SECTORS = ['manufacturing', 'technology', 'retail', 'restaurant', 'construction', 'healthcare', 'logistics', 'realestate', 'professional', 'consumer'];
const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `expected ${a} ≈ ${b}`);

test('Model block is pure — loads without any DOM globals', () => {
  assert.equal(typeof Model, 'object');
  assert.equal(typeof CONFIG, 'object');
});

test('CONFIG.rateSensitivity is stored as decimals for every sector', () => {
  SECTORS.forEach((s) => {
    const v = CONFIG.rateSensitivity[s];
    assert.equal(typeof v, 'number', s);
    assert.ok(v > 0 && v < 0.1, `${s}: ${v} must be a decimal like 0.025, not 2.5`);
  });
  assert.equal(CONFIG.rateSensitivity.retail, 0.015);
  assert.equal(CONFIG.rateSensitivity.realestate, 0.030);
  assert.equal(CONFIG.rateSensitivity.construction, 0.025);
});

test('Model.rateSensitivity falls back to default for unknown sector', () => {
  assert.equal(Model.rateSensitivity('nope'), CONFIG.rateSensitivity.default);
  assert.equal(Model.rateSensitivity('retail'), 0.015);
});

test('rateAdjustedVC: a 1-point Fed move with rsens 0.025 raises VC by exactly 2.5%', () => {
  const sector = 'construction'; // 0.025
  const vcNeutral = Model.rateAdjustedVC(100, CONFIG.neutralFedRate, sector);
  const vcPlus1 = Model.rateAdjustedVC(100, CONFIG.neutralFedRate + 1, sector);
  near(vcNeutral, 100);
  near(vcPlus1, 102.5);
  near(vcPlus1 / vcNeutral - 1, 0.025);
});

test('monthlyPayrollK', () => {
  near(Model.monthlyPayrollK(280, 48), 280 * 48 / 12);
  assert.equal(Model.monthlyPayrollK(0, 48), 0);
});

test('runwayMonths: cash ÷ burn; non-positive burn is unbounded; no cash is zero', () => {
  near(Model.runwayMonths(1.2, 100), 12);
  assert.equal(Model.runwayMonths(1.2, 0), Infinity);
  assert.equal(Model.runwayMonths(1.2, -50), Infinity);
  assert.equal(Model.runwayMonths(0, 100), 0);
  assert.ok(!Number.isNaN(Model.runwayMonths(NaN, 100)));
});

test('runwayForChart caps Infinity at CONFIG.runway.displayCap', () => {
  assert.equal(Model.runwayForChart(Infinity), CONFIG.runway.displayCap);
  assert.equal(Model.runwayForChart(4.26), 4.3);
});

test('monthlyNetBurnK = monthly costs − monthly revenue (costs = revenue × (1 − margin))', () => {
  // $20M revenue, 10% margin → costs $18M → burn = (18 − 20)/12 = −$166.7K/mo (generating cash)
  near(Model.monthlyNetBurnK(20, 10), (18000 - 20000) / 12);
  near(Model.monthlyNetBurnK(20, -5), (21000 - 20000) / 12); // loss year burns $83.3K/mo
  assert.equal(Model.monthlyNetBurnK(20, 0), 0);
});

test('payrollCoverageMonths = cash ÷ monthly payroll (liquidity buffer)', () => {
  near(Model.payrollCoverageMonths(1.2, 100), 12);
  assert.equal(Model.payrollCoverageMonths(1.2, 0), Infinity);
  assert.equal(Model.payrollCoverageMonths(0, 100), 0);
});

test('liquidity: a profitable business is cash-flow positive with unbounded runway, but finite payroll coverage', () => {
  const l = Model.liquidity({ cashM: 1.2, revenueM: 20, marginPct: 10, headcount: 280, salaryK: 48 });
  assert.equal(l.cashFlowPositive, true);
  assert.equal(l.runwayMonths, Infinity);
  near(l.monthlyPayrollK, 280 * 48 / 12);
  near(l.payrollCoverageMonths, 1200 / (280 * 48 / 12));
  near(l.monthlyRevenueK, 20000 / 12);
  near(l.monthlyCostsK, 18000 / 12);
});

test('liquidity: a loss-making business has runway = cash ÷ net burn, not cash ÷ payroll', () => {
  const l = Model.liquidity({ cashM: 1.2, revenueM: 20, marginPct: -5, headcount: 280, salaryK: 48 });
  assert.equal(l.cashFlowPositive, false);
  near(l.monthlyNetBurnK, 1000 / 12);
  near(l.runwayMonths, 1200 / (1000 / 12)); // 14.4 months
  assert.ok(l.runwayMonths > l.payrollCoverageMonths, 'net-burn runway must not be confused with payroll coverage');
});

test('liquidity: added hires raise costs and can turn a marginal business cash-negative', () => {
  const before = Model.liquidity({ cashM: 1.0, revenueM: 10, marginPct: 2, headcount: 100, salaryK: 60 });
  const after = Model.liquidity({ cashM: 1.0, revenueM: 10, marginPct: 2, headcount: 100, salaryK: 60, addedHeadcount: 10 });
  assert.equal(before.cashFlowPositive, true);
  assert.equal(after.cashFlowPositive, false); // +$600K payroll > $200K profit
  assert.ok(isFinite(after.runwayMonths));
  near(after.monthlyPayrollK, 110 * 60 / 12);
});

test('formatRunway / formatMonths', () => {
  assert.equal(Model.formatRunway(Infinity), 'Cash-flow positive');
  assert.equal(Model.formatRunway(4.26), '4.3 mo');
  assert.equal(Model.formatRunway(4.26, ''), '4.3');
  assert.equal(Model.formatMonths(Infinity), '∞');
  assert.equal(Model.formatMonths(7.04), '7');
});

test('aiSavings: labour cost = revenue × (1 − margin) × labour share; × sector automatable share', () => {
  const r = Model.aiSavings({ revenueM: 20, marginPct: 10, labourPctOfCosts: 30, sector: 'manufacturing' });
  near(r.totalCostsM, 18);
  near(r.labourCostM, 5.4);
  assert.equal(r.automatable, CONFIG.ai.automatableShare.manufacturing);
  near(r.savingsM, 5.4 * CONFIG.ai.automatableShare.manufacturing);
});

test('aiSavings: negative margin means costs exceed revenue (loss year) and still yields a finite number', () => {
  const r = Model.aiSavings({ revenueM: 20, marginPct: -25, labourPctOfCosts: 30, sector: 'retail' });
  near(r.totalCostsM, 25);
  assert.ok(isFinite(r.savingsM) && r.savingsM > 0);
});

test('aiSavings: labour-heavy but hard-to-automate sector is not over-credited', () => {
  const pro = Model.aiSavings({ revenueM: 20, marginPct: 10, labourPctOfCosts: 60, sector: 'professional' });
  const con = Model.aiSavings({ revenueM: 20, marginPct: 10, labourPctOfCosts: 60, sector: 'construction' });
  // same inputs — only the CONFIG per-sector share differs, never a labour-share proxy
  near(pro.savingsM / con.savingsM, CONFIG.ai.automatableShare.professional / CONFIG.ai.automatableShare.construction);
});

test('aiSavingsBreakdown: headline equals aiSavings and adds materials/overhead components', () => {
  const o = { revenueM: 20, marginPct: 10, labourPctOfCosts: 30, rawMatPctOfRevenue: 40, fixedPctOfCosts: 25, sector: 'manufacturing' };
  const b = Model.aiSavingsBreakdown(o);
  near(b.labourM, Model.aiSavings(o).savingsM);
  near(b.rawMatM, 20 * 0.4 * CONFIG.ai.rawMatSaveRate);
  near(b.fixedM, 18 * 0.25 * CONFIG.ai.fixedSaveRate);
});

test('safeHires: uses BOTH runway and rate environment', () => {
  const base = { planned: 20, sector: 'healthcare', annualPayrollK: 5000, annualProfitK: 0, salaryK: 50 };
  const lowLong = Model.safeHires(Object.assign({}, base, { env: 'low', runwayMonths: 12 }));
  const highLong = Model.safeHires(Object.assign({}, base, { env: 'high', runwayMonths: 12 }));
  const lowShort = Model.safeHires(Object.assign({}, base, { env: 'low', runwayMonths: 1 }));
  assert.ok(lowLong.safe > highLong.safe, 'high-rate environment must reduce safe hires');
  assert.ok(lowLong.safe > lowShort.safe, 'short runway must reduce safe hires');
  assert.equal(lowLong.runwayFactor, CONFIG.hiring.runway.safe);
  assert.equal(lowShort.runwayFactor, CONFIG.hiring.runway.danger);
  assert.equal(highLong.envFactor, CONFIG.hiring.envFactor.high);
});

test('safeHires: never exceeds the plan, never negative, risky = planned − safe', () => {
  const r = Model.safeHires({ planned: 15, runwayMonths: Infinity, env: 'low', sector: 'technology', annualPayrollK: 9216, annualProfitK: 5000, salaryK: 128 });
  assert.ok(r.safe >= 0 && r.safe <= 15);
  assert.equal(r.risky, 15 - r.safe);
  const z = Model.safeHires({ planned: 0, runwayMonths: 10, env: 'low', sector: 'technology' });
  assert.equal(z.safe, 0);
});

test('safeHires: profitability boost and profit-funded affordability', () => {
  const noProfit = Model.safeHires({ planned: 10, runwayMonths: 2, env: 'transition', sector: 'manufacturing', annualPayrollK: 10000, annualProfitK: 0, salaryK: 50 });
  const profit = Model.safeHires({ planned: 10, runwayMonths: 2, env: 'transition', sector: 'manufacturing', annualPayrollK: 10000, annualProfitK: 12000, salaryK: 50 });
  assert.equal(noProfit.profitBoost, CONFIG.hiring.profitCoverageBoostDefault);
  assert.equal(profit.profitBoost, 2.2);
  assert.ok(profit.safe >= noProfit.safe);
  assert.equal(profit.profitAffordable, Math.floor(12000 * CONFIG.hiring.profitHireShare / 50));
});

test('pricing: MR=MC with linear inverse demand reproduces textbook optimum', () => {
  // P = a − bQ through (price 100, output 1000) with elasticity 2 → b = 100/(1000·2) = 0.05, a = 150
  const r = Model.pricing({ price: 100, output: 1000, vc: 50, fc: 10000, elas: 2, vcAdj: 50 });
  near(r.b, 0.05); near(r.a, 150);
  near(r.optQ, (150 - 50) / (2 * 0.05)); // 1000
  near(r.optP, 150 - 0.05 * r.optQ);       // 100
  near(r.curProfit, 100 * 1000 - 50 * 1000 - 10000);
  near(r.gap, 0, 1e-6);
  near(r.lerner, (r.optP - 50) / r.optP);
  near(r.lernerMax, 0.5);
  assert.equal(r.breakEven, Math.ceil(10000 / 50));
});

test('pricing: optimal price never falls below variable cost; rate rises raise VC', () => {
  const lo = Model.pricing({ price: 10, output: 1000, vc: 9.5, fc: 100, elas: 5, fed: 2.5, sector: 'retail' });
  assert.ok(lo.optP >= lo.vcAdj);
  const hi = Model.pricing({ price: 10, output: 1000, vc: 9.5, fc: 100, elas: 5, fed: 7.5, sector: 'retail' });
  assert.ok(hi.vcAdj > lo.vcAdj);
});

test('isLm: higher rates reduce IS-equilibrium output and raise effective elasticity', () => {
  const lo = Model.isLm({ output: 8000, fedRate: 1, sector: 'construction', elas: 1.4, env: 'low' });
  const hi = Model.isLm({ output: 8000, fedRate: 7, sector: 'construction', elas: 1.4, env: 'high' });
  assert.ok(lo.yEquil > hi.yEquil);
  assert.ok(hi.isLmElas > lo.isLmElas);
  assert.ok(lo.sentScore > hi.sentScore);
  assert.ok(hi.sentScore >= CONFIG.pricing.sentiment.min && lo.sentScore <= CONFIG.pricing.sentiment.max);
  assert.equal(Model.isLm({ output: 1, fedRate: 3, sector: 'manufacturing', elas: 1 }).isDiscretionary, false);
  assert.equal(Model.isLm({ output: 1, fedRate: 3, sector: 'retail', elas: 1 }).isDiscretionary, true);
});

test('rateSignalScore / predictedRate / rateEnvironment: hot inflation raises the forecast, recession lowers it', () => {
  const hot = Model.rateSignalScore({ cpi: 6, un: 3.4, tr: 5.5, gdp: 4.5, pce: 4 });
  const cold = Model.rateSignalScore({ cpi: 1.5, un: 6.5, tr: 1.5, gdp: -1, pce: 1.5 });
  const neutral = Model.rateSignalScore({ cpi: 2.5, un: 4.5, tr: 3.5, gdp: 2, pce: 2 });
  assert.ok(hot > neutral && neutral > cold);
  assert.equal(hot, 10, 'maximum score when every signal is hot');
  assert.equal(Model.predictedRate(hot), Math.min(CONFIG.forecast.maxRate, Math.round((CONFIG.forecast.baseRate + 10 * CONFIG.forecast.scorePerPt) * 4) / 4));
  assert.equal(Model.predictedRate(cold), CONFIG.forecast.minRate);
  assert.equal(Model.predictedRate(20), CONFIG.forecast.maxRate, 'clamped at the ceiling');
  assert.equal(Model.predictedRate(neutral), CONFIG.forecast.baseRate);
  assert.equal(Model.rateEnvironment(hot), 'high');
  assert.equal(Model.rateEnvironment(cold), 'low');
  assert.equal(Model.rateEnvironment(neutral), 'transition');
  assert.equal(Model.predictedRate(1) % 0.25, 0, 'rounded to 25 bp');
});

test('nearestAnalog: an exact historical year matches itself at 100% with zero distance', () => {
  const y = CONFIG.analog.years.find((a) => a.year === 1995);
  const r = Model.nearestAnalog(y);
  assert.equal(r.best.year, 1995);
  assert.equal(r.best.distance, 0);
  assert.equal(r.best.matchPct, 100);
  assert.equal(r.ranked.length, CONFIG.analog.years.length);
  assert.ok(r.ranked[1].distance >= r.ranked[0].distance);
});

test('nearestAnalog: match % falls with distance; 2022-style inflation matches 2022', () => {
  const r = Model.nearestAnalog({ cpi: 7.5, un: 3.7, tr: 3.2, gdp: 2, pce: 5 });
  assert.equal(r.best.year, 2022);
  assert.ok(r.best.matchPct > 50 && r.best.matchPct < 100);
  const far = Model.nearestAnalog({ cpi: 30, un: 20, tr: 20, gdp: -10, pce: 30 });
  assert.ok(far.best.matchPct < 5);
});

test('forecastConfidence is bounded and decreases with analog distance', () => {
  const A = CONFIG.analog;
  assert.equal(Model.forecastConfidence(0), Math.min(A.confidenceMax, A.confidenceBase + A.confidenceSpan));
  assert.ok(Model.forecastConfidence(0.5) > Model.forecastConfidence(2));
  assert.equal(Model.forecastConfidence(100), A.confidenceBase);
  assert.ok(Model.forecastConfidence(0) <= A.confidenceMax);
});

test('fomcProbabilities: sums to 100, symmetric, and follows the predicted change', () => {
  const flat = Model.fomcProbabilities(3.75, 3.75);
  assert.equal(flat.hike + flat.hold + flat.cut, 100);
  assert.equal(flat.hike, flat.cut);
  assert.ok(flat.hold > flat.hike, 'no expected change → hold dominates');
  const cut = Model.fomcProbabilities(3.0, 3.75);
  assert.equal(cut.hike + cut.hold + cut.cut, 100);
  assert.ok(cut.cut > cut.hold && cut.cut > cut.hike, 'predicted −75 bp → cut most likely');
  const hike = Model.fomcProbabilities(4.5, 3.75);
  assert.ok(hike.hike > hike.cut);
  assert.equal(hike.cut, cut.hike, 'mirror image');
  const big = Model.fomcProbabilities(6.5, 3.75);
  assert.ok(big.hike > 90);
});

test('optimalPricing composes isLm + pricing and is finite for every sector', () => {
  SECTORS.forEach((s) => {
    const r = Model.optimalPricing({ price: 850, output: 8000, vc: 578, fc: 1700000, elas: 1.4, fed: 3.75, sector: s, env: 'transition' });
    ['optP', 'optQ', 'optProfit', 'curProfit', 'gap', 'lerner', 'vcAdj'].forEach((k) => assert.ok(isFinite(r[k]), `${s}.${k}`));
    assert.equal(r.statedElas, 1.4);
    near(r.elas, r.isLm.isLmElas);
  });
});
