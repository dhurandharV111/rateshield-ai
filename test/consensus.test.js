'use strict';
// Offline tests for api/consensus.js: FedWatch-derived 3-month point, validation bounds, auth, insert.
const test = require('node:test');
const assert = require('node:assert/strict');

let cs;
test('api/consensus.js loads', async () => {
  cs = await import('../api/consensus.js');
  assert.equal(typeof cs.default, 'function');
});

test('fedWatchM3: current + 0.25 × (hike% − cut%) / 100', () => {
  assert.ok(Math.abs(cs.fedWatchM3(3.88, 70, 5) - (3.88 + 0.25 * 0.65)) < 1e-3, '3.88 + 0.1625 ≈ 4.043 (rounded to 3 dp)');
  assert.equal(cs.fedWatchM3(3.88, 0, 80), 3.68);
  assert.equal(cs.fedWatchM3(3.88, 40, 40), 3.88);
  assert.equal(cs.fedWatchM3(3.88, 100, null), 4.13, 'a missing cut % counts as 0');
  assert.equal(cs.fedWatchM3(3.88, null, null), null, 'nothing entered → nothing derived');
  assert.equal(cs.fedWatchM3(null, 50, 0), null);
});

test('validateConsensus: bounds 0–10, dates not in the future, at least one horizon, source required', () => {
  const today = '2026-09-21';
  const ok = cs.validateConsensus({ as_of: '2026-09-21', source: ' CME FedWatch ', m3: '3.9', m6: 3.75, m12: '', m18: null, note: 'x' }, today);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.row, { as_of: '2026-09-21', source: 'CME FedWatch', m3: 3.9, m6: 3.75, m12: null, m18: null, note: 'x' });
  assert.deepEqual(cs.validateConsensus({ as_of: '2026-09-22', source: 's', m3: 4 }, today).problems, ['as_of cannot be in the future']);
  assert.deepEqual(cs.validateConsensus({ as_of: '2026-09-21', source: 's', m3: 10.01 }, today).problems, ['m3 must be between 0 and 10 %']);
  assert.deepEqual(cs.validateConsensus({ as_of: '2026-09-21', source: 's', m12: -0.5 }, today).problems, ['m12 must be between 0 and 10 %']);
  assert.equal(cs.validateConsensus({ as_of: '2026-09-21', source: 's', m3: 0, m18: 10 }, today).ok, true, 'edges allowed');
  assert.deepEqual(cs.validateConsensus({ as_of: '2026-09-21', source: 's', m3: 'four' }, today).problems, ['m3 must be a number']);
  assert.deepEqual(cs.validateConsensus({ as_of: '2026-09-21', source: 's' }, today).problems, ['enter at least one horizon (m3, m6, m12 or m18)']);
  assert.deepEqual(cs.validateConsensus({ as_of: '2026-09-21', m3: 4 }, today).problems, ['source is required']);
  assert.deepEqual(cs.validateConsensus({ as_of: 'yesterday', source: 's', m3: 4 }, today).problems, ['as_of must be a date (YYYY-MM-DD)']);
  assert.ok(cs.validateConsensus({ as_of: '2026-09-21', source: 'x'.repeat(81), m3: 4 }, today).problems[0].includes('too long'));
  assert.ok(cs.validateConsensus({ as_of: '2026-09-21', source: 's', m3: 4, note: 'n'.repeat(501) }, today).problems[0].includes('note is too long'));
  assert.equal(cs.validateConsensus(null, today).ok, false);
});

test('handler: owner or cron only, validates, inserts with the service role', async () => {
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    if (url.includes('/auth/v1/user')) return { ok: true, status: 200, json: async () => ({ email: 'rajatinpa@gmail.com' }) };
    if (url.includes('/rest/v1/consensus_paths')) return { ok: true, status: 201, json: async () => [Object.assign({ id: 7, created_at: 'now' }, JSON.parse(opts.body))], text: async () => '' };
    throw new Error('unexpected ' + url);
  };
  const saved = { s: process.env.SUPABASE_SERVICE_ROLE_KEY, c: process.env.CRON_SECRET };
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc'; process.env.CRON_SECRET = 'cron-secret';
  const res = () => { const r = { code: 0, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
  try {
    let r = res(); await cs.default({ method: 'GET', headers: {} }, r); assert.equal(r.code, 405);
    r = res(); await cs.default({ method: 'POST', headers: {}, body: {} }, r); assert.equal(r.code, 401);
    r = res(); await cs.default({ method: 'POST', headers: { authorization: 'Bearer cron-secret' }, body: { as_of: '2999-01-01', source: 's', m3: 4 } }, r);
    assert.equal(r.code, 400); assert.deepEqual(r.body.problems, ['as_of cannot be in the future']);
    r = res(); await cs.default({ method: 'POST', headers: { authorization: 'Bearer aaa.bbb.ccc' }, body: JSON.stringify({ as_of: '2026-09-20', source: 'Bank note', m3: 3.9, m12: 4.25, note: 'q' }) }, r);
    assert.equal(r.code, 200);
    assert.equal(r.body.via, 'owner');
    assert.equal(r.body.row.m3, 3.9); assert.equal(r.body.row.m6, null); assert.equal(r.body.row.m12, 4.25);
    const write = calls.find((c) => c.url.includes('/rest/v1/consensus_paths'));
    assert.equal(write.opts.method, 'POST');
    assert.equal(write.opts.headers.Authorization, 'Bearer svc');
  } finally {
    global.fetch = realFetch;
    process.env.SUPABASE_SERVICE_ROLE_KEY = saved.s; process.env.CRON_SECRET = saved.c;
    if (saved.s === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (saved.c === undefined) delete process.env.CRON_SECRET;
  }
});
