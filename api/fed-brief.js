// Vercel serverless function: GET|POST /api/fed-brief
//
// Daily Fed briefing. Reads the Federal Reserve's own RSS feeds (press releases,
// FOMC/monetary-policy releases, speeches, testimony) and the FOMC calendar page —
// official federalreserve.gov URLs only — plus the live FRED snapshot, asks the
// Anthropic API for a strict-JSON stance assessment, validates it, and writes one
// row per day to Supabase `fed_briefs` with the service-role key.
//
// Rules:
//   • Items are those published since the last brief (30 days on the first run).
//   • No new items → copy the previous brief forward with today's date, sources
//     = [], and no Anthropic call.
//   • Unparseable / invalid model answer → log it and copy the previous brief
//     forward (the sources are still recorded so the failure can be inspected).
//   • The endpoint requires `Authorization: Bearer ${CRON_SECRET}` (Vercel adds
//     this header to cron invocations) — or a Supabase session token belonging
//     to the owner email, for the manual "Run brief now" button.
//
// Env: ANTHROPIC_API_KEY, FRED_API_KEY, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET,
//      optional SUPABASE_URL and OWNER_EMAIL (defaults below).

import { fetchSnapshot } from './fred.js';

export const FED_ORIGIN = 'https://www.federalreserve.gov/';
export const FEEDS = [
  { key: 'press',     url: 'https://www.federalreserve.gov/feeds/press_all.xml' },
  { key: 'fomc',      url: 'https://www.federalreserve.gov/feeds/press_monetary.xml' },
  { key: 'speeches',  url: 'https://www.federalreserve.gov/feeds/speeches.xml' },
  { key: 'testimony', url: 'https://www.federalreserve.gov/feeds/testimony.xml' }
];
export const FOMC_CALENDAR_URL = 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm';
export const DEFAULT_SUPABASE_URL = 'https://wfmhlmqsvcxaplwtdtjz.supabase.co';
export const DEFAULT_OWNER_EMAIL = 'rajatinpa@gmail.com';
export const MODEL = 'claude-opus-5';
export const BODY_CHARS = 1500;      // characters of each statement body sent to the model
export const FIRST_RUN_DAYS = 30;    // look-back when there is no previous brief
export const MAX_ITEMS = 12;         // newest items considered per run
export const STANCE_MIN = -2, STANCE_MAX = 2;
export const LEANS = ['hike', 'hold', 'cut'];

// ── Small pure helpers ───────────────────────────────────────────────────────
export function isOfficial(url) { return typeof url === 'string' && url.startsWith(FED_ORIGIN); }
export function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
export function isoDate(d) { return new Date(d).toISOString().slice(0, 10); }
export function daysAgo(isoDay, n) { const d = new Date(isoDay + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); }
export function fmtShort(isoDay) {
  const d = new Date(isoDay + 'T00:00:00Z');
  return isNaN(d.getTime()) ? String(isoDay) : d.getUTCDate() + ' ' + d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
}

