'use strict';
// Offline tests for api/fed-brief.js: feed/calendar parsing, answer validation,
// copy-forward when nothing is new, fallback when the model answer is unusable,
// and endpoint authorisation. Every network call goes through an injected fetch.
const test = require('node:test');
const assert = require('node:assert/strict');

let fb;
test('api/fed-brief.js loads', async () => {
  fb = await import('../api/fed-brief.js');
  assert.equal(typeof fb.default, 'function');
  assert.ok(fb.FEEDS.every((f) => f.url.startsWith('https://www.federalreserve.gov/')), 'official URLs only');
  assert.ok(fb.FOMC_CALENDAR_URL.startsWith('https://www.federalreserve.gov/'));
});

const RSS = `<?xml version="1.0"?><rss><channel>
<item><title><![CDATA[Federal Reserve issues FOMC statement]]></title><link>https://www.federalreserve.gov/newsevents/pressreleases/monetary20260916a.htm</link><pubDate>Wed, 16 Sep 2026 18:00:00 GMT</pubDate><description>&lt;p&gt;The Committee decided to raise the target range.&lt;/p&gt;</description></item>
<item><title>Speech by Governor X: The Outlook</title><link>https://www.federalreserve.gov/newsevents/speech/x20260918a.htm</link><pubDate>Fri, 18 Sep 2026 14:30:00 GMT</pubDate><description>Remarks</description></item>
<item><title>Duplicate</title><link>https://www.federalreserve.gov/newsevents/speech/x20260918a.htm</link><pubDate>Fri, 18 Sep 2026 14:30:00 GMT</pubDate></item>
<item><title>Not the Fed</title><link>https://example.com/fed</link><pubDate>Sat, 19 Sep 2026 10:00:00 GMT</pubDate></item>
</channel></rss>`;

test('parseRss: official items only, CDATA/entities decoded, de-duplicated, newest first', () => {
  const items = fb.parseRss(RSS);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'Speech by Governor X: The Outlook');
  assert.equal(items[0].published, '2026-09-18T14:30:00.000Z');
  assert.equal(items[1].title, 'Federal Reserve issues FOMC statement');
  assert.equal(items[1].description, 'The Committee decided to raise the target range.');
  assert.ok(items.every((i) => fb.isOfficial(i.link)));
  // Atom form as well
  const atom = '<feed><entry><title>T</title><link href="https://www.federalreserve.gov/a.htm"/><published>2026-09-01T00:00:00Z</published></entry></feed>';
  assert.equal(fb.parseRss(atom)[0].link, 'https://www.federalreserve.gov/a.htm');
  assert.deepEqual(fb.parseRss(''), []);
});

const CALENDAR = `<html><body>
<div class="panel-heading"><h4>2026 FOMC Meetings</h4></div>
<div class="row fomc-meeting"><div class="fomc-meeting__month"><strong>January</strong></div><div class="fomc-meeting__date">27-28</div></div>
<div class="row fomc-meeting"><div class="fomc-meeting__month"><strong>Apr/May</strong></div><div class="fomc-meeting__date">30-1</div></div>
<div class="row fomc-meeting"><div class="fomc-meeting__month"><strong>September</strong></div><div class="fomc-meeting__date">15-16*</div></div>
<div class="row fomc-meeting"><div class="fomc-meeting__month"><strong>October</strong></div><div class="fomc-meeting__date">27-28</div></div>
<div class="row fomc-meeting"><div class="fomc-meeting__month"><strong>December</strong></div><div class="fomc-meeting__date">8-9*</div></div>
<div class="panel-heading"><h4>2027 FOMC Meetings</h4></div>
<div class="row fomc-meeting"><div class="fomc-meeting__month"><strong>January</strong></div><div class="fomc-meeting__date">26-27</div></div>
<div class="row fomc-meeting"><div class="fomc-meeting__month"><strong>March</strong></div><div class="fomc-meeting__date">(unscheduled)</div></div>
</body></html>`;

