-- Outlook vs. Consensus: externally sourced Fed funds paths, entered by the
-- owner (never scraped). Display and scoring only — the app never feeds these
-- into its own forecast. Run once in the Supabase dashboard (SQL Editor).

create table if not exists public.consensus_paths (
  id          bigint generated always as identity primary key,
  as_of       date not null,                       -- date the consensus was observed
  source      text not null,                       -- e.g. "CME FedWatch", "StreetStats", "Bank note", "FedWatch (manual)"
  m3          numeric(5,2) check (m3  is null or (m3  >= 0 and m3  <= 10)), -- expected Fed funds rate (%) at 3 months
  m6          numeric(5,2) check (m6  is null or (m6  >= 0 and m6  <= 10)),
  m12         numeric(5,2) check (m12 is null or (m12 >= 0 and m12 <= 10)),
  m18         numeric(5,2) check (m18 is null or (m18 >= 0 and m18 <= 10)),
  note        text,
  created_at  timestamptz not null default now(),
  constraint consensus_paths_some_horizon check (m3 is not null or m6 is not null or m12 is not null or m18 is not null),
  constraint consensus_paths_not_future check (as_of <= (now() at time zone 'utc')::date)
);
comment on table public.consensus_paths is 'Owner-entered consensus Fed funds paths (percent at 3/6/12/18 months). Display and scoring only; never a model input.';

create index if not exists consensus_paths_as_of_idx on public.consensus_paths (as_of desc, created_at desc);

alter table public.consensus_paths enable row level security;
drop policy if exists "consensus_paths anon read" on public.consensus_paths;
create policy "consensus_paths anon read"
  on public.consensus_paths for select
  to anon, authenticated
  using (true);
-- No insert policy: writes come only from api/consensus.js with the service role (bypasses RLS).
revoke insert, update, delete on public.consensus_paths from anon, authenticated;
grant select on public.consensus_paths to anon, authenticated;
