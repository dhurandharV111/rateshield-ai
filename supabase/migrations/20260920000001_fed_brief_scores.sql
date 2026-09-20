-- Scorekeeping for the daily Fed brief.
--
-- Each fed_briefs row already logs next_meeting_lean and next_meeting_date.
-- After every FOMC meeting, record the decision once in fomc_decisions; the
-- fed_brief_scores view then marks every brief that pointed at that meeting
-- as hit / miss. Run once in the Supabase dashboard (SQL Editor).

create table if not exists public.fomc_decisions (
  meeting_date  date primary key,                 -- last day of the meeting (matches fed_briefs.next_meeting_date)
  change_pts    numeric(4,2) not null,            -- +0.25 hike, 0 hold, -0.25 cut …
  source        text not null default 'FOMC statement',
  created_at    timestamptz not null default now()
);
comment on table public.fomc_decisions is 'One row per FOMC meeting: the change in the target range, entered by hand after each statement.';

alter table public.fomc_decisions enable row level security;
drop policy if exists "fomc_decisions anon read" on public.fomc_decisions;
create policy "fomc_decisions anon read" on public.fomc_decisions for select to anon, authenticated using (true);
revoke insert, update, delete on public.fomc_decisions from anon, authenticated;
grant select on public.fomc_decisions to anon, authenticated;

-- One row per brief: what it called, what happened, and whether it was right.
-- `hit` is null until the meeting's decision has been entered.
create or replace view public.fed_brief_scores as
select
  b.brief_date,
  b.stance_score,
  b.next_meeting_lean,
  b.next_meeting_date,
  d.change_pts                                   as actual_change_pts,
  case when d.change_pts is null then null
       when d.change_pts > 0 then 'hike'
       when d.change_pts < 0 then 'cut'
       else 'hold' end                           as actual_direction,
  case when d.change_pts is null then null
       when d.change_pts > 0 then b.next_meeting_lean = 'hike'
       when d.change_pts < 0 then b.next_meeting_lean = 'cut'
       else b.next_meeting_lean = 'hold' end     as hit,
  (b.model_json ->> 'copied_from') is not null   as copied_forward
from public.fed_briefs b
left join public.fomc_decisions d on d.meeting_date = b.next_meeting_date
order by b.brief_date desc;

grant select on public.fed_brief_scores to anon, authenticated;

-- Running tally per meeting (only briefs whose meeting has a decision).
create or replace view public.fed_brief_score_summary as
select next_meeting_date, actual_direction,
       count(*)                       as briefs,
       count(*) filter (where hit)    as hits,
       round(100.0 * count(*) filter (where hit) / count(*), 0) as hit_pct
from public.fed_brief_scores
where hit is not null
group by next_meeting_date, actual_direction
order by next_meeting_date desc;

grant select on public.fed_brief_score_summary to anon, authenticated;

-- Example, after the 28 October 2026 meeting (edit the numbers):
--   insert into public.fomc_decisions (meeting_date, change_pts, source)
--   values ('2026-10-28', 0.25, 'FOMC statement 2026-10-28')
--   on conflict (meeting_date) do update set change_pts = excluded.change_pts, source = excluded.source;
