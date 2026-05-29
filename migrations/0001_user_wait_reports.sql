-- 0001_user_wait_reports.sql
-- Stores user-submitted wait-time reports (from chat extraction + the
-- explicit "report your wait" form on the home page). Used to compute
-- rolling bias against the live detector estimate so the public-facing
-- wait time converges on ground truth.

create table if not exists public.user_wait_reports (
  id uuid primary key default gen_random_uuid(),
  reported_at timestamptz not null default now(),
  direction text not null check (direction in ('LS_to_SA', 'SA_to_LS')),
  segment text not null check (segment in ('bridge', 'canopy', 'engen', 'sa_side', 'total')),
  reported_minutes numeric not null check (reported_minutes > 0 and reported_minutes <= 600),
  detector_estimate_minutes numeric,
  source text not null default 'form' check (source in ('chat', 'form')),
  raw_text text
);

create index if not exists user_wait_reports_reported_at_idx
  on public.user_wait_reports (reported_at desc);

create index if not exists user_wait_reports_lookup_idx
  on public.user_wait_reports (direction, segment, reported_at desc);

-- RLS: server uses the service-role key, so we don't actually need policies
-- for the app, but enabling RLS is best practice in case the anon key is
-- ever exposed.
alter table public.user_wait_reports enable row level security;
