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

## Supabase: one-time SQL

Run each file in `supabase/migrations/` once, in filename order, in the Supabase dashboard
(**SQL Editor → New query → paste → Run**):

1. `20260920000000_fed_briefs.sql` — creates `fed_briefs` with row-level security
   (anon/authenticated can `SELECT`; only the service role can write).

## Tests

```
npm test
```

Runs the pure-model unit tests, the FRED and Fed-brief function tests, the backtest, and a jsdom
QA harness that boots the whole app for every sector.