test('parseFomcCalendar: next scheduled meeting end-date on or after today', () => {
  assert.equal(fb.parseFomcCalendar(CALENDAR, '2026-09-20'), '2026-10-28');
  assert.equal(fb.parseFomcCalendar(CALENDAR, '2026-09-16'), '2026-09-16', 'meeting day itself still counts');
  assert.equal(fb.parseFomcCalendar(CALENDAR, '2026-04-30'), '2026-05-01', 'Apr/May 30-1 ends on 1 May');
  assert.equal(fb.parseFomcCalendar(CALENDAR, '2026-12-10'), '2027-01-27', 'rolls into the next year');
  assert.equal(fb.parseFomcCalendar('<html>nothing here</html>', '2026-09-20'), null);
});

test('validateBrief: stance clamped to [-2, 2], lean normalised, summary cut to two sentences, bad answers rejected', () => {
  const ok = fb.validateBrief({ stance_score: 3.7, next_meeting_lean: 'HIKE', next_meeting_date: '2026-10-28', summary: 'One. Two. Three.', key_phrases: ['a', 7, ' b '], confidence: 1.4 });
  assert.equal(ok.ok, true);
  assert.equal(ok.brief.stance_score, 2);
  assert.equal(ok.brief.next_meeting_lean, 'hike');
  assert.equal(ok.brief.summary, 'One. Two.');
  assert.deepEqual(ok.brief.key_phrases, ['a', 'b']);
  assert.equal(ok.brief.confidence, 1);
  assert.equal(fb.validateBrief({ stance_score: -5, next_meeting_lean: 'cut', summary: 'x.', key_phrases: [] }).brief.stance_score, -2);
  assert.equal(fb.validateBrief({ stance_score: 0.456, next_meeting_lean: 'hold', summary: 'x.', key_phrases: [] }).brief.stance_score, 0.46);
  assert.equal(fb.validateBrief('{"stance_score": 1, "next_meeting_lean": "hold", "summary": "Fine.", "key_phrases": []}').ok, true, 'JSON string accepted');
  assert.equal(fb.validateBrief('I cannot produce that').ok, false);
  assert.equal(fb.validateBrief({ stance_score: 'hawkish', next_meeting_lean: 'hold', summary: 'x.' }).ok, false);
  assert.equal(fb.validateBrief({ stance_score: 1, next_meeting_lean: 'maybe', summary: 'x.' }).ok, false);
  assert.equal(fb.validateBrief({ stance_score: 1, next_meeting_lean: 'hold', summary: '' }).ok, false);
  const badDate = fb.validateBrief({ stance_score: 1, next_meeting_lean: 'hold', next_meeting_date: 'soon', summary: 'x.' }, { fallbackMeetingDate: '2026-10-28' });
  assert.equal(badDate.brief.next_meeting_date, '2026-10-28', 'unparseable date → calendar date');
  assert.equal(fb.STANCE_MIN, -2); assert.equal(fb.STANCE_MAX, 2);
});

// ── A fake network for runBrief ──────────────────────────────────────────────
const PREV = { id: 1, brief_date: '2026-09-19', stance_score: 1.25, next_meeting_lean: 'hike', next_meeting_date: '2026-10-28',
  summary: 'The Fed is leaning hawkish. A hike is likely in October.', key_phrases: ['energy-driven re-acceleration'], sources: [{ title: 'x', url: 'https://www.federalreserve.gov/x', published: '2026-09-16' }],
  fed_funds_at_brief: 3.63, model_json: {} };
const FRED_OBS = { DFF: [{ date: '2026-09-18', value: '3.88' }], CPIAUCSL: [{ date: '2026-08-01', value: '3.4' }], PCEPILFE: [{ date: '2026-07-01', value: '3.3' }], UNRATE: [{ date: '2026-08-01', value: '4.1' }],
  A191RL1Q225SBEA: [{ date: '2026-04-01', value: '1.5' }], DGS10: [{ date: '2026-09-18', value: '4.95' }], DGS6MO: [{ date: '2026-09-18', value: '4.05' }], DGS2: [{ date: '2026-09-18', value: '4.0' }] };

