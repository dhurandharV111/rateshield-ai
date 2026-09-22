-- Scorekeeping for Outlook vs. Consensus.
--
-- forecast_log: one row per (date, horizon) holding the Fed funds rate each
-- source expected for that horizon on that date. The daily /api/fed-brief job
-- writes RateShield's blended and model paths and the market-implied path;
-- /api/consensus adds the consensus columns whenever a path is logged.
--
-- After each FOMC meeting, add the post-meeting rate to fomc_decisions
-- (rate_after); the views then score every 3-month forecast made ~90 days
-- before that meeting. Run once in the Supabase dashboard (SQL Editor).

alter table public.fomc_decisions add column if not exists rate_after numeric(5,2)
  check (rate_after is null or (rate_after >= 0 and rate_after <= 25));
comment on column public.fomc_decisions.rate_after is 'Effective Fed funds rate (or target-range midpoint) after the meeting, %. Needed to score forecast errors.';

create table if not exists public.forecast_log (
  log_date            date not null,
  horizon             smallint not null check (horizon in (3, 6, 12, 18)),
  rateshield_blended  numeric(5,2),
  rateshield_model    numeric(5,2),
  market              numeric(5,2),
  consensus           numeric(5,2),
  consensus_source    text,
  current_rate        numeric(5,2),          -- shared origin on log_date
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  primary key (log_date, horizon)
);
comment on table public.forecast_log is 'Expected Fed funds rate (%) per source at each horizon, one row per date and horizon. Written only by the serverless functions.';

alter table public.forecast_log enable row level security;
drop policy if exists "forecast_log anon read" on public.forecast_log;
create policy "forecast_log anon read" on public.forecast_log for select to anon, authenticated using (true);
revoke insert, update, delete on public.forecast_log from anon, authenticated;
grant select on public.forecast_log to anon, authenticated;

-- For each scored meeting: the 3-month forecast made closest to 90 days before
-- it (within ±21 days) and each source's absolute error against rate_after.
create or replace view public.forecast_errors_3m as
select
  d.meeting_date,
  d.rate_after,
  l.log_date,
  l.rateshield_blended,
  l.market,
  l.consensus,
  l.consensus_source,
  abs(l.rateshield_blended - d.rate_after) as rateshield_abs_error,
  abs(l.market            - d.rate_after) as market_abs_error,
  abs(l.consensus         - d.rate_after) as consensus_abs_error
from public.fomc_decisions d
cross join lateral (
  select * from public.forecast_log f
  where f.horizon = 3
    and f.log_date between d.meeting_date - 111 and d.meeting_date - 69
  order by abs(f.log_date - (d.meeting_date - 90)) asc, f.log_date desc
  limit 1
) l
where d.rate_after is not null
order by d.meeting_date desc;

grant select on public.forecast_errors_3m to anon, authenticated;

-- One row: mean absolute 3-month error per source over every scored meeting.
create or replace view public.forecast_error_summary as
select
  count(*)                                                  as n_meetings,
  round(avg(rateshield_abs_error)::numeric, 2)              as rateshield_mae,
  round(avg(market_abs_error)::numeric, 2)                  as market_mae,
  round(avg(consensus_abs_error)::numeric, 2)               as consensus_mae,
  count(consensus_abs_error)                                as consensus_n,
  max(meeting_date)                                         as last_meeting
from public.forecast_errors_3m;

grant select on public.forecast_error_summary to anon, authenticated;

-- Example, after the 28 October 2026 meeting (edit the numbers):
--   insert into public.fomc_decisions (meeting_date, change_pts, rate_after, source)
--   values ('2026-10-28', 0.25, 4.13, 'FOMC statement 2026-10-28')
--   on conflict (meeting_date) do update
--     set change_pts = excluded.change_pts, rate_after = excluded.rate_after, source = excluded.source;
