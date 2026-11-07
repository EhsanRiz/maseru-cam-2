-- 0002_crossing_mode.sql
-- Crowd-sourced Crossing Mode: anonymous trips measured from phone GPS while
-- the traveller is inside the Maseru Bridge geofence, plus window reports.
--
-- Privacy model:
--   * Trips are keyed by a random UUID and are NOT linked to traffic_users.
--   * Raw pings are deleted after 48 hours (server sweep); only the trip
--     summary (zone times, total minutes) is kept.
--   * The server rejects pings outside the outer geofence.

create table if not exists public.crossing_trips (
  id uuid primary key,
  key_hash text not null,                       -- sha256 of the per-trip write key
  mode text not null default 'vehicle' check (mode in ('vehicle', 'pedestrian')),
  status text not null default 'active' check (status in ('active', 'completed', 'abandoned', 'invalid')),
  direction text check (direction in ('LS_to_SA', 'SA_to_LS')),
  started_at timestamptz not null default now(),
  last_ping_at timestamptz,
  current_zone text,
  ping_count integer not null default 0,
  -- Summary, filled in when the trip is finalised
  crossing_started_at timestamptz,              -- first fix in origin-side queue/post zone
  crossing_ended_at timestamptz,                -- last fix in destination-side post zone
  total_minutes numeric,
  queue_minutes numeric,                        -- origin queue, before reaching origin post
  origin_post_minutes numeric,
  bridge_minutes numeric,
  dest_post_minutes numeric,
  finalised_at timestamptz,
  zones_version text
);

create index if not exists crossing_trips_status_idx
  on public.crossing_trips (status, last_ping_at desc);
create index if not exists crossing_trips_completed_idx
  on public.crossing_trips (direction, crossing_ended_at desc)
  where status = 'completed';

create table if not exists public.crossing_pings (
  id bigserial primary key,
  trip_id uuid not null references public.crossing_trips(id) on delete cascade,
  ts timestamptz not null,
  lat double precision not null,
  lng double precision not null,
  accuracy_m real,
  speed_mps real,
  zone text
);

create index if not exists crossing_pings_trip_idx on public.crossing_pings (trip_id, ts);
create index if not exists crossing_pings_ts_idx on public.crossing_pings (ts);

create table if not exists public.crossing_window_reports (
  id uuid primary key default gen_random_uuid(),
  reported_at timestamptz not null default now(),
  direction text not null check (direction in ('LS_to_SA', 'SA_to_LS')),
  post text not null check (post in ('ls_departure', 'sa_arrival', 'sa_departure', 'ls_arrival')),
  mode text not null default 'vehicle' check (mode in ('vehicle', 'pedestrian')),
  windows_open smallint check (windows_open between 0 and 50),
  people_ahead smallint check (people_ahead between 0 and 2000),
  minutes_at_window numeric check (minutes_at_window >= 0 and minutes_at_window <= 600),
  queue_minutes numeric check (queue_minutes >= 0 and queue_minutes <= 900),
  trip_id uuid references public.crossing_trips(id) on delete set null
);

create index if not exists crossing_window_reports_idx
  on public.crossing_window_reports (direction, post, reported_at desc);

-- Server uses the service-role key; RLS on with no policies blocks anon access.
alter table public.crossing_trips enable row level security;
alter table public.crossing_pings enable row level security;
alter table public.crossing_window_reports enable row level security;
