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

test('aiSavings: a scenario automatableMult raises the share, capped at CONFIG.ai.automatableCap', () => {
  const base = Model.aiSavings({ revenueM: 20, marginPct: 10, labourPctOfCosts: 40, sector: 'professional' });
  const boosted = Model.aiSavings({ revenueM: 20, marginPct: 10, labourPctOfCosts: 40, sector: 'professional', automatableMult: 1.5 });
  near(boosted.automatable, Math.min(CONFIG.ai.automatableCap, CONFIG.ai.automatableShare.professional * 1.5));
  assert.ok(boosted.savingsM > base.savingsM);
  near(boosted.savingsM / base.savingsM, 1.5);
  const capped = Model.aiSavings({ revenueM: 20, marginPct: 10, labourPctOfCosts: 40, sector: 'technology', automatableMult: 2 });
  assert.equal(capped.automatable, CONFIG.ai.automatableCap, '0.22 × 2 = 0.44 is capped at 0.35');
  assert.equal(Model.aiSavings({ revenueM: 20, marginPct: 10, labourPctOfCosts: 40, sector: 'retail', automatableMult: 0 }).automatableMult, 1, 'invalid multiplier ignored');
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

test('demandFactor: piecewise in GDP growth — ≥2 → 1.0, 0–2 linear 0.8–1.0, −2–0 linear 0.4–0.8, below −2 → 0.3', () => {
  near(Model.demandFactor(3), 1.0);
  near(Model.demandFactor(2), 1.0);
  near(Model.demandFactor(1), 0.9);
  near(Model.demandFactor(0), 0.8);
  near(Model.demandFactor(-1), 0.6);
  near(Model.demandFactor(-2), 0.4);
  near(Model.demandFactor(-2.5), 0.3);
  near(Model.demandFactor(undefined), 1.0, 1e-9);
  // continuous at the knots
  near(Model.demandFactor(1.999), Model.demandFactor(2), 1e-3);
  near(Model.demandFactor(-0.001), Model.demandFactor(0), 1e-3);
});

test('safeHires: weak demand reduces safe hires, and a contraction caps the rate-environment factor', () => {
  const base = { planned: 20, sector: 'manufacturing', annualPayrollK: 12000, annualProfitK: 1500, salaryK: 50, runwayMonths: Infinity };
  const expansion = Model.safeHires(Object.assign({}, base, { env: 'transition', gdpGrowth: 2.1 }));
  const recession = Model.safeHires(Object.assign({}, base, { env: 'low', gdpGrowth: -0.8 }));
  assert.equal(expansion.demandFactor, 1);
  near(recession.demandFactor, 0.64);
  assert.equal(recession.envCapped, true);
  assert.equal(recession.envFactor, CONFIG.hiring.contraction.envCap);
  assert.ok(recession.safe < expansion.safe, `recession ${recession.safe} < expansion ${expansion.safe}`);
  // mild slowdown (GDP 1.0) is not a contraction: env factor untouched, demand 0.9
  const slow = Model.safeHires(Object.assign({}, base, { env: 'low', gdpGrowth: 1.0 }));
  assert.equal(slow.envCapped, false);
  near(slow.demandFactor, 0.9);
  assert.ok(slow.combinedFactor < Model.safeHires(Object.assign({}, base, { env: 'low', gdpGrowth: 3 })).combinedFactor);
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
  const neutral = Model.rateSignalScore({ cpi: 2, un: 4.5, tr: 3.5, gdp: 2, pce: 2 });
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

test('rateSignalContributions: CPI and PCE are continuous and clamped; the score is their sum', () => {
  const at = (cpi, pce) => Model.rateSignalContributions({ cpi, pce, un: 4.5, tr: 3.5, gdp: 2 });
  near(at(2, 2).cpi, 0); near(at(2, 2).pce, 0);
  near(at(4, 2).cpi, 1.5);          // (4 − 2) × 0.75
  near(at(3, 3).pce, 0.75);
  near(at(10, 2).cpi, 3, 1e-9);     // clamped at +3
  near(at(-2, 2).cpi, -2, 1e-9);    // clamped at −2
  near(at(2, 6).pce, 1.5, 1e-9);    // clamped at +1.5
  near(at(2, -1).pce, -1.5, 1e-9);  // clamped at −1.5
  const c = Model.rateSignalContributions({ cpi: 3.35, pce: 3.34, un: 6.5, tr: 5.5, gdp: -1 });
  near(Model.rateSignalScore({ cpi: 3.35, pce: 3.34, un: 6.5, tr: 5.5, gdp: -1 }), c.cpi + c.pce + c.un + c.tr + c.gdp);
  assert.equal(c.un, -2); assert.equal(c.tr, 2); assert.equal(c.gdp, -3);
});

test('a 0.02-point change in CPI never moves the predicted rate by more than 0.25', () => {
  const others = { pce: 2.8, un: 4.2, tr: 4.3, gdp: 2.1 };
  let maxJump = 0;
  for (let cpi = 0; cpi <= 12; cpi = Math.round((cpi + 0.02) * 100) / 100) {
    const a = Model.predictedRate(Model.rateSignalScore(Object.assign({ cpi }, others)));
    const b = Model.predictedRate(Model.rateSignalScore(Object.assign({ cpi: cpi + 0.02 }, others)));
    maxJump = Math.max(maxJump, Math.abs(b - a));
    assert.ok(Math.abs(b - a) <= 0.25 + 1e-9, `CPI ${cpi} → ${cpi + 0.02}: jump ${Math.abs(b - a)}`);
  }
  assert.ok(maxJump <= 0.25);
  // and the same holds for core PCE
  for (let pce = 0; pce <= 8; pce = Math.round((pce + 0.02) * 100) / 100) {
    const a = Model.predictedRate(Model.rateSignalScore({ cpi: 3.2, pce, un: 4.2, tr: 4.3, gdp: 2.1 }));
    const b = Model.predictedRate(Model.rateSignalScore({ cpi: 3.2, pce: pce + 0.02, un: 4.2, tr: 4.3, gdp: 2.1 }));
    assert.ok(Math.abs(b - a) <= 0.25 + 1e-9, `PCE ${pce}`);
  }
});

test('nearestAnalog: an exact historical year matches itself at 100% with zero distance', () => {
  const y = CONFIG.analog.years.find((a) => a.year === 1995);
  const r = Model.nearestAnalog(y);
  assert.equal(r.best.year, 1995);
  assert.equal(r.best.distance, 0);
  assert.equal(r.best.matchPct, 100);
  assert.equal(r.ranked.length, Model.historicalEpisodes().length);
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

test('pricing guardrail: elasticity below CONFIG.pricing.minElasticity is floored so b cannot explode', () => {
  const tiny = Model.pricing({ price: 100, output: 1000, vc: 50, fc: 1000, elas: 0.05, vcAdj: 50 });
  const floor = Model.pricing({ price: 100, output: 1000, vc: 50, fc: 1000, elas: CONFIG.pricing.minElasticity, vcAdj: 50 });
  assert.equal(tiny.elasClamped, true);
  assert.equal(floor.elasClamped, false);
  near(tiny.b, floor.b);
  near(tiny.optP, floor.optP);
  assert.ok(isFinite(tiny.optP) && isFinite(tiny.optQ) && isFinite(tiny.gap));
  assert.ok(tiny.b < 100 / (1000 * 0.05), 'b is smaller than the unguarded value');
});

test('priceRange: low ≤ base ≤ high over elasticity ±band, and the deviation warning fires when far from current price', () => {
  const o = { price: 850, output: 8000, vc: 578, fc: 1700000, elas: 1.4, fed: 3.75, sector: 'manufacturing', env: 'transition' };
  const r = Model.optimalPricing(o);
  assert.ok(r.range.low <= r.range.base && r.range.base <= r.range.high);
  assert.equal(r.range.band, CONFIG.pricing.rangeBand);
  assert.equal(r.range.low, Math.min(r.range.low, r.range.high));
  // lower elasticity ⇒ higher optimal price, so the high end of the band comes from elas × 0.8
  const lowElas = Model.optimalPricing(Object.assign({}, o, { elas: 1.4 * 0.8 })).optP;
  near(r.range.high, Math.max(lowElas, r.range.base));
  // a price far below optimum triggers the warning; a price at optimum does not
  const far = Model.optimalPricing(Object.assign({}, o, { price: r.optP * 0.5 }));
  assert.equal(far.range.warn, true);
  assert.ok(far.range.deviation > CONFIG.pricing.warnDeviation);
  const nearOpt = Model.optimalPricing(Object.assign({}, o, { price: r.optP }));
  assert.equal(nearOpt.range.warn, false);
});

test('monthlyInterest is interest only: balance × rate ÷ 12', () => {
  near(Model.monthlyInterest(500000, 6.75), 500000 * 0.0675 / 12);
  assert.equal(Model.monthlyInterest(0, 6.75), 0);
});

test('amortisingPayment matches the standard annuity formula and edge cases', () => {
  // $100,000 at 6% over 10 years → $1,110.21/mo (textbook)
  near(Model.amortisingPayment(100000, 6, 10), 1110.205, 0.01);
  // $200,000 at 5% over 30 years → $1,073.64/mo
  near(Model.amortisingPayment(200000, 5, 30), 1073.64, 0.01);
  // zero rate ⇒ straight-line principal
  near(Model.amortisingPayment(120000, 0, 10), 1000);
  assert.equal(Model.amortisingPayment(0, 6, 10), 0);
  // amortising payment always exceeds interest-only for a positive rate
  assert.ok(Model.amortisingPayment(100000, 6, 10) > Model.monthlyInterest(100000, 6));
});

test('loanRates applies CONFIG.debt.spreads', () => {
  const r = Model.loanRates(3.75);
  near(r.prime, 6.75); near(r.sba, 9.5); near(r.sofr, 6.9); near(r.cre, 7.45); near(r.equip, 7.25);
});

test('priceRange: elasticity within 20% of the floor gives a one-sided band with an "indicative only" note', () => {
  const o = { price: 850, output: 8000, vc: 578, fc: 1700000, fed: 3.75, sector: 'manufacturing', env: 'transition' };
  const floorEdge = CONFIG.pricing.minElasticity * (1 + CONFIG.pricing.nearFloorBand); // 0.36
  const near = Model.optimalPricing(Object.assign({}, o, { elas: floorEdge })).range;
  assert.equal(near.oneSided, true);
  assert.equal(near.note, 'Elasticity near floor — range is indicative only');
  assert.equal(near.low, near.base);
  assert.ok(Math.abs(near.high - near.base * CONFIG.pricing.oneSidedHigh) < 1e-9);
  const below = Model.optimalPricing(Object.assign({}, o, { elas: 0.1 })).range;
  assert.equal(below.oneSided, true);
  const normal = Model.optimalPricing(Object.assign({}, o, { elas: floorEdge + 0.01 })).range;
  assert.equal(normal.oneSided, false);
  assert.equal(normal.note, null);
  assert.ok(normal.low < normal.base || normal.base < normal.high);
});

test('priceRange: low, base and high are never all equal for any elasticity > 0', () => {
  const inputs = [
    { price: 850, output: 8000, vc: 578, fc: 1700000, fed: 3.75, sector: 'manufacturing', env: 'transition' },
    { price: 10, output: 1000, vc: 9.99, fc: 10, fed: 7, sector: 'retail', env: 'high' },       // optimum pinned at cost floor
    { price: 185000, output: 135, vc: 132000, fc: 1500000, fed: 2, sector: 'realestate', env: 'low' }
  ];
  const elasticities = [0.05, 0.1, 0.3, 0.36, 0.37, 0.5, 0.8, 1.0, 1.4, 2.1, 3, 5];
  inputs.forEach((o) => elasticities.forEach((e) => {
    const r = Model.optimalPricing(Object.assign({}, o, { elas: e })).range;
    assert.ok(!(r.low === r.base && r.base === r.high), `elas ${e} / ${o.sector}: all equal (${r.low})`);
    assert.ok(r.low <= r.base && r.base <= r.high, `elas ${e}: ordering`);
    assert.ok(isFinite(r.low) && isFinite(r.high));
  }));
});

test('optimalPricing composes isLm + pricing and is finite for every sector', () => {
  SECTORS.forEach((s) => {
    const r = Model.optimalPricing({ price: 850, output: 8000, vc: 578, fc: 1700000, elas: 1.4, fed: 3.75, sector: s, env: 'transition' });
    ['optP', 'optQ', 'optProfit', 'curProfit', 'gap', 'lerner', 'vcAdj'].forEach((k) => assert.ok(isFinite(r[k]), `${s}.${k}`));
    assert.equal(r.statedElas, 1.4);
    near(r.elas, r.isLm.isLmElas);
  });
});

// ── Market-implied expectations (6-month Treasury vs Fed funds) ──────────────
test('marketImpliedMove: spreads are Treasury minus Fed funds; ±0.10 is the hold band', () => {
  const m = Model.marketImpliedMove(3.63, 3.90, 3.50);
  near(m.sixMonthSpread, 0.27); near(m.twoYearSpread, -0.13);
  assert.equal(m.direction, 'hike');
  assert.equal(Model.marketImpliedMove(3.63, 3.40, 3.2).direction, 'cut');
  assert.equal(Model.marketImpliedMove(3.63, 3.70, 3.7).direction, 'hold', '+0.07 is inside the band');
  assert.equal(Model.marketImpliedMove(3.63, 3.73, 3.7).direction, 'hold', 'exactly +0.10 is still hold');
  assert.equal(Model.marketImpliedMove(3.63, 3.74, 3.7).direction, 'hike');
  assert.equal(Model.marketImpliedMove(3.63, 3.52, 3.7).direction, 'cut', '−0.11 → cut');
  assert.equal(CONFIG.market.directionThreshold, 0.10);
  // missing inputs never produce NaN or a direction
  const missing = Model.marketImpliedMove(3.63, null, 3.5);
  assert.equal(missing.sixMonthSpread, null); assert.equal(missing.direction, null); near(missing.twoYearSpread, -0.13);
  assert.equal(Model.marketImpliedMove(undefined, 3.9, 3.5).sixMonthSpread, null);
});

test('marketProbabilities: logistic calibration (+0.25 ≈ 85% hike, 0 ≈ 60% hold, −0.25 ≈ 85% cut), sums to 100, monotone', () => {
  const up = Model.marketProbabilities(0.25), flat = Model.marketProbabilities(0), down = Model.marketProbabilities(-0.25);
  [up, flat, down].forEach((p) => assert.equal(p.hike + p.hold + p.cut, 100));
  assert.ok(Math.abs(up.hike - 85) <= 2, `+0.25 → hike ${up.hike}%`);
  assert.ok(Math.abs(flat.hold - 60) <= 2, `0 → hold ${flat.hold}%`);
  assert.equal(flat.hike, flat.cut, 'zero spread is symmetric');
  assert.ok(Math.abs(down.cut - 85) <= 2, `−0.25 → cut ${down.cut}%`);
  assert.equal(up.hike, down.cut, 'mirror image');
  let prev = Model.marketProbabilities(-1);
  for (let s = -0.95; s <= 1; s = Math.round((s + 0.05) * 100) / 100) {
    const p = Model.marketProbabilities(s);
    assert.ok(p.hike >= prev.hike && p.cut <= prev.cut, `monotone at ${s}`);
    prev = p;
  }
  assert.ok(Model.marketProbabilities(1).hike >= 99);
  assert.equal(Model.marketProbabilities(null), null);
  assert.equal(Model.marketProbabilities(NaN), null);
  assert.ok(CONFIG.market.logistic.midpoint > 0 && CONFIG.market.logistic.scale > 0, 'curve constants live in CONFIG.market');
});

test('fomcDirection picks the most likely outcome and the refactored fomcProbabilities still sums to 100', () => {
  assert.equal(Model.fomcDirection({ hike: 60, hold: 30, cut: 10 }), 'hike');
  assert.equal(Model.fomcDirection({ hike: 10, hold: 30, cut: 60 }), 'cut');
  assert.equal(Model.fomcDirection({ hike: 45, hold: 10, cut: 45 }), 'hold', 'tie → hold');
  assert.equal(Model.fomcDirection(null), null);
  for (let d = -2; d <= 2; d += 0.25) {
    const p = Model.fomcProbabilities(3.75 + d, 3.75);
    assert.equal(p.hike + p.hold + p.cut, 100, `sum at ${d}`);
  }
  assert.deepEqual(Model._pct100({ hike: 1, hold: 1, cut: 1 }).hike + Model._pct100({ hike: 1, hold: 1, cut: 1 }).hold + Model._pct100({ hike: 1, hold: 1, cut: 1 }).cut, 100);
});

// ── Momentum term ────────────────────────────────────────────────────────────
test('momentum3m: explicit delta wins, else now − 3-months-ago, else 0', () => {
  near(Model.momentum3m(3.3, 3.0), 0.3);
  near(Model.momentum3m(3.3, 3.0, -0.6), -0.6, 1e-12);
  assert.equal(Model.momentum3m(3.3, null), 0);
  assert.equal(Model.momentum3m(3.3, undefined), 0);
  assert.equal(Model.momentum3m(3.3, NaN), 0);
  assert.equal(Model.momentum3m(undefined, 3.0), 0);
});

test('rateSignalContributions: Core PCE momentum weight 1.0, 10Y momentum weight 0.6, both clamped to ±1.5, zero when the earlier value is missing', () => {
  const F = CONFIG.forecast;
  assert.equal(F.pce.momentumWeight, 1.0); assert.equal(F.tr.momentumWeight, 0.6); assert.equal(F.momentumClamp, 1.5);
  const base = { cpi: 3.4, un: 4.1, tr: 4.95, gdp: 1.5, pce: 3.3 };
  const none = Model.rateSignalContributions(base);
  assert.equal(none.pceMom, 0); assert.equal(none.trMom, 0);
  const up = Model.rateSignalContributions(Object.assign({}, base, { pce3mo: 2.8, tr3mo: 4.45 }));
  near(up.pceMom, 0.5, 1e-9);           // +0.5 pt over 3 months → +0.5 score
  near(up.trMom, 0.5 * 0.6, 1e-9);      // +0.5 pt × 0.6
  near(Model.rateSignalScore(Object.assign({}, base, { pce3mo: 2.8, tr3mo: 4.45 })) - Model.rateSignalScore(base), 0.5 + 0.3, 1e-9);
  const big = Model.rateSignalContributions(Object.assign({}, base, { pce3mo: 0.5, tr3mo: 1.0 }));
  assert.equal(big.pceMom, 1.5, 'clamped at +1.5'); assert.equal(big.trMom, 1.5, '3.95 × 0.6 = 2.37 → clamped at +1.5');
  const fall = Model.rateSignalContributions(Object.assign({}, base, { pce3mo: 6, tr3mo: 9 }));
  assert.equal(fall.pceMom, -1.5); assert.equal(fall.trMom, -1.5);
  // explicit 3-month deltas (backtest episodes) are honoured
  const ep = Model.rateSignalContributions(Object.assign({}, base, { pceMom3m: -0.6, trMom3m: 0.1 }));
  near(ep.pceMom, -0.6, 1e-9); near(ep.trMom, 0.06, 1e-9);
  // the switch used by the backtest
  const off = Model.rateSignalContributions(Object.assign({}, base, { pce3mo: 2.8, tr3mo: 4.45 }), { momentum: false });
  assert.equal(off.pceMom, 0); assert.equal(off.trMom, 0);
  near(Model.rateSignalScore(Object.assign({}, base, { pce3mo: 2.8 }), { momentum: false }), Model.rateSignalScore(base), 1e-9);
  // the score is still the sum of every contribution
  const c = Model.rateSignalContributions(Object.assign({}, base, { pce3mo: 2.8, tr3mo: 4.45 }));
  near(Model.rateSignalScore(Object.assign({}, base, { pce3mo: 2.8, tr3mo: 4.45 })), c.cpi + c.pce + c.un + c.tr + c.gdp + c.pceMom + c.trMom, 1e-9);
  // a 0.02 change in the 3-month-ago value never jumps the forecast by more than 25 bp
  for (let ago = 0; ago <= 8; ago = Math.round((ago + 0.02) * 100) / 100) {
    const a = Model.predictedRate(Model.rateSignalScore(Object.assign({}, base, { pce3mo: ago })));
    const b = Model.predictedRate(Model.rateSignalScore(Object.assign({}, base, { pce3mo: ago + 0.02 })));
    assert.ok(Math.abs(b - a) <= 0.25 + 1e-9, `pce3mo ${ago}`);
  }
});

// ── Scorekeeping: episodes without a 12-month outcome ───────────────────────
test('nearestAnalog only considers episodes with a realised 12-month outcome — today cannot be its own analog', () => {
  const y2026 = CONFIG.analog.years.find((y) => y.year === 2026);
  const r = Model.nearestAnalog(y2026);
  assert.notEqual(r.best.year, 2026);
  assert.ok(r.ranked.every((x) => x.year !== 2026));
  assert.equal(r.ranked.length, Model.historicalEpisodes().length);
  assert.ok(r.best.matchPct < 100, 'no trivial 100% self-match');
});

test('backtest scores 12-month and next-meeting episodes on separate boards', () => {
  const bt = Model.backtest();
  assert.equal(bt.total, 13);
  assert.ok(bt.rows.every((r) => r.year !== 2026), '2026 has no 12-month outcome → not on the 12-month board');
  assert.equal(bt.nextMeeting.total, 1);
  const r = bt.nextMeeting.rows[0];
  assert.equal(r.year, 2026);
  assert.equal(r.actualDir, 'up');
  assert.equal(r.predictedDir, { hike: 'up', cut: 'down', hold: 'hold' }[Model.fomcDirection(r.probs)]);
  assert.equal(r.hit, r.predictedDir === 'up');
  assert.ok(Math.abs(bt.nextMeeting.hitRate - bt.nextMeeting.hits / bt.nextMeeting.total) < 1e-12);
  // an episode with both outcomes would sit on both boards; one with neither on none
  const saved = CONFIG.analog.years;
  CONFIG.analog.years = [Object.assign({}, saved[0], { actualNextMeeting: -0.5 }), Object.assign({}, saved[1], { actualChange12m: null, actualNextMeeting: undefined })];
  const b2 = Model.backtest();
  assert.equal(b2.total, 1); assert.equal(b2.nextMeeting.total, 1); assert.equal(b2.nextMeeting.rows[0].actualDir, 'down');
  CONFIG.analog.years = saved;
});

test('headline CPI momentum: (cpi − cpi 3 mo ago) × 0.8, clamped ±1.5, zero when missing, and part of the score', () => {
  const F = CONFIG.forecast;
  assert.equal(F.cpi.momentumWeight, 0.8);
  const base = { cpi: 3.4, un: 4.1, tr: 4.95, gdp: 1.5, pce: 3.3 };
  assert.equal(Model.rateSignalContributions(base).cpiMom, 0);
  const up = Model.rateSignalContributions(Object.assign({}, base, { cpi3mo: 3.0 }));
  near(up.cpiMom, 0.4 * 0.8, 1e-9);
  near(Model.rateSignalScore(Object.assign({}, base, { cpi3mo: 3.0 })) - Model.rateSignalScore(base), 0.32, 1e-9);
  assert.equal(Model.rateSignalContributions(Object.assign({}, base, { cpi3mo: 0 })).cpiMom, 1.5, '3.4 × 0.8 = 2.72 → clamped');
  assert.equal(Model.rateSignalContributions(Object.assign({}, base, { cpi3mo: 9 })).cpiMom, -1.5);
  near(Model.rateSignalContributions(Object.assign({}, base, { cpiMom3m: -1.7 })).cpiMom, -1.36, 1e-9);
  assert.equal(Model.rateSignalContributions(Object.assign({}, base, { cpi3mo: 3.0 }), { momentum: false }).cpiMom, 0);
  const c = Model.rateSignalContributions(Object.assign({}, base, { cpi3mo: 3.0, pce3mo: 3.3, tr3mo: 4.4 }));
  near(Model.rateSignalScore(Object.assign({}, base, { cpi3mo: 3.0, pce3mo: 3.3, tr3mo: 4.4 })), c.cpi + c.pce + c.un + c.tr + c.gdp + c.cpiMom + c.pceMom + c.trMom, 1e-9);
  for (let ago = 0; ago <= 10; ago = Math.round((ago + 0.02) * 100) / 100) {
    const a = Model.predictedRate(Model.rateSignalScore(Object.assign({}, base, { cpi3mo: ago })));
    const b = Model.predictedRate(Model.rateSignalScore(Object.assign({}, base, { cpi3mo: ago + 0.02 })));
    assert.ok(Math.abs(b - a) <= 0.25 + 1e-9, `cpi3mo ${ago}`);
  }
});

// ── Fed stance from the daily brief ─────────────────────────────────────────
test('fedStanceContribution: score × 0.75, clamped ±1.5, zero when there is no brief', () => {
  const S = CONFIG.forecast.fedStance;
  assert.equal(S.weight, 0.75); assert.equal(S.clamp, 1.5);
  near(Model.fedStanceContribution(1.0), 0.75);
  near(Model.fedStanceContribution(-1.0), -0.75);
  assert.equal(Model.fedStanceContribution(2), 1.5);
  assert.equal(Model.fedStanceContribution(-2), -1.5);
  assert.equal(Model.fedStanceContribution(7), 1.5, 'out-of-range scores are clamped, never amplified');
  assert.equal(Model.fedStanceContribution(null), 0);
  assert.equal(Model.fedStanceContribution(undefined), 0);
  assert.equal(Model.fedStanceContribution(NaN), 0);
  const base = { cpi: 3.4, un: 4.1, tr: 4.95, gdp: 1.5, pce: 3.3 };
  assert.equal(Model.rateSignalContributions(base).fedStance, 0);
  near(Model.rateSignalScore(Object.assign({ fedStance: 1.5 }, base)) - Model.rateSignalScore(base), 1.125, 1e-9);
  const c = Model.rateSignalContributions(Object.assign({ fedStance: -0.8 }, base));
  near(Model.rateSignalScore(Object.assign({ fedStance: -0.8 }, base)), c.cpi + c.pce + c.un + c.tr + c.gdp + c.cpiMom + c.pceMom + c.trMom + c.fedStance, 1e-9);
  // the historical episodes carry no stance yet, so the backtest is unaffected
  CONFIG.analog.years.forEach((y) => assert.equal(Model.rateSignalContributions(y).fedStance, 0, y.year));
});

// ── Outlook paths ───────────────────────────────────────────────────────────
test('ratePath: the Rate path numbers (quarter-rounded), 3-month point = midpoint of now and 6 months', () => {
  const F = CONFIG.forecast, r = (v) => Math.round(v * 4) / 4;
  const score = 2.0, current = 3.63;
  const p = Model.ratePath({ current, score });
  const base = Model.predictedRate(score);
  assert.equal(p[0], current);
  assert.equal(p[12], r(base));
  assert.equal(p[6], r(base + F.path6));
  assert.equal(p[18], r(base + F.path18Up));
  assert.equal(p[3], r((current + p[6]) / 2));
  const neg = Model.ratePath({ current, score: -3 });
  assert.equal(neg[6], r(Model.predictedRate(-3) - F.path6));
  assert.equal(neg[18], r(Model.predictedRate(-3) + F.path18Down));
  assert.equal(JSON.stringify(Model.HORIZONS), '[0,3,6,12,18]');
});

test('marketPath: 6-month bill → 6-month point, 2-year note → 24-month point, others interpolated; null without the 6-month yield', () => {
  const p = Model.marketPath({ current: 3.63, dgs6mo: 4.03, dgs2: 4.39 });
  assert.equal(p[0], 3.63);
  assert.equal(p[3], 3.83);              // midpoint of 3.63 and 4.03
  assert.equal(p[6], 4.03);
  near(p[12], 4.03 + (4.39 - 4.03) * 6 / 18, 0.006);
  near(p[18], 4.03 + (4.39 - 4.03) * 12 / 18, 0.006);
  assert.equal(Model.marketPath({ current: 3.63, dgs6mo: null, dgs2: 4 }), null);
  assert.equal(Model.marketPath({ current: 3.63, dgs6mo: 3.9 })[18], 3.9, 'no 2-year → flat beyond 6 months');
});

test('blendedPath: market weighted more at short horizons; equals the model when no market path', () => {
  const W = CONFIG.blend.marketWeight;
  assert.ok(W[3] > W[6] && W[6] > W[12] && W[12] > W[18] && W[0] === 0);
  const model = { 0: 3.63, 3: 3.5, 6: 3.5, 12: 3.25, 18: 3.0 }, market = { 0: 3.63, 3: 3.83, 6: 4.03, 12: 4.15, 18: 4.27 };
  const b = Model.blendedPath(model, market);
  assert.equal(b[0], 3.63);
  near(b[3], (1 - W[3]) * 3.5 + W[3] * 3.83, 0.006);
  near(b[12], (1 - W[12]) * 3.25 + W[12] * 4.15, 0.006);
  [3, 6, 12, 18].forEach((h) => assert.ok(b[h] >= Math.min(model[h], market[h]) && b[h] <= Math.max(model[h], market[h]), 'blend lies between model and market at ' + h));
  assert.equal(JSON.stringify(Model.blendedPath(model, null)), JSON.stringify(model));
  const g = Model.consensusGap(b, { 0: 3.63, 3: 3.9, 6: null, 12: 4.7, 18: 4.7 });
  near(g[3], b[3] - 3.9, 1e-9); assert.equal(g[6], null); near(g[12], b[12] - 4.7, 1e-9); assert.equal(g[0], 0);
  assert.equal(JSON.stringify(Model.consensusGap(b, null)), JSON.stringify({ 0: null, 3: null, 6: null, 12: null, 18: null }));
});

test('outlookDifference: one sentence from the numbers naming the two largest contributors; no LLM, no "analysts"', () => {
  const inputs = { cpi: 3.4, un: 4.1, tr: 4.95, gdp: 1.5, pce: 3.3, cpi3mo: 4.2, pce3mo: 3.3, tr3mo: 4.4, fedStance: 1.5 };
  const c = Model.rateSignalContributions(inputs);
  const top = Model.topContributors(c, inputs, 2);
  assert.equal(top.length, 2);
  assert.ok(Math.abs(top[0].pts) >= Math.abs(top[1].pts), 'ordered by |contribution|');
  const keys = Object.keys(c).map((k) => ({ k, v: Math.abs(c[k]) })).sort((a, b) => b.v - a.v);
  assert.equal(top[0].key, keys[0].k); assert.equal(top[1].key, keys[1].k);
  const paths = { current: 3.63, blended: { 0: 3.63, 3: 3.7, 6: 3.75, 12: 4.1, 18: 4.2 }, model: { 0: 3.63, 3: 3.5, 6: 3.5, 12: 3.75, 18: 3.75 }, market: { 0: 3.63, 3: 3.83, 6: 4.03, 12: 4.15, 18: 4.27 } };
  const s1 = Model.outlookDifference(Object.assign({ consensus: { 0: 3.63, 3: 3.9, 6: null, 12: 4.7, 18: 4.7 }, consensusSource: 'Bank note', contributions: c, inputs, brief: { next_meeting_lean: 'hike', stance_score: 1.5 } }, paths));
  assert.ok(s1.startsWith("At 12 months RateShield's outlook is 4.10%, consensus is 4.70% (gap -0.60 pt). RateShield's model weights "), s1);
  assert.ok(s1.includes(top[0].text) && s1.includes(top[1].text), 'names both drivers');
  assert.ok(s1.endsWith("consensus is following the Fed's stated hawkish path."), s1);
  assert.ok(!/analyst/i.test(s1));
  // inflation falling is described from the live values, not a fixed string
  assert.ok(top.some((t) => t.key === 'cpiMom') ? s1.includes('inflation falling from 4.2% to 3.4%') : true);
  // consensus disagreeing with the Fed's stance is described as what it prices
  const s2 = Model.outlookDifference(Object.assign({ consensus: { 0: 3.63, 3: 3.4, 6: 3.2, 12: 3.0, 18: 3.0 }, consensusSource: 'CME FedWatch', contributions: c, inputs, brief: { next_meeting_lean: 'hike', stance_score: 1.5 } }, paths));
  assert.ok(s2.includes("consensus (CME FedWatch) is pricing a lower path than today's 3.63%"), s2);
  // no consensus → says so and still names the drivers
  const s3 = Model.outlookDifference(Object.assign({ consensus: null, contributions: c, inputs, brief: null }, paths));
  assert.ok(s3.startsWith("No consensus path logged yet. RateShield's 12-month outlook is 4.10% (model 3.75%, market 4.15%), driven by "), s3);
  // consensus without a 12-month value falls back to the next horizon that has one
  const s4 = Model.outlookDifference(Object.assign({ consensus: { 0: 3.63, 3: 3.9, 6: null, 12: null, 18: null }, consensusSource: 'FedWatch (manual)', contributions: c, inputs, brief: null }, paths));
  assert.ok(s4.startsWith('At 3 months RateShield\'s outlook is 3.70%, consensus is 3.90% (gap -0.20 pt).'), s4);
});

// ── Rules ───────────────────────────────────────────────────────────────────
test('rule: a consensus path never enters the score, the model path or the blend', () => {
  const base = { cpi: 3.4, un: 4.1, tr: 4.95, gdp: 1.5, pce: 3.3, cpi3mo: 4.2, pce3mo: 3.3, tr3mo: 4.4, fedStance: 1.5 };
  const withCons = Object.assign({ consensus: { 3: 0.5, 6: 0.5, 12: 0.5, 18: 0.5 }, m12: 0.5, consensusPath: 0.5 }, base);
  assert.equal(Model.rateSignalScore(withCons), Model.rateSignalScore(base));
  assert.equal(JSON.stringify(Model.rateSignalContributions(withCons)), JSON.stringify(Model.rateSignalContributions(base)));
  assert.ok(!('consensus' in Model.rateSignalContributions(base)), 'no consensus contribution key exists');
  const model = Model.ratePath({ current: 3.63, score: 2, consensus: { 12: 0.5 } });
  assert.equal(JSON.stringify(model), JSON.stringify(Model.ratePath({ current: 3.63, score: 2 })));
  const market = Model.marketPath({ current: 3.63, dgs6mo: 4.03, dgs2: 4.39 });
  assert.equal(JSON.stringify(Model.blendedPath(model, market, { 12: 0.5 })), JSON.stringify(Model.blendedPath(model, market)), 'a third argument is ignored');
  assert.equal(Model.blendedPath.length, 2, 'blendedPath takes exactly model and market');
  assert.equal(Model.ratePath.length, 1);
  assert.ok(!/consensus/i.test(Model.rateSignalScore.toString() + Model.rateSignalContributions.toString() + Model.ratePath.toString() + Model.blendedPath.toString() + Model.marketPath.toString()),
    'no forecast function mentions consensus');
});

test('Fed-stance floor: with stance ≥ +1.0 no model horizon is below the current rate; one shared function', () => {
  assert.equal(CONFIG.outlook.floorStance, 1.0);
  // today's case: stance +1.2, current 3.88, a score that would otherwise put the path at 3.50
  const inputs = { cpi: 3.4, un: 4.1, tr: 4.95, gdp: 1.5, pce: 3.3, fedStance: 1.2 };
  const score = Model.rateSignalScore(inputs);
  const raw = Model.ratePath({ current: 3.88, score });
  assert.ok([6, 12, 18].some((h) => raw[h] < 3.88), 'unfloored path dips below the current rate (the bug)');
  const floored = Model.ratePath({ current: 3.88, score, fedStance: 1.2 });
  [3, 6, 12, 18].forEach((h) => assert.ok(floored[h] >= 3.88, 'horizon ' + h + ' = ' + floored[h] + ' ≥ 3.88'));
  assert.equal(floored[0], 3.88);
  assert.equal(Model.stanceFloorBinds({ current: 3.88, score, fedStance: 1.2 }), true);
  assert.equal(Model.stanceFloorNote({ current: 3.88, score, fedStance: 1.2 }), 'Model path floored at current rate — Fed stance hawkish (+1.2)');
  // below the threshold, or with no brief, nothing changes
  assert.equal(JSON.stringify(Model.ratePath({ current: 3.88, score, fedStance: 0.99 })), JSON.stringify(raw));
  assert.equal(JSON.stringify(Model.ratePath({ current: 3.88, score, fedStance: null })), JSON.stringify(raw));
  assert.equal(Model.stanceFloorNote({ current: 3.88, score, fedStance: 0.5 }), '');
  // the floor never lowers a horizon that is already above the current rate
  const hot = Model.rateSignalScore({ cpi: 8, un: 3.4, tr: 5.5, gdp: 4.5, pce: 5, fedStance: 2 });
  assert.equal(JSON.stringify(Model.ratePath({ current: 3.88, score: hot, fedStance: 2 })), JSON.stringify(Model.ratePath({ current: 3.88, score: hot })));
  assert.equal(Model.stanceFloorBinds({ current: 3.88, score: hot, fedStance: 2 }), false, 'applies but does not bind → no note');
  // exactly +1.0 applies
  assert.equal(Model.stanceFloorApplies(1.0), true); assert.equal(Model.stanceFloorApplies(0.999), false);
  // and the blend inherits the floored model path
  const market = Model.marketPath({ current: 3.88, dgs6mo: 4.05, dgs2: 4.4 });
  const b = Model.blendedPath(floored, market);
  [3, 6, 12, 18].forEach((h) => assert.ok(b[h] >= 3.88, 'blended ' + h));
});
