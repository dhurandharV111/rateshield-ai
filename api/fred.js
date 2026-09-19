// Vercel serverless function: GET /api/fred
// Fetches the latest macro observations from the St. Louis Fed FRED API and
// returns a small snapshot the front end uses to pre-fill the Financing
// Strategy inputs. The API key lives in the FRED_API_KEY environment variable
// and is never sent to the browser.
//
// Series (all values are used directly as returned by FRED — nothing is
// re-derived here):
//   DFF             effective federal funds rate, % (DAILY). The monthly FEDFUNDS
//                   average lags a mid-month FOMC move by up to five weeks, so the
//                   "current rate" is the latest daily observation instead. The
//                   observation date travels with it (fedFundsDate) and a value
//                   older than STALE_DAYS is flagged in `warnings`.
//   CPIAUCSL        CPI, requested with units=pc1 → year-over-year % change
//   PCEPILFE        core PCE price index, units=pc1 → year-over-year % change
//   UNRATE          unemployment rate, %
//   A191RL1Q225SBEA real GDP, % change from preceding period, seasonally
//                   adjusted annual rate (quarterly) — NOT the nominal GDP level
//   DGS10           10-year Treasury constant-maturity yield, % (daily)
//   DGS6MO          6-month Treasury constant-maturity yield, % (daily) — the
//                   market's pricing of the policy rate over the next two meetings
//   DGS2            2-year Treasury constant-maturity yield, % (daily)
//
// Momentum: for CPIAUCSL (yoy), PCEPILFE (yoy) and DGS10 the snapshot also
// carries the value observed 3 months before the latest observation (cpi3moAgo,
// corePce3moAgo, treasury10y3moAgo), read from the same observation window — nothing is
// interpolated. If no observation exists on or before that date, the field is
// null and the app treats momentum as zero.

const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations';

export const SERIES = {
  fedFunds:     { id: 'DFF',             units: 'lin', limit: 10 },
  cpi:          { id: 'CPIAUCSL',        units: 'pc1', limit: 6 },
  corePce:      { id: 'PCEPILFE',        units: 'pc1', limit: 6 },
  unemployment: { id: 'UNRATE',          units: 'lin', limit: 3 },
  gdpGrowth:    { id: 'A191RL1Q225SBEA', units: 'lin', limit: 3 },
  treasury10y:  { id: 'DGS10',           units: 'lin', limit: 110 },
  treasury6mo:  { id: 'DGS6MO',          units: 'lin', limit: 10 },
  treasury2y:   { id: 'DGS2',            units: 'lin', limit: 10 }
};

export const CORE_PCE_VS_CPI_MAX_GAP = 1.0;
// A "current" policy rate older than this many days is stale (DFF is published daily).
export const STALE_DAYS = 7;

