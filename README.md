# RateShield AI

Single-file financial decision app (`index.html`) with Vercel serverless functions in `api/`.

## Serverless functions

| Route | File | Purpose |
|---|---|---|
| `/api/chat` | `api/chat.js` | Executive Advisor (Anthropic API proxy) |
| `/api/fred` | `api/fred.js` | Live macro snapshot from FRED (DFF, CPIAUCSL, PCEPILFE, UNRATE, real GDP, DGS10, DGS6MO, DGS2, plus 3-month-earlier values) |
| `/api/fed-brief` | `api/fed-brief.js` | Daily Fed briefing: reads federalreserve.gov feeds, scores the Fed's stance, writes one row per day to Supabase `fed_briefs` |

## Environment variables (Vercel → Project → Settings → Environment Variables)

| Variable | Used by | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | `api/chat.js`, `api/fed-brief.js` | Already set. |
| `FRED_API_KEY` | `api/fred.js`, `api/fed-brief.js` | Already set. Never placed in the HTML. |
| `SUPABASE_SERVICE_ROLE_KEY` | `api/fed-brief.js` | Supabase → Project Settings → API → `service_role`. **Server only — never expose it to the browser.** It bypasses row-level security, which is how the brief gets written. |
| `CRON_SECRET` | `api/fed-brief.js` | Any long random string (e.g. `openssl rand -hex 32`). Vercel sends it as `Authorization: Bearer $CRON_SECRET` on every cron invocation, and the endpoint refuses requests without it. |
| `SUPABASE_URL` | `api/fed-brief.js` | Optional. Defaults to the project URL already in `index.html`. |
| `OWNER_EMAIL` | `api/fed-brief.js` | Optional. Defaults to the owner address in `index.html`; a logged-in user with this email may trigger the brief manually. |

## Daily Fed brief schedule

`vercel.json` declares one cron: `/api/fed-brief` at `0 11 * * *` (11:00 UTC = 7:00 am ET).
Vercel calls it with `Authorization: Bearer $CRON_SECRET`, so set `CRON_SECRET` before the first run.
The **Vercel Hobby plan allows one cron job and it may only run once a day**, which is exactly what
this schedule uses — adding a second cron or a more frequent schedule requires the Pro plan.

To trigger it by hand:

```
curl -H "Authorization: Bearer $CRON_SECRET" https://rateshieldai.com/api/fed-brief
```

## Supabase: one-time SQL

Run each file in `supabase/migrations/` once, in filename order, in the Supabase dashboard
(**SQL Editor → New query → paste → Run**):

1. `20260920000000_fed_briefs.sql` — creates `fed_briefs` with row-level security
   (anon/authenticated can `SELECT`; only the service role can write).
2. `20260920000001_fed_brief_scores.sql` — creates `fomc_decisions` (one row per meeting, entered by hand)
   and the `fed_brief_scores` / `fed_brief_score_summary` views that mark each brief's
   `next_meeting_lean` as hit or miss once the meeting's decision is entered.
3. `20260921000000_consensus_paths.sql` — creates `consensus_paths` (owner-entered expected Fed funds
   rate at 3/6/12/18 months from a named source; anon `SELECT`, service-role insert only). These rows are
   shown and scored against RateShield's outlook but never enter the model.

## Scorekeeping after each FOMC meeting

Every daily brief logs its `next_meeting_lean` and `next_meeting_date`. After a meeting, enter the decision once
(SQL Editor), e.g. a 25 bp hike on 28 October 2026:

```sql
insert into public.fomc_decisions (meeting_date, change_pts, source)
values ('2026-10-28', 0.25, 'FOMC statement 2026-10-28')
on conflict (meeting_date) do update set change_pts = excluded.change_pts, source = excluded.source;
```

Then `select * from fed_brief_scores;` shows hit / miss per brief and `select * from fed_brief_score_summary;`
the tally per meeting. The historical backtest in `index.html` has a `fedStance` slot on every episode
(currently `null`); fill them from the FOMC statement archives to backtest the stance term.

## Tests

```
npm test
```

Runs the pure-model unit tests, the FRED and Fed-brief function tests, the backtest, and a jsdom
QA harness that boots the whole app for every sector.
