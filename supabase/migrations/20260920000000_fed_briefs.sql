-- Daily Fed briefing assistant: one row per day written by /api/fed-brief
-- (service role only). The browser reads the latest row with the anon key.
--
-- Run once in the Supabase dashboard: SQL Editor → New query → paste → Run.

create table if not exists public.fed_briefs (
  id                 bigint generated always as identity primary key,
  brief_date         date        not null unique,
  stance_score       numeric(3,2) not null check (stance_score >= -2 and stance_score <= 2),
  next_meeting_lean  text        not null check (next_meeting_lean in ('hike', 'hold', 'cut')),
  next_meeting_date  date,
  summary            text        not null,            -- at most two sentences
  key_phrases        jsonb       not null default '[]'::jsonb,
  sources            jsonb       not null default '[]'::jsonb, -- [{title, url, published}]
  fed_funds_at_brief numeric(5,2),
  model_json         jsonb       not null default '{}'::jsonb, -- full structured answer (or copy-forward note)
  created_at         timestamptz not null default now()
);

comment on table public.fed_briefs is 'Daily Fed stance brief produced by api/fed-brief.js. stance_score: -2 (very dovish) .. +2 (very hawkish).';

create index if not exists fed_briefs_brief_date_idx on public.fed_briefs (brief_date desc);

-- Row-level security: anonymous visitors may read; nobody but the service role
-- may write (the service role bypasses RLS, so no insert policy is granted).
alter table public.fed_briefs enable row level security;

drop policy if exists "fed_briefs anon read" on public.fed_briefs;
create policy "fed_briefs anon read"
  on public.fed_briefs for select
  to anon, authenticated
  using (true);

-- Belt and braces: even if a client-side policy were added later, the anon and
-- authenticated roles hold no table-level write privileges.
revoke insert, update, delete on public.fed_briefs from anon, authenticated;
grant select on public.fed_briefs to anon, authenticated;