export function daysBetween(isoA, isoB) {
  const a = new Date(isoA + 'T00:00:00Z'), b = new Date(isoB + 'T00:00:00Z');
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return null;
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

// Plausibility bounds. A value outside its bound is dropped (null) so the app
// falls back to its CONFIG snapshot, and the reason is reported in `warnings`.
export const SANITY = {
  fedFunds: [0, 25], cpi: [-5, 25], corePce: [-5, 25], unemployment: [0, 30],
  gdpGrowth: [-10, 8], treasury10y: [0, 25], treasury6mo: [0, 25], treasury2y: [0, 25]
};

// FRED encodes a missing daily value as ".". Return the latest numeric observation.
export function latestValue(observations) {
  for (let i = 0; i < (observations || []).length; i++) {
    const v = parseFloat(observations[i].value);
    if (isFinite(v)) return { value: v, date: observations[i].date };
  }
  return null;
}

// Series whose value 3 months before the latest observation is also reported.
export const MOMENTUM = { cpi: 'cpi3moAgo', corePce: 'corePce3moAgo', treasury10y: 'treasury10y3moAgo' };
export const MOMENTUM_MONTHS = 3;

// ISO date shifted back by `months` calendar months (day clamped to the month).
export function shiftMonths(isoDate, months) {
  const d = new Date(isoDate + 'T00:00:00Z');
  if (isNaN(d.getTime())) return null;
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}

// Latest numeric observation on or before `months` months prior to `latestDate`
// (observations are newest-first, as FRED returns them with sort_order=desc).
export function valueMonthsAgo(observations, latestDate, months) {
  const target = shiftMonths(latestDate, months);
  if (!target) return null;
  for (let i = 0; i < (observations || []).length; i++) {
    const o = observations[i];
    if (o.date > target) continue;
    const v = parseFloat(o.value);
    if (isFinite(v)) return { value: v, date: o.date };
  }
  return null;
}

export function monthLabel(isoDate) {
  const d = new Date(isoDate + 'T00:00:00Z');
  if (isNaN(d.getTime())) return isoDate;
  return d.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

// Turns raw per-series observation arrays (keyed by FRED series id) into the
// snapshot the app consumes: latest value of each series, rounded to 2 dp,
// with out-of-bounds values nulled and explained.
export function buildSnapshot(raw, now) {
  const out = { dates: {}, warnings: [], raw: {} };
  const today = now || new Date().toISOString().slice(0, 10);
  Object.keys(SERIES).forEach((key) => {
    const s = SERIES[key];
    // Echo exactly what FRED returned (series id, units requested, last observations)
    // so any value on screen can be traced back without guessing.
    out.raw[key] = { series: s.id, units: s.units, observations: (raw[s.id] || []).slice(0, 3).map((o) => ({ date: o.date, value: o.value })) };
    const latest = latestValue(raw[s.id]);
    if (!latest) { out[key] = null; out.dates[s.id] = null; return; }
    const [lo, hi] = SANITY[key];
    if (latest.value < lo || latest.value > hi) {
      out[key] = null;
      out.warnings.push(`${s.id} value ${latest.value} on ${latest.date} is outside the sanity bound [${lo}, ${hi}] and was ignored`);
    } else {
      out[key] = Math.round(latest.value * 100) / 100;
    }
    out.dates[s.id] = latest.date;
    if (MOMENTUM[key]) {
      const ago = valueMonthsAgo(raw[s.id], latest.date, MOMENTUM_MONTHS);
      out[MOMENTUM[key]] = ago ? Math.round(ago.value * 100) / 100 : null;
      out.dates[s.id + '_3mo'] = ago ? ago.date : null;
    }
  });
  // Cross-check: core PCE normally runs at or below headline CPI. A gap of more than
  // CORE_PCE_VS_CPI_MAX_GAP points is flagged (not dropped) so it can be investigated.
  if (out.corePce !== null && out.cpi !== null && out.corePce - out.cpi > CORE_PCE_VS_CPI_MAX_GAP) {
    out.warnings.push(`PCEPILFE (core PCE, ${out.corePce}%) exceeds CPIAUCSL (headline CPI, ${out.cpi}%) by more than ${CORE_PCE_VS_CPI_MAX_GAP} pt — check raw.corePce`);
  }
  // The current rate is the latest DAILY observation; expose its exact date.
  out.fedFundsDate = out.dates.DFF || null;
  out.asOf = out.fedFundsDate; // ISO date, e.g. "2026-09-18" — shown next to the rate
  out.fedFundsAgeDays = out.fedFundsDate ? daysBetween(out.fedFundsDate, today) : null;
  if (out.fedFundsAgeDays !== null && out.fedFundsAgeDays > STALE_DAYS) {
    out.warnings.push(`DFF observation ${out.fedFundsDate} is ${out.fedFundsAgeDays} days old — current rate may be stale`);
  }
  out.notes = {
    fedFunds: 'DFF — effective federal funds rate, daily, latest observation (not the monthly FEDFUNDS average)',
    gdpGrowth: 'A191RL1Q225SBEA — real GDP, % change from preceding period, SAAR (used as reported)',
    cpi: 'CPIAUCSL with units=pc1 — year-over-year % change (computed by FRED)',
    corePce: 'PCEPILFE with units=pc1 — year-over-year % change (computed by FRED)',
    cpi3moAgo: 'CPIAUCSL (pc1) observation ' + MOMENTUM_MONTHS + ' months before the latest one — used for the momentum term',
    corePce3moAgo: 'PCEPILFE (pc1) observation ' + MOMENTUM_MONTHS + ' months before the latest one — used for the momentum term',
    treasury10y3moAgo: 'DGS10 observation on or before ' + MOMENTUM_MONTHS + ' months before the latest one — used for the momentum term'
  };
  return out;
}

export function seriesUrl(s, apiKey) {
  return `${FRED_BASE}?series_id=${encodeURIComponent(s.id)}&units=${s.units}&api_key=${encodeURIComponent(apiKey)}&file_type=json&sort_order=desc&limit=${s.limit}`;
}

async function fetchSeries(s, apiKey) {
  const res = await fetch(seriesUrl(s, apiKey));
  if (!res.ok) throw new Error(`FRED ${s.id} ${res.status}`);
  const json = await res.json();
  return json.observations || [];
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'FRED_API_KEY is not configured' });
  try {
    const keys = Object.keys(SERIES);
    const results = await Promise.all(keys.map((k) => fetchSeries(SERIES[k], apiKey)));
    const raw = {};
    keys.forEach((k, i) => { raw[SERIES[k].id] = results[i]; });
    // Server-side trace of the core PCE fetch (visible in Vercel → Logs).
    console.log('[fred] PCEPILFE units=pc1 raw observations:', JSON.stringify((raw.PCEPILFE || []).slice(0, 3)));
    console.log('[fred] CPIAUCSL units=pc1 raw observations:', JSON.stringify((raw.CPIAUCSL || []).slice(0, 3)));
    const snapshot = buildSnapshot(raw);
    if (snapshot.warnings.length) console.warn('[fred] warnings:', snapshot.warnings.join(' | '));
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json(snapshot);
  } catch (error) {
    return res.status(502).json({ error: 'Could not reach FRED', detail: error && error.message });
  }
}