const decode = (s) => String(s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

export function stripHtml(html) {
  return decode(String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|li|h\d|tr|br)>/gi, '\n').replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

// Minimal RSS 2.0 / Atom reader — enough for the Fed's feeds, no dependency.
export function parseRss(xml) {
  const src = String(xml || '');
  const blocks = src.match(/<item\b[\s\S]*?<\/item>|<entry\b[\s\S]*?<\/entry>/gi) || [];
  const tag = (block, name) => { const m = block.match(new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + name + '>', 'i')); return m ? decode(m[1]).trim() : ''; };
  const items = blocks.map((b) => {
    let link = tag(b, 'link');
    if (!link) { const href = b.match(/<link\b[^>]*href=["']([^"']+)["']/i); link = href ? decode(href[1]) : ''; }
    const when = tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date');
    const t = Date.parse(when);
    return { title: tag(b, 'title'), link: link.trim(), published: isFinite(t) ? new Date(t).toISOString() : null,
             description: stripHtml(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content')).slice(0, 600) };
  }).filter((it) => it.title && isOfficial(it.link));
  const seen = new Set();
  return items.filter((it) => { if (seen.has(it.link)) return false; seen.add(it.link); return true; })
    .sort((a, b) => String(b.published).localeCompare(String(a.published)));
}

// The main text of a federalreserve.gov press release / speech page.
export function extractArticle(html) {
  const src = String(html || '');
  const m = src.match(/<div[^>]+id=["']article["'][^>]*>([\s\S]*?)<div[^>]+class=["'][^"']*(?:lastUpdate|footer)[^"']*["']/i)
    || src.match(/<div[^>]+id=["']article["'][^>]*>([\s\S]*)/i)
    || src.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  return stripHtml(m ? m[1] : src).slice(0, BODY_CHARS);
}

// Next scheduled FOMC meeting from the calendar page. The page lists each year
// as "<YYYY> FOMC Meetings" followed by month / date blocks such as
// <div class="fomc-meeting__month"><strong>September</strong></div>
// <div class="fomc-meeting__date">15-16</div>. Two-day meetings end on the
// second day; "Apr/May" style months end in the second month. Returns the ISO
// date of the meeting's last day on or after `today`, or null if nothing parses.
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
export function parseFomcCalendar(html, today) {
  const src = String(html || '');
  const years = [];
  const yearRe = /(\d{4})\s+FOMC\s+Meetings/gi; let ym;
  while ((ym = yearRe.exec(src))) years.push({ idx: ym.index, year: parseInt(ym[1], 10) });
  if (!years.length) return null;
  const meetings = [];
  const re = /fomc-meeting__month[^>]*>\s*(?:<strong>)?\s*([A-Za-z]+)(?:\s*\/\s*([A-Za-z]+))?[\s\S]*?fomc-meeting__date[^>]*>\s*([^<]*)/gi; let m;
  while ((m = re.exec(src))) {
    const year = years.filter((y) => y.idx < m.index).pop();
    if (!year) continue;
    const monthKey = (m[2] || m[1]).toLowerCase().slice(0, 4).replace(/[^a-z]/g, '');
    const month = MONTHS[monthKey] !== undefined ? MONTHS[monthKey] : MONTHS[monthKey.slice(0, 3)];
    const days = (m[3].match(/\d{1,2}/g) || []).map(Number);
    if (month === undefined || !days.length) continue; // e.g. "(unscheduled)" rows
    // `month` is already the second month for "Apr/May"-style entries, so the last day listed belongs to it.
    const d = new Date(Date.UTC(year.year, month, days[days.length - 1]));
    if (!isNaN(d.getTime())) meetings.push(d.toISOString().slice(0, 10));
  }
  meetings.sort();
  return meetings.find((d) => d >= today) || null;
}

// ── Validation of the model's answer ─────────────────────────────────────────
export const BRIEF_SCHEMA = {
  type: 'object',
  properties: {
    stance_score: { type: 'number', description: 'Fed policy stance: -2 very dovish (cuts imminent) … 0 balanced … +2 very hawkish (hikes likely)' },
    next_meeting_lean: { type: 'string', enum: LEANS, description: 'Most likely decision at the next scheduled FOMC meeting' },
    next_meeting_date: { type: 'string', description: 'ISO date (YYYY-MM-DD) of the next scheduled FOMC meeting' },
    summary: { type: 'string', description: 'At most two sentences, plain English, for a business owner' },
    key_phrases: { type: 'array', items: { type: 'string' }, description: 'Up to 8 short quoted phrases from the Fed communications that drove the score' },
    confidence: { type: 'number', description: '0..1 confidence in the stance score' }
  },
  required: ['stance_score', 'next_meeting_lean', 'next_meeting_date', 'summary', 'key_phrases', 'confidence'],
  additionalProperties: false
};

export function twoSentences(text) {
  const parts = String(text || '').replace(/\s+/g, ' ').trim().match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) || [];
  return parts.slice(0, 2).join('').trim();
}

// Returns { ok: true, brief } for a usable answer, { ok: false, problems } otherwise.
export function validateBrief(raw, ctx = {}) {
  const problems = [];
  let obj = raw;
  if (typeof obj === 'string') { try { obj = JSON.parse(obj); } catch (e) { return { ok: false, problems: ['not JSON: ' + e.message] }; } }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, problems: ['answer is not an object'] };
  const score = Number(obj.stance_score);
  if (!isFinite(score)) problems.push('stance_score missing or not a number');
  const lean = String(obj.next_meeting_lean || '').toLowerCase().trim();
  if (!LEANS.includes(lean)) problems.push('next_meeting_lean must be hike/hold/cut');
  const summary = twoSentences(obj.summary);
  if (!summary) problems.push('summary missing');
  if (problems.length) return { ok: false, problems };
  let date = /^\d{4}-\d{2}-\d{2}$/.test(String(obj.next_meeting_date || '')) && !isNaN(Date.parse(obj.next_meeting_date)) ? obj.next_meeting_date : null;
  if (!date) date = ctx.fallbackMeetingDate || null;
  const phrases = Array.isArray(obj.key_phrases) ? obj.key_phrases.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim().slice(0, 160)).slice(0, 8) : [];
  const conf = isFinite(Number(obj.confidence)) ? clamp(Number(obj.confidence), 0, 1) : null;
  return { ok: true, brief: { stance_score: Math.round(clamp(score, STANCE_MIN, STANCE_MAX) * 100) / 100, next_meeting_lean: lean, next_meeting_date: date, summary, key_phrases: phrases, confidence: conf } };
}

// A row that repeats the previous brief under today's date.
export function copyForward(prev, o) {
  return {
    brief_date: o.briefDate,
    stance_score: prev ? Number(prev.stance_score) : 0,
    next_meeting_lean: prev ? prev.next_meeting_lean : 'hold',
    next_meeting_date: o.nextMeetingDate || (prev ? prev.next_meeting_date : null),
    summary: prev ? prev.summary : 'No Federal Reserve communications were published in the last ' + FIRST_RUN_DAYS + ' days.',
    key_phrases: prev ? (prev.key_phrases || []) : [],
    sources: o.sources || [],
    fed_funds_at_brief: o.fedFunds === undefined ? (prev ? prev.fed_funds_at_brief : null) : o.fedFunds,
    model_json: { copied_from: prev ? prev.brief_date : null, reason: o.reason, detail: o.detail || null }
  };
}

// ── Prompt ───────────────────────────────────────────────────────────────────
export const SYSTEM_PROMPT = 'You are a Federal Reserve watcher writing a one-paragraph daily brief for owners of mid-size US businesses. ' +
  'Score the Fed\'s current policy stance from the communications provided — not from your own economic view — on a scale from -2 (very dovish: cuts imminent) ' +
  'through 0 (balanced / data-dependent) to +2 (very hawkish: hikes likely). Anchor the score on what officials actually said; move it from the previous brief only when the new items justify it. ' +
  'Say which decision is most likely at the next scheduled FOMC meeting. Write the summary as at most two plain-English sentences. Quote key phrases verbatim from the items.';

export function buildUserPrompt(o) {
  const lines = [];
  lines.push('Today: ' + o.today + '.');
  lines.push('Next scheduled FOMC meeting (from the Fed calendar): ' + (o.nextMeetingDate || 'unknown') + '.');
  lines.push('');
  lines.push('Current FRED snapshot: ' + JSON.stringify({
    effective_fed_funds: o.snapshot.fedFunds, fed_funds_date: o.snapshot.fedFundsDate, cpi_yoy: o.snapshot.cpi, cpi_yoy_3mo_ago: o.snapshot.cpi3moAgo,
    core_pce_yoy: o.snapshot.corePce, core_pce_yoy_3mo_ago: o.snapshot.corePce3moAgo, unemployment: o.snapshot.unemployment, real_gdp_growth_saar: o.snapshot.gdpGrowth,
    treasury_10y: o.snapshot.treasury10y, treasury_6mo: o.snapshot.treasury6mo, treasury_2y: o.snapshot.treasury2y
  }));
  lines.push('');
  lines.push('Previous brief: ' + (o.prev ? JSON.stringify({ brief_date: o.prev.brief_date, stance_score: o.prev.stance_score, next_meeting_lean: o.prev.next_meeting_lean, summary: o.prev.summary, key_phrases: o.prev.key_phrases }) : 'none (first run)'));
  lines.push('');
  lines.push('New Federal Reserve communications since the previous brief (' + o.items.length + '):');
  o.items.forEach((it, i) => {
    lines.push('');
    lines.push('[' + (i + 1) + '] ' + it.title + ' — ' + (it.published ? it.published.slice(0, 10) : 'undated') + ' — ' + it.link);
    lines.push((it.body || it.description || '').slice(0, BODY_CHARS));
  });
  lines.push('');
  lines.push('Answer with the JSON object only.');
  return lines.join('\n');
}

// ── External calls (all through deps.fetch so tests can stub them) ───────────
async function getText(fetchImpl, url, accept) {
  const res = await fetchImpl(url, { headers: { 'Accept': accept || 'text/html,application/xml', 'User-Agent': 'RateShield-fed-brief/1.0 (+https://rateshieldai.com)' } });
  if (!res.ok) throw new Error(url + ' → ' + res.status);
  return res.text();
}

export function sbHeaders(env) {
  return { 'apikey': env.SUPABASE_SERVICE_ROLE_KEY, 'Authorization': 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY, 'Content-Type': 'application/json' };
}
export function supabaseUrl(env) { return (env.SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/$/, ''); }

export async function fetchPreviousBrief(env, fetchImpl) {
  const res = await fetchImpl(supabaseUrl(env) + '/rest/v1/fed_briefs?select=*&order=brief_date.desc&limit=1', { headers: sbHeaders(env) });
  if (!res.ok) throw new Error('Supabase read ' + res.status + ': ' + (await res.text()).slice(0, 200));
  const rows = await res.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

export async function upsertBrief(env, row, fetchImpl) {
  const res = await fetchImpl(supabaseUrl(env) + '/rest/v1/fed_briefs?on_conflict=brief_date', {
    method: 'POST', headers: Object.assign(sbHeaders(env), { 'Prefer': 'resolution=merge-duplicates,return=representation' }), body: JSON.stringify(row)
  });
  if (!res.ok) throw new Error('Supabase write ' + res.status + ': ' + (await res.text()).slice(0, 200));
  const rows = await res.json();
  return Array.isArray(rows) ? rows[0] : rows;
}

// Same proxy pattern as the Executive Advisor (api/chat.js): a direct call to
// the Messages API with the key from the environment. Structured outputs
// (output_config.format = json_schema) make the answer parseable by construction.
export async function askModel(env, system, user, fetchImpl) {
  const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 4096, system, messages: [{ role: 'user', content: user }],
      output_config: { format: { type: 'json_schema', schema: BRIEF_SCHEMA }, effort: 'medium' }
    })
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error('Anthropic ' + res.status + ': ' + JSON.stringify(data.error || data).slice(0, 300));
  if (data.stop_reason === 'refusal') throw new Error('Anthropic refused the request');
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { text, usage: data.usage || null, model: data.model || MODEL, stop_reason: data.stop_reason };
}