function fakeNet(o) {
  const calls = [];
  const json = (body, status) => ({ ok: (status || 200) < 300, status: status || 200, json: async () => body, text: async () => JSON.stringify(body) });
  const text = (body, status) => ({ ok: (status || 200) < 300, status: status || 200, text: async () => body, json: async () => { throw new Error('not json'); } });
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts: opts || {} });
    if (url.includes('/rest/v1/fed_briefs') && (!opts || !opts.method)) return json(o.prev ? [o.prev] : []);
    if (url.includes('/rest/v1/fed_briefs') && opts.method === 'POST') return json([Object.assign({ id: 99 }, JSON.parse(opts.body))]);
    if (url.includes('/rest/v1/consensus_paths') && (!opts || !opts.method)) return json(o.consensusToday ? [o.consensusToday] : []);
    if (url.includes('/rest/v1/forecast_log') && opts.method === 'POST') return json(JSON.parse(opts.body));
    if (url.includes('/feeds/press_all.xml')) return text(o.rss || '');
    if (url.includes('/feeds/press_monetary.xml')) return text(o.fomcRss || '<rss><channel></channel></rss>');
    if (url.includes('/feeds/')) return text('<rss><channel></channel></rss>');
    if (url.includes('fomccalendars')) return text(CALENDAR);
    if (url.includes('api.stlouisfed.org')) { const id = url.match(/series_id=([A-Z0-9]+)/)[1]; return json({ observations: FRED_OBS[id] || [] }); }
    if (url.includes('api.anthropic.com')) { if (o.anthropic === undefined) throw new Error('Anthropic must not be called'); return json(o.anthropic); }
    if (url.startsWith('https://www.federalreserve.gov/')) return text('<html><body><div id="article"><h3>Title</h3><p>' + (o.article || 'Body text of the statement.') + '</p></div><div class="lastUpdate">x</div></body></html>');
    if (url.includes('/auth/v1/user')) return o.authUser ? json(o.authUser) : json({ error: 'bad' }, 401);
    throw new Error('unexpected fetch ' + url);
  };
  return { fetchImpl, calls };
}
const ENV = { ANTHROPIC_API_KEY: 'k', FRED_API_KEY: 'f', SUPABASE_SERVICE_ROLE_KEY: 'svc', CRON_SECRET: 'cron-secret' };
const logs = [];
const log = (m) => logs.push(m);

test('copy-forward: no new Fed items since the last brief → previous stance and summary under today\'s date, sources [], Anthropic NOT called', async () => {
  const net = fakeNet({ prev: PREV, rss: RSS }); // newest item 18 Sep < last brief 19 Sep
  const out = await fb.runBrief({ env: ENV, fetch: net.fetchImpl, today: '2026-09-20', log });
  assert.equal(out.action, 'copied');
  assert.equal(out.anthropicCalled, false);
  assert.ok(!net.calls.some((c) => c.url.includes('api.anthropic.com')), 'no Anthropic request');
  const row = out.row;
  assert.equal(row.brief_date, '2026-09-20');
  assert.equal(row.stance_score, 1.25);
  assert.equal(row.summary, PREV.summary);
  assert.equal(row.next_meeting_lean, 'hike');
  assert.deepEqual(row.sources, []);
  assert.equal(row.fed_funds_at_brief, 3.88, 'today\'s DFF, not the old one');
  assert.equal(row.next_meeting_date, '2026-10-28');
  assert.equal(row.model_json.copied_from, '2026-09-19');
  const write = net.calls.find((c) => c.url.includes('/rest/v1/fed_briefs') && c.opts.method === 'POST');
  assert.ok(write.url.includes('on_conflict=brief_date'));
  assert.equal(write.opts.headers.Authorization, 'Bearer svc', 'written with the service-role key');
  assert.ok(logs.some((l) => l.includes('copied forward')));
});

