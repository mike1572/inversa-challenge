-- NWS alert geometry cache.
--
-- Only ~10% of active NWS alerts carry an inline polygon; the rest reference
-- forecast/county zones by URL, and the smoke-relevant ones (Air Quality Alert,
-- Red Flag Warning) are almost always in that group. Resolving a zone costs one
-- request, but zone boundaries are effectively static, so they are fetched once
-- and reused forever. Without this cache a cold serverless invocation would
-- issue dozens of zone requests per alert refresh.

create table if not exists nws_zones (
  id         text primary key,          -- the zone API URL
  name       text,
  geom       geography not null,
  fetched_at timestamptz not null default now()
);
create index if not exists nws_zones_geom_idx on nws_zones using gist (geom);