// ── The daily run ────────────────────────────────────────────────────────────
export async function runBrief(deps) {
  const env = deps.env || process.env;
  const fetchImpl = deps.fetch || fetch;
  const log = deps.log || console.log;
  const today = deps.today || isoDate(Date.now());
  const missing = ['ANTHROPIC_API_KEY', 'FRED_API_KEY', 'SUPABASE_SERVICE_ROLE_KEY'].filter((k) => !env[k]);
  if (missing.length) throw new Error('Missing env: ' + missing.join(', '));

  const prev = await fetchPreviousBrief(env, fetchImpl);
  const since = prev ? new Date(prev.brief_date + 'T00:00:00Z').toISOString() : daysAgo(today, FIRST_RUN_DAYS) + 'T00:00:00.000Z';

  // 1. Feeds — a feed that fails is logged and skipped, never fatal.
  let items = [];
  for (const f of FEEDS) {
    try { items = items.concat(parseRss(await getText(fetchImpl, f.url, 'application/rss+xml, application/xml')).map((it) => Object.assign({ feed: f.key }, it))); }
    catch (e) { log('[fed-brief] feed ' + f.key + ' failed: ' + e.message); }
  }
  const seen = new Set();
  const fresh = items.filter((it) => it.published && it.published > since && !seen.has(it.link) && seen.add(it.link))
    .sort((a, b) => b.published.localeCompare(a.published)).slice(0, MAX_ITEMS);

  // 2. Calendar and FRED.
  let nextMeetingDate = null;
  try { nextMeetingDate = parseFomcCalendar(await getText(fetchImpl, FOMC_CALENDAR_URL), today); } catch (e) { log('[fed-brief] calendar failed: ' + e.message); }
  if (!nextMeetingDate && prev && prev.next_meeting_date && prev.next_meeting_date >= today) nextMeetingDate = prev.next_meeting_date;
  let snapshot = {};
  try { snapshot = await fetchSnapshot(env.FRED_API_KEY, fetchImpl); } catch (e) { log('[fed-brief] FRED failed: ' + e.message); }
  const fedFunds = typeof snapshot.fedFunds === 'number' ? snapshot.fedFunds : (prev ? prev.fed_funds_at_brief : null);

  // 3. Nothing new → copy forward, no model call.
  if (!fresh.length) {
    const row = copyForward(prev, { briefDate: today, nextMeetingDate, fedFunds, sources: [], reason: prev ? 'no new Fed items since ' + prev.brief_date : 'no Fed items in the first-run window' });
    log('[fed-brief] ' + row.model_json.reason + ' — copied forward, Anthropic not called');
    return { action: 'copied', row: await upsertBrief(env, row, fetchImpl), anthropicCalled: false };
  }

  // 4. Fetch each statement body (official URLs only, bounded).
  for (const it of fresh) {
    try { it.body = extractArticle(await getText(fetchImpl, it.link)); } catch (e) { it.body = it.description; log('[fed-brief] body ' + it.link + ' failed: ' + e.message); }
  }
  const sources = fresh.map((it) => ({ title: it.title, url: it.link, published: it.published ? it.published.slice(0, 10) : null }));

  // 5. Ask the model; on any failure copy forward but keep the sources.
  let answer;
  try {
    answer = await askModel(env, SYSTEM_PROMPT, buildUserPrompt({ today, nextMeetingDate, snapshot, prev, items: fresh }), fetchImpl);
  } catch (e) {
    log('[fed-brief] model call failed: ' + e.message);
    const row = copyForward(prev, { briefDate: today, nextMeetingDate, fedFunds, sources, reason: 'model call failed', detail: e.message });
    return { action: 'fallback', row: await upsertBrief(env, row, fetchImpl), anthropicCalled: true, error: e.message };
  }
  const v = validateBrief(answer.text, { fallbackMeetingDate: nextMeetingDate });
  if (!v.ok) {
    log('[fed-brief] model answer rejected: ' + v.problems.join('; ') + ' — raw: ' + String(answer.text).slice(0, 300));
    const row = copyForward(prev, { briefDate: today, nextMeetingDate, fedFunds, sources, reason: 'model answer failed validation', detail: v.problems });
    return { action: 'fallback', row: await upsertBrief(env, row, fetchImpl), anthropicCalled: true, error: v.problems.join('; ') };
  }
  const row = {
    brief_date: today, stance_score: v.brief.stance_score, next_meeting_lean: v.brief.next_meeting_lean,
    next_meeting_date: v.brief.next_meeting_date || nextMeetingDate, summary: v.brief.summary, key_phrases: v.brief.key_phrases,
    sources, fed_funds_at_brief: fedFunds,
    model_json: { answer: v.brief, model: answer.model, usage: answer.usage, items_considered: fresh.length, calendar_next_meeting: nextMeetingDate, fred: snapshot }
  };
  log('[fed-brief] generated: stance ' + row.stance_score + ' · ' + row.next_meeting_lean + ' · ' + fresh.length + ' items');
  return { action: 'generated', row: await upsertBrief(env, row, fetchImpl), anthropicCalled: true };
}

