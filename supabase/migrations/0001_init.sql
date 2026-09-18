-- Smoke & Breath — schema
-- Run against the Supabase SQL editor, or: psql "$DATABASE_URL" -f this file

create extension if not exists postgis;

-- ─────────────────────────────────────────────────────────────────────
-- Provenance root. One row per upstream feed.
-- ─────────────────────────────────────────────────────────────────────
create table if not exists sources (
  id            text primary key,              -- 'firms','openaq','open_meteo','nws'
  name          text not null,
  homepage      text not null,
  license       text,
  cadence_sec   int  not null,                 -- expected refresh; drives staleness
  can_backfill  boolean not null default true, -- false for NWS (active-only endpoint)
  coverage_geom geography(Polygon, 4326),      -- null = global; NWS = US only
  coverage_note text,                          -- shown in the UI where data is absent
  created_at    timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────
-- Every provider response, verbatim. This is what evidence drill-down shows.
-- ─────────────────────────────────────────────────────────────────────
create table if not exists raw_payloads (
  id           bigserial primary key,
  source_id    text not null references sources(id),
  request_url  text not null,
  fetched_at   timestamptz not null default now(),
  status       int,
  body         text
);
create index if not exists raw_payloads_source_time_idx
  on raw_payloads (source_id, fetched_at desc);

-- ─────────────────────────────────────────────────────────────────────
-- Measurement locations. Wind and PM2.5 share station ids where they are
-- co-located, which is what makes the upwind join cheap.
-- ─────────────────────────────────────────────────────────────────────
create table if not exists stations (
  id           bigserial primary key,
  source_id    text not null references sources(id),
  external_id  text not null,
  name         text,
  geom         geography(Point, 4326) not null,
  history_tier char(1) not null default 'B',  -- 'A' = 7d backfill, 'B' = live edge only
  metadata     jsonb not null default '{}',
  created_at   timestamptz not null default now(),
  unique (source_id, external_id)
);
create index if not exists stations_geom_idx on stations using gist (geom);
create index if not exists stations_tier_idx on stations (history_tier);

-- ─────────────────────────────────────────────────────────────────────
-- The fact table. One row per (station, param, hour).
--   observed_at = when the world was measured
--   ingested_at = when we learned about it
-- That split is what makes honest staleness reporting possible.
-- ─────────────────────────────────────────────────────────────────────
create table if not exists observations (
  station_id   bigint      not null references stations(id) on delete cascade,
  param        text        not null,  -- 'pm25','wind_speed_10m','wind_direction_10m','rh'
  observed_at  timestamptz not null,
  ingested_at  timestamptz not null default now(),
  value        double precision,
  unit         text        not null,
  quality_flag text,                  -- provider flag; null = clean
  raw_id       bigint references raw_payloads(id),
  primary key (station_id, param, observed_at)
);
create index if not exists observations_param_time_idx
  on observations (param, observed_at desc);
create index if not exists observations_time_idx
  on observations (observed_at desc);

-- ─────────────────────────────────────────────────────────────────────
-- Point-in-time events (fire detections) and polygons (weather alerts).
-- ─────────────────────────────────────────────────────────────────────
create table if not exists events (
  id          bigserial primary key,
  source_id   text not null references sources(id),
  kind        text not null,               -- 'fire_detection' | 'nws_alert'
  external_id text not null,
  geom        geography not null,
  valid_from  timestamptz not null,
  valid_to    timestamptz,
  attrs       jsonb not null default '{}', -- frp, confidence, satellite, severity...
  ingested_at timestamptz not null default now(),
  raw_id      bigint references raw_payloads(id),
  unique (source_id, kind, external_id)
);
create index if not exists events_geom_idx on events using gist (geom);
create index if not exists events_kind_time_idx on events (kind, valid_from desc);

-- ─────────────────────────────────────────────────────────────────────
-- Ingest observability. A failed run is a visible row, never a silent gap.
-- ─────────────────────────────────────────────────────────────────────
create table if not exists ingest_runs (
  id           bigserial primary key,
  source_id    text not null references sources(id),
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  ok           boolean,                    -- null = in flight
  rows_written int not null default 0,
  window_from  timestamptz,
  window_to    timestamptz,
  error        text
);
create index if not exists ingest_runs_source_time_idx
  on ingest_runs (source_id, started_at desc);

-- ─────────────────────────────────────────────────────────────────────
-- Stampede guard. A lease table rather than pg_try_advisory_lock:
-- session-level advisory locks are owned by a CONNECTION, and Supabase's
-- transaction pooler hands our connection to someone else between
-- statements, so the lock would be orphaned. expires_at means a crashed
-- invocation's lease lapses instead of wedging the source forever.
-- ─────────────────────────────────────────────────────────────────────
create table if not exists ingest_locks (
  source_id   text primary key references sources(id),
  acquired_at timestamptz not null default now(),
  expires_at  timestamptz not null
);

-- ─────────────────────────────────────────────────────────────────────
-- Agent provenance. Every tool call becomes a citable evidence row.
-- ─────────────────────────────────────────────────────────────────────
create table if not exists queries (
  id         uuid primary key default gen_random_uuid(),
  question   text not null,
  answer     jsonb,
  context    jsonb,
  created_at timestamptz not null default now()
);

create table if not exists evidence (
  id         bigserial primary key,
  query_id   uuid references queries(id) on delete cascade,
  label      text not null,              -- 'E1','E2', ...
  tool       text not null,
  args       jsonb not null,
  result     jsonb not null,
  source_ids text[] not null default '{}',
  raw_ids    bigint[] not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists evidence_query_idx on evidence (query_id);

-- ─────────────────────────────────────────────────────────────────────
-- Seed the feeds.
-- ─────────────────────────────────────────────────────────────────────
insert into sources (id, name, homepage, license, cadence_sec, can_backfill, coverage_geom, coverage_note)
values
  ('firms', 'NASA FIRMS (VIIRS active fire)', 'https://firms.modaps.eosdis.nasa.gov',
   'NASA Earthdata open', 1800, true, null,
   'Global. Satellite detections typically arrive with ~3h latency.'),

  ('openaq', 'OpenAQ v3', 'https://openaq.org',
   'CC BY 4.0 (varies by provider)', 900, true, null,
   'Global, but station density varies widely by country.'),

  ('open_meteo', 'Open-Meteo', 'https://open-meteo.com',
   'CC BY 4.0', 1800, true, null,
   'Global model output, not station observations.'),

  -- NWS stops at the US border. Modelled as data so the UI can explain the
  -- Canadian gap rather than rendering an unexplained blank. A CONUS bounding
  -- polygon is sufficient here; a precise national boundary is wasted effort.
  ('nws', 'NOAA / National Weather Service alerts', 'https://api.weather.gov',
   'US Government public domain', 900, false,
   st_makeenvelope(-125, 24, -66.5, 49.5, 4326)::geography,
   'NWS issues alerts for US territory only. Areas outside it have no alert coverage — this is not the same as having no alerts.')
on conflict (id) do update set
  name          = excluded.name,
  homepage      = excluded.homepage,
  license       = excluded.license,
  cadence_sec   = excluded.cadence_sec,
  can_backfill  = excluded.can_backfill,
  coverage_geom = excluded.coverage_geom,
  coverage_note = excluded.coverage_note;