test('generated: new items → statement bodies fetched from federalreserve.gov, Anthropic asked for strict JSON, validated row written with sources', async () => {
  const answer = { stance_score: 1.5, next_meeting_lean: 'hike', next_meeting_date: '2026-10-28', summary: 'Officials signalled further tightening. Markets should expect a hike in October.', key_phrases: ['further tightening'], confidence: 0.8 };
  const net = fakeNet({ prev: Object.assign({}, PREV, { brief_date: '2026-09-15' }), rss: RSS, anthropic: { content: [{ type: 'text', text: JSON.stringify(answer) }], stop_reason: 'end_turn', model: 'claude-opus-5', usage: { input_tokens: 10, output_tokens: 5 } } });
  const out = await fb.runBrief({ env: ENV, fetch: net.fetchImpl, today: '2026-09-20', log });
  assert.equal(out.action, 'generated');
  const req = net.calls.find((c) => c.url.includes('api.anthropic.com'));
  const body = JSON.parse(req.opts.body);
  assert.equal(req.opts.headers['x-api-key'], 'k');
  assert.equal(body.model, fb.MODEL);
  assert.equal(body.output_config.format.type, 'json_schema', 'JSON mode so the answer is always parseable');
  assert.equal(body.output_config.format.schema.additionalProperties, false);
  assert.ok(body.messages[0].content.includes('Federal Reserve issues FOMC statement'));
  assert.ok(body.messages[0].content.includes('Body text of the statement.'), 'statement body included');
  assert.ok(body.messages[0].content.includes('"effective_fed_funds":3.88'), 'FRED snapshot included');
  assert.ok(body.messages[0].content.includes('Previous brief: {"brief_date":"2026-09-15"'), 'previous brief included');
  assert.ok(net.calls.some((c) => c.url === 'https://www.federalreserve.gov/newsevents/speech/x20260918a.htm'), 'body fetched from the official URL');
  assert.equal(out.row.stance_score, 1.5);
  assert.equal(out.row.sources.length, 2);
  assert.equal(out.row.sources[0].kind, 'statement', 'the FOMC statement is listed first even though the speech is newer');
  assert.equal(out.row.sources[0].url, 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20260916a.htm');
  assert.equal(out.row.sources[1].url, 'https://www.federalreserve.gov/newsevents/speech/x20260918a.htm');
  assert.equal(out.row.model_json.items_considered, 2);
  assert.equal(out.row.model_json.last_statement.published, '2026-09-16');
  assert.equal(out.row.fed_funds_at_brief, 3.88);
});

test('fallback: model answer that fails validation → logged, previous brief copied forward, sources still recorded', async () => {
  const net = fakeNet({ prev: Object.assign({}, PREV, { brief_date: '2026-09-15' }), rss: RSS, anthropic: { content: [{ type: 'text', text: 'Sorry, I cannot score this.' }], stop_reason: 'end_turn' } });
  logs.length = 0;
  const out = await fb.runBrief({ env: ENV, fetch: net.fetchImpl, today: '2026-09-20', log });
  assert.equal(out.action, 'fallback');
  assert.equal(out.anthropicCalled, true);
  assert.equal(out.row.stance_score, 1.25);
  assert.equal(out.row.summary, PREV.summary);
  assert.equal(out.row.brief_date, '2026-09-20');
  assert.equal(out.row.sources.length, 2, 'sources kept for inspection');
  assert.equal(out.row.model_json.reason, 'model answer failed validation');
  assert.ok(logs.some((l) => l.includes('model answer rejected')));
  // out-of-range score from the model is clamped rather than rejected
  const net2 = fakeNet({ prev: PREV, rss: RSS.replace('18 Sep 2026', '20 Sep 2026'), anthropic: { content: [{ type: 'text', text: JSON.stringify({ stance_score: 9, next_meeting_lean: 'hike', next_meeting_date: '2026-10-28', summary: 'Very hawkish.', key_phrases: [], confidence: 0.9 }) }], stop_reason: 'end_turn' } });
  const out2 = await fb.runBrief({ env: ENV, fetch: net2.fetchImpl, today: '2026-09-21', log });
  assert.equal(out2.action, 'generated');
  assert.equal(out2.row.stance_score, 2);
  // an API error is also a fallback
  const net3 = fakeNet({ prev: PREV, rss: RSS.replace('18 Sep 2026', '20 Sep 2026'), anthropic: { error: { type: 'overloaded_error', message: 'busy' } } });
  const out3 = await fb.runBrief({ env: ENV, fetch: net3.fetchImpl, today: '2026-09-21', log });
  assert.equal(out3.action, 'fallback');
  assert.equal(out3.row.model_json.reason, 'model call failed');
});

test('first run with no previous brief and nothing in the window writes a neutral row without calling the model', async () => {
  const net = fakeNet({ prev: null, rss: '' });
  const out = await fb.runBrief({ env: ENV, fetch: net.fetchImpl, today: '2026-09-20', log });
  assert.equal(out.action, 'copied');
  assert.equal(out.row.stance_score, 0);
  assert.equal(out.row.next_meeting_lean, 'hold');
  assert.equal(out.row.next_meeting_date, '2026-10-28', 'calendar still consulted');
  await assert.rejects(() => fb.runBrief({ env: { CRON_SECRET: 'x' }, fetch: net.fetchImpl, today: '2026-09-20', log }), /Missing env: ANTHROPIC_API_KEY, FRED_API_KEY, SUPABASE_SERVICE_ROLE_KEY/);
});

test('authorisation: cron secret or the owner\'s Supabase session, nothing else', async () => {
  const net = fakeNet({ authUser: { email: 'Rajatinpa@gmail.com' } });
  assert.equal((await fb.authorize({ headers: {} }, ENV, net.fetchImpl)).ok, false);
  assert.equal((await fb.authorize({ headers: { authorization: 'Bearer wrong' } }, ENV, net.fetchImpl)).ok, false);
  assert.deepEqual(await fb.authorize({ headers: { authorization: 'Bearer cron-secret' } }, ENV, net.fetchImpl), { ok: true, via: 'cron' });
  const owner = await fb.authorize({ headers: { authorization: 'Bearer aaa.bbb.ccc' } }, ENV, net.fetchImpl);
  assert.equal(owner.ok, true); assert.equal(owner.via, 'owner');
  const other = fakeNet({ authUser: { email: 'someone@else.com' } });
  assert.equal((await fb.authorize({ headers: { authorization: 'Bearer aaa.bbb.ccc' } }, ENV, other.fetchImpl)).reason, 'not the owner');
  const custom = await fb.authorize({ headers: { authorization: 'Bearer aaa.bbb.ccc' } }, Object.assign({}, ENV, { OWNER_EMAIL: 'someone@else.com' }), other.fetchImpl);
  assert.equal(custom.ok, true, 'OWNER_EMAIL env overrides the default');
  // handler: refuses without the secret configured, 401 without a valid bearer
  const res = () => { const r = { code: 0, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
  const saved = process.env.CRON_SECRET; delete process.env.CRON_SECRET;
  let r = res(); await fb.default({ method: 'GET', headers: {} }, r); assert.equal(r.code, 500);
  process.env.CRON_SECRET = 'cron-secret';
  r = res(); await fb.default({ method: 'GET', headers: { authorization: 'Bearer nope' } }, r); assert.equal(r.code, 401);
  r = res(); await fb.default({ method: 'DELETE', headers: {} }, r); assert.equal(r.code, 405);
  if (saved === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = saved;
});

test('scorekeeping: every run logs today\'s RateShield (blended + model) and market paths to forecast_log, computed with the app\'s own Model', async () => {
  const { loadModel } = require('./helpers/loadModel');
  const { Model } = loadModel();
  const net = fakeNet({ prev: PREV, rss: RSS }); // copy-forward path
  const out = await fb.runBrief({ env: ENV, fetch: net.fetchImpl, today: '2026-09-20', log });
  assert.equal(out.action, 'copied');
  assert.ok(out.forecastLog, 'paths logged even when the brief was copied forward');
  const write = net.calls.find((c) => c.url.includes('/rest/v1/forecast_log'));
  assert.ok(write.url.includes('on_conflict=log_date,horizon'));
  assert.equal(write.opts.headers.Authorization, 'Bearer svc');
  const rows = JSON.parse(write.opts.body);
  assert.equal(JSON.stringify(rows.map((r) => r.horizon)), '[3,6,12,18]');
  // recompute independently from the FRED fixture + the copied stance (1.25)
  const snap = { fedFunds: 3.88, cpi: 3.4, corePce: 3.3, unemployment: 4.1, gdpGrowth: 1.5, treasury10y: 4.95, treasury6mo: 4.05, treasury2y: 4.0 };
  const score = Model.rateSignalScore({ cpi: 3.4, un: 4.1, tr: 4.95, gdp: 1.5, pce: 3.3, fedStance: 1.25 });
  const model = Model.ratePath({ current: 3.88, score, fedStance: 1.25 }), market = Model.marketPath({ current: 3.88, dgs6mo: 4.05, dgs2: 4.0 }), blended = Model.blendedPath(model, market);
  [3, 6, 12, 18].forEach((h) => assert.ok(model[h] >= 3.88, 'the daily job applies the same hawkish floor'));
  rows.forEach((r) => {
    assert.equal(r.log_date, '2026-09-20'); assert.equal(r.current_rate, 3.88);
    assert.equal(r.rateshield_model, model[r.horizon]); assert.equal(r.market, market[r.horizon]); assert.equal(r.rateshield_blended, blended[r.horizon]);
    assert.equal(r.consensus, undefined, 'no consensus logged today → columns untouched');
  });
  assert.equal(fb.computePaths(snap, 1.25).blended[12], blended[12]);
  assert.equal(fb.computePaths({ fedFunds: null }, 0), null, 'no current rate → nothing to log');
  assert.equal(fb.computePaths({ fedFunds: 3.88, cpi: 3.4 }, 0), null, 'incomplete snapshot → nothing to log');
  // a consensus logged today is stored alongside
  const net2 = fakeNet({ prev: PREV, rss: RSS, consensusToday: { as_of: '2026-09-20', source: 'Bank note', m3: 3.9, m6: null, m12: 4.7, m18: 4.7 } });
  await fb.runBrief({ env: ENV, fetch: net2.fetchImpl, today: '2026-09-20', log });
  const rows2 = JSON.parse(net2.calls.find((c) => c.url.includes('/rest/v1/forecast_log')).opts.body);
  assert.equal(rows2.find((r) => r.horizon === 3).consensus, 3.9);
  assert.equal(rows2.find((r) => r.horizon === 6).consensus, null);
  assert.equal(rows2.find((r) => r.horizon === 12).consensus_source, 'Bank note');
  // a forecast_log failure never fails the brief
  const net3 = fakeNet({ prev: PREV, rss: RSS });
  const failing = async (url, opts) => { if (url.includes('/rest/v1/forecast_log')) return { ok: false, status: 500, text: async () => 'boom', json: async () => ({}) }; return net3.fetchImpl(url, opts); };
  logs.length = 0;
  const out3 = await fb.runBrief({ env: ENV, fetch: failing, today: '2026-09-20', log });
  assert.equal(out3.action, 'copied'); assert.equal(out3.forecastLog, null);
  assert.ok(logs.some((l) => l.includes('forecast_log failed')));
});

test('twoSentences keeps the text from its first character: decimals such as "3.75–4%" never split a sentence', () => {
  const t = 'The FOMC raised the target range to 3.75–4% on a unanimous vote, citing 3.4 percent inflation. Officials signalled one more hike. A third sentence here.';
  assert.equal(fb.twoSentences(t), 'The FOMC raised the target range to 3.75–4% on a unanimous vote, citing 3.4 percent inflation. Officials signalled one more hike.');
  assert.equal(fb.twoSentences('One sentence only'), 'One sentence only');
  assert.equal(fb.twoSentences('Rates at 4.5%. Done.'), 'Rates at 4.5%. Done.');
  assert.equal(fb.twoSentences('Ends with a quote." Next one! Third?'), 'Ends with a quote." Next one!');
  assert.equal(fb.twoSentences('  spaced   out. second.   third. '), 'spaced out. second.');
  assert.equal(fb.twoSentences(''), '');
  const v = fb.validateBrief({ stance_score: 1.5, next_meeting_lean: 'hike', next_meeting_date: '2026-10-28', summary: t, key_phrases: [], confidence: 0.8 });
  assert.ok(v.brief.summary.startsWith('The FOMC raised the target range to 3.75–4%'), v.brief.summary);
});

test('forced run regenerates from the 30-day window even when nothing is new, and keeps the raw model text', async () => {
  const answer = { stance_score: 1.5, next_meeting_lean: 'hike', next_meeting_date: '2026-10-28', summary: 'The FOMC raised the target range to 3.75–4% on a unanimous vote. One more hike is likely.', key_phrases: ['unanimous'], confidence: 0.8 };
  const net = fakeNet({ prev: PREV, rss: RSS, anthropic: { content: [{ type: 'text', text: JSON.stringify(answer) }], stop_reason: 'end_turn', model: 'claude-opus-5' } });
  const out = await fb.runBrief({ env: ENV, fetch: net.fetchImpl, today: '2026-09-20', log, force: true });
  assert.equal(out.action, 'generated', 'items older than the last brief are reconsidered when forced');
  assert.equal(out.row.summary, answer.summary, 'full summary stored');
  assert.equal(out.row.model_json.raw_answer, JSON.stringify(answer));
  assert.equal(out.row.model_json.forced, true);
  const res = () => { const r = { code: 0, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
  const saved = process.env.CRON_SECRET; process.env.CRON_SECRET = 'cron-secret';
  const realFetch = global.fetch; global.fetch = net.fetchImpl;
  const savedEnv = {}; ['ANTHROPIC_API_KEY', 'FRED_API_KEY', 'SUPABASE_SERVICE_ROLE_KEY'].forEach((k) => { savedEnv[k] = process.env[k]; process.env[k] = ENV[k]; });
  try {
    const r = res(); await fb.default({ method: 'POST', headers: { authorization: 'Bearer cron-secret' }, body: '{"force":true}', query: {} }, r);
    assert.equal(r.code, 200); assert.equal(r.body.forced, true); assert.equal(r.body.action, 'generated');
    const r2 = res(); await fb.default({ method: 'GET', headers: { authorization: 'Bearer cron-secret' }, query: {} }, r2);
    assert.equal(r2.body.forced, false, 'the cron path is never forced');
  } finally {
    global.fetch = realFetch;
    if (saved === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = saved;
    Object.keys(savedEnv).forEach((k) => { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; });
  }
});

const PRESS_ALL = `<rss><channel>
<item><title>Federal Reserve Board announces enforcement action against Bank A</title><link>https://www.federalreserve.gov/newsevents/pressreleases/enforcement20260918a.htm</link><pubDate>Fri, 18 Sep 2026 15:00:00 GMT</pubDate></item>
<item><title>Federal Reserve Board announces termination of enforcement action with Bank B</title><link>https://www.federalreserve.gov/newsevents/pressreleases/enforcement20260918b.htm</link><pubDate>Fri, 18 Sep 2026 15:05:00 GMT</pubDate></item>
<item><title>Federal Reserve Board announces enforcement action against Bank C</title><link>https://www.federalreserve.gov/newsevents/pressreleases/enforcement20260918c.htm</link><pubDate>Fri, 18 Sep 2026 15:10:00 GMT</pubDate></item>
<item><title>Federal Reserve Board approves application by Bank D</title><link>https://www.federalreserve.gov/newsevents/pressreleases/orders20260918d.htm</link><pubDate>Fri, 18 Sep 2026 16:00:00 GMT</pubDate></item>
<item><title>Federal Reserve issues FOMC statement</title><link>https://www.federalreserve.gov/newsevents/pressreleases/monetary20260916a.htm</link><pubDate>Wed, 16 Sep 2026 18:00:00 GMT</pubDate></item>
<item><title>Minutes of the Federal Open Market Committee, July 28-29, 2026</title><link>https://www.federalreserve.gov/newsevents/pressreleases/monetary20260917a.htm</link><pubDate>Thu, 17 Sep 2026 18:00:00 GMT</pubDate></item>
<item><title>Speech by Governor X: Inflation and the Path of Interest Rates</title><link>https://www.federalreserve.gov/newsevents/speech/x20260917a.htm</link><pubDate>Thu, 17 Sep 2026 14:30:00 GMT</pubDate></item>
</channel></rss>`;
const FOMC_FEED = `<rss><channel>
<item><title>Federal Reserve issues FOMC statement</title><link>https://www.federalreserve.gov/newsevents/pressreleases/monetary20260916a.htm</link><pubDate>Wed, 16 Sep 2026 18:00:00 GMT</pubDate></item>
<item><title>Minutes of the Federal Open Market Committee, July 28-29, 2026</title><link>https://www.federalreserve.gov/newsevents/pressreleases/monetary20260917a.htm</link><pubDate>Thu, 17 Sep 2026 18:00:00 GMT</pubDate></item>
</channel></rss>`;

test('sources: the FOMC statement (from the FOMC feed) comes first with its own date; other items are ranked by relevance and capped at three', async () => {
  const items = fb.parseRss(FOMC_FEED).map((it) => Object.assign({ feed: 'fomc' }, it)).concat(fb.parseRss(PRESS_ALL).map((it) => Object.assign({ feed: 'press' }, it)));
  const seen = new Set();
  const fresh = items.filter((it) => !seen.has(it.link) && seen.add(it.link));
  const picked = fb.selectItems(fresh);
  assert.equal(picked.statement.feed, 'fomc');
  assert.equal(picked.statement.published.slice(0, 10), '2026-09-16');
  assert.equal(picked.others[0].title, 'Speech by Governor X: Inflation and the Path of Interest Rates', 'inflation + rates outranks everything else');
  assert.ok(/Minutes/.test(picked.others[1].title), 'FOMC minutes next');
  assert.ok(picked.others.slice(2).every((it) => /enforcement|application/i.test(it.title)), 'enforcement actions and applications rank last');
  assert.ok(fb.relevanceScore('Federal Reserve Board announces enforcement action') < 0);
  assert.ok(fb.relevanceScore('Statement on monetary policy and rates') > fb.relevanceScore('Speech on the economy'));
  const answer = { stance_score: 1.5, next_meeting_lean: 'hike', next_meeting_date: '2026-10-28', summary: 'Hawkish. Hike likely.', key_phrases: [], confidence: 0.8 };
  const net = fakeNet({ prev: Object.assign({}, PREV, { brief_date: '2026-09-15' }), rss: PRESS_ALL, fomcRss: FOMC_FEED, anthropic: { content: [{ type: 'text', text: JSON.stringify(answer) }], stop_reason: 'end_turn' } });
  const out = await fb.runBrief({ env: ENV, fetch: net.fetchImpl, today: '2026-09-20', log });
  const src = out.row.sources;
  assert.equal(src.length, 4, 'statement + three others');
  assert.equal(src[0].kind, 'statement'); assert.equal(src[0].published, '2026-09-16'); assert.equal(src[0].url, 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20260916a.htm');
  assert.equal(src[1].kind, 'other'); assert.ok(/Inflation and the Path/.test(src[1].title));
  assert.ok(/Minutes/.test(src[2].title));
  assert.equal(src.filter((x) => /enforcement|application/i.test(x.title)).length, 1, 'only one low-relevance item (enforcement / application) survives the cap of three');
  assert.equal(src.filter((x) => x.url === src[0].url).length, 1, 'the statement is not duplicated from press_all');
  assert.equal(out.row.model_json.last_statement.published, '2026-09-16');
  assert.equal(out.row.model_json.items_fresh, fresh.length);
  const prompt = JSON.parse(net.calls.find((c) => c.url.includes('api.anthropic.com')).opts.body).messages[0].content;
  assert.ok(prompt.indexOf('Federal Reserve issues FOMC statement') < prompt.indexOf('Inflation and the Path'), 'the model sees the statement first');
  // a copy-forward keeps the last statement so the card can still date it
  const net2 = fakeNet({ prev: out.row, rss: '', fomcRss: '' });
  const copied = await fb.runBrief({ env: ENV, fetch: net2.fetchImpl, today: '2026-09-21', log });
  assert.equal(copied.action, 'copied');
  assert.equal(copied.row.model_json.last_statement.published, '2026-09-16');
});
