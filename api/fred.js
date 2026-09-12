// Vercel serverless function: GET /api/fred
// Fetches the latest macro observations from the St. Louis Fed FRED API and
// returns a small snapshot the front end uses to pre-fill the Financing
// Strategy inputs. The API key lives in the FRED_API_KEY environment variable
// and is never sent to the browser.
//
// Series: FEDFUNDS (effective fed funds, %), CPIAUCSL (CPI index → YoY %),
// PCEPILFE (core PCE index → YoY %), UNRATE (%), GDP (nominal level → YoY %),
// DGS10 (10-year Treasury, %).

const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations';

// FRED encodes a missing daily value as ".". Return the latest numeric observation.
function latestValue(observations) {
  for (let i = 0; i < observations.length; i++) {
    const v = parseFloat(observations[i].value);
    if (isFinite(v)) return { value: v, date: observations[i].date };
  }
  return null;
}

// Year-over-year % change of an index/level series given observations sorted
// newest-first and the number of periods in a year (12 monthly, 4 quarterly).
function yoyPct(observations, periodsPerYear) {
  const nums = observations.map((o) => ({ v: parseFloat(o.value), d: o.date })).filter((o) => isFinite(o.v));
  if (nums.length <= periodsPerYear) return null;
  const latest = nums[0], prior = nums[periodsPerYear];
  if (!(prior.v > 0)) return null;
  return { value: (latest.v / prior.v - 1) * 100, date: latest.d };
}

// Turns raw per-series observation arrays into the snapshot the app consumes.
function buildSnapshot(series) {
  const ff = latestValue(series.FEDFUNDS || []);
  const un = latestValue(series.UNRATE || []);
  const tr = latestValue(series.DGS10 || []);
  const cpi = yoyPct(series.CPIAUCSL || [], 12);
  const pce = yoyPct(series.PCEPILFE || [], 12);
  const gdp = yoyPct(series.GDP || [], 4);
  const r2 = (x) => (x === null ? null : Math.round(x.value * 100) / 100);
  return {
    asOf: ff ? monthLabel(ff.date) : null,
    fedFunds: r2(ff),
    cpi: r2(cpi),
    corePce: r2(pce),
    unemployment: r2(un),
    gdpGrowth: r2(gdp),
    treasury10y: r2(tr),
    dates: { FEDFUNDS: ff && ff.date, CPIAUCSL: cpi && cpi.date, PCEPILFE: pce && pce.date, UNRATE: un && un.date, GDP: gdp && gdp.date, DGS10: tr && tr.date },
    notes: { gdpGrowth: 'Nominal GDP, year-over-year % change of the FRED GDP level series', cpi: 'CPIAUCSL year-over-year % change', corePce: 'PCEPILFE year-over-year % change' }
  };
}

function monthLabel(isoDate) {
  const d = new Date(isoDate + 'T00:00:00Z');
  if (isNaN(d.getTime())) return isoDate;
  return d.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

async function fetchSeries(id, limit, apiKey) {
  const url = `${FRED_BASE}?series_id=${encodeURIComponent(id)}&api_key=${encodeURIComponent(apiKey)}&file_type=json&sort_order=desc&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FRED ${id} ${res.status}`);
  const json = await res.json();
  return json.observations || [];
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'FRED_API_KEY is not configured' });
  try {
    const [FEDFUNDS, CPIAUCSL, PCEPILFE, UNRATE, GDP, DGS10] = await Promise.all([
      fetchSeries('FEDFUNDS', 3, apiKey),
      fetchSeries('CPIAUCSL', 14, apiKey),
      fetchSeries('PCEPILFE', 14, apiKey),
      fetchSeries('UNRATE', 3, apiKey),
      fetchSeries('GDP', 6, apiKey),
      fetchSeries('DGS10', 10, apiKey)
    ]);
    const snapshot = buildSnapshot({ FEDFUNDS, CPIAUCSL, PCEPILFE, UNRATE, GDP, DGS10 });
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json(snapshot);
  } catch (error) {
    return res.status(502).json({ error: 'Could not reach FRED', detail: error && error.message });
  }
}

export { latestValue, yoyPct, buildSnapshot, monthLabel };