// ── Authorisation ────────────────────────────────────────────────────────────
// Either the cron secret, or a Supabase session token whose user is the owner.
export async function authorize(req, env, fetchImpl) {
  const header = String(req.headers && (req.headers.authorization || req.headers.Authorization) || '');
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return { ok: false, reason: 'missing bearer token' };
  const token = m[1].trim();
  if (env.CRON_SECRET && token === env.CRON_SECRET) return { ok: true, via: 'cron' };
  if (token.split('.').length === 3 && env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const res = await fetchImpl(supabaseUrl(env) + '/auth/v1/user', { headers: { 'apikey': env.SUPABASE_SERVICE_ROLE_KEY, 'Authorization': 'Bearer ' + token } });
      if (res.ok) {
        const user = await res.json();
        const owner = (env.OWNER_EMAIL || DEFAULT_OWNER_EMAIL).toLowerCase();
        if (user && String(user.email || '').toLowerCase() === owner) return { ok: true, via: 'owner', email: user.email };
        return { ok: false, reason: 'not the owner' };
      }
    } catch (e) { return { ok: false, reason: 'token check failed: ' + e.message }; }
  }
  return { ok: false, reason: 'invalid token' };
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.CRON_SECRET) return res.status(500).json({ error: 'CRON_SECRET is not configured' });
  const auth = await authorize(req, process.env, fetch);
  if (!auth.ok) return res.status(401).json({ error: 'Unauthorized', reason: auth.reason });
  try {
    const out = await runBrief({});
    return res.status(200).json({ ok: true, via: auth.via, action: out.action, anthropicCalled: out.anthropicCalled, error: out.error || null, brief: out.row });
  } catch (error) {
    console.error('[fed-brief] failed:', error);
    return res.status(500).json({ ok: false, error: error && error.message });
  }
}
