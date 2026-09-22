// Vercel serverless function: POST /api/consensus
//
// Logs one owner-entered consensus Fed funds path to Supabase `consensus_paths`
// with the service-role key. Nothing is fetched from banks, news sites or CME —
// every number arrives typed by the owner (or derived in the browser from the
// FedWatch hike/cut percentages the owner typed).
//
// Auth: the same rule as /api/fed-brief — Authorization: Bearer $CRON_SECRET,
// or a Supabase session token that belongs to OWNER_EMAIL.

import { authorize, supabaseUrl, sbHeaders, isoDate, upsertForecastLog, LOG_HORIZONS } from './fed-brief.js';

export const HORIZONS = ['m3', 'm6', 'm12', 'm18'];
export const RATE_MIN = 0, RATE_MAX = 10;
export const SOURCE_MAX = 80, NOTE_MAX = 500;

// FedWatch box → expected rate at 3 months: current + 0.25 × (hike% − cut%) / 100.
export function fedWatchM3(currentRate, hikePct, cutPct) {
  const fin = (v) => typeof v === 'number' && isFinite(v);
  if (!fin(currentRate)) return null;
  const h = fin(hikePct) ? hikePct : 0, c = fin(cutPct) ? cutPct : 0;
  if (!fin(hikePct) && !fin(cutPct)) return null;
  return Math.round((currentRate + 0.25 * (h - c) / 100) * 1000) / 1000;
}

// Returns { ok: true, row } or { ok: false, problems: [...] }.
export function validateConsensus(body, today) {
  const problems = [];
  const b = body && typeof body === 'object' ? body : {};
  const asOf = String(b.as_of || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || isNaN(Date.parse(asOf + 'T00:00:00Z'))) problems.push('as_of must be a date (YYYY-MM-DD)');
  else if (asOf > today) problems.push('as_of cannot be in the future');
  const source = String(b.source || '').trim();
  if (!source) problems.push('source is required');
  else if (source.length > SOURCE_MAX) problems.push('source is too long (max ' + SOURCE_MAX + ')');
  const row = { as_of: asOf, source };
  let any = false;
  HORIZONS.forEach((h) => {
    const raw = b[h];
    if (raw === null || raw === undefined || raw === '') { row[h] = null; return; }
    const v = Number(raw);
    if (!isFinite(v)) { problems.push(h + ' must be a number'); return; }
    if (v < RATE_MIN || v > RATE_MAX) { problems.push(h + ' must be between ' + RATE_MIN + ' and ' + RATE_MAX + ' %'); return; }
    row[h] = Math.round(v * 100) / 100; any = true;
  });
  if (!any && !problems.some((p) => /must be/.test(p))) problems.push('enter at least one horizon (m3, m6, m12 or m18)');
  const note = b.note === null || b.note === undefined ? null : String(b.note).trim();
  if (note && note.length > NOTE_MAX) problems.push('note is too long (max ' + NOTE_MAX + ')');
  row.note = note || null;
  return problems.length ? { ok: false, problems } : { ok: true, row };
}

export async function insertConsensus(env, row, fetchImpl) {
  const res = await fetchImpl(supabaseUrl(env) + '/rest/v1/consensus_paths', {
    method: 'POST', headers: Object.assign(sbHeaders(env), { 'Prefer': 'return=representation' }), body: JSON.stringify(row)
  });
  if (!res.ok) throw new Error('Supabase write ' + res.status + ': ' + (await res.text()).slice(0, 200));
  const rows = await res.json();
  return Array.isArray(rows) ? rows[0] : rows;
}

// Mirror the logged path into forecast_log (consensus columns only, merged into
// whatever RateShield already wrote for that date). Never throws.
export async function logConsensusToForecastLog(env, row, fetchImpl, log) {
  try {
    const rows = LOG_HORIZONS.filter((h) => row['m' + h] !== null && row['m' + h] !== undefined)
      .map((h) => ({ log_date: row.as_of, horizon: h, consensus: Number(row['m' + h]), consensus_source: row.source, updated_at: new Date().toISOString() }));
    if (!rows.length) return null;
    await upsertForecastLog(env, rows, fetchImpl);
    return rows;
  } catch (e) { (log || console.log)('[consensus] forecast_log failed: ' + e.message); return null; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY is not configured' });
  const auth = await authorize(req, process.env, fetch);
  if (!auth.ok) return res.status(401).json({ error: 'Unauthorized', reason: auth.reason });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { return res.status(400).json({ error: 'Body must be JSON' }); } }
  const v = validateConsensus(body, isoDate(Date.now()));
  if (!v.ok) return res.status(400).json({ error: 'Invalid consensus path', problems: v.problems });
  try {
    const row = await insertConsensus(process.env, v.row, fetch);
    const logged = await logConsensusToForecastLog(process.env, row, fetch);
    return res.status(200).json({ ok: true, via: auth.via, row, forecastLogRows: logged ? logged.length : 0 });
  } catch (error) {
    console.error('[consensus] failed:', error);
    return res.status(500).json({ ok: false, error: error && error.message });
  }
}
