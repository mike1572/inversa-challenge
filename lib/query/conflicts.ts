import { sql } from "../db";

export interface Conflict {
  at: string;
  a: { stationId: number; name: string; value: number; isMonitor: boolean };
  b: { stationId: number; name: string; value: number; isMonitor: boolean };
  distanceMeters: number;
  disagreementPct: number;
}

/**
 * Co-located sensors that disagree.
 *
 * OpenAQ hosts reference-grade monitors and low-cost sensors, sometimes within
 * a kilometre of each other, reporting materially different PM2.5. This is
 * real, not contrived — and surfacing both values beats silently averaging them
 * or picking one.
 *
 * The `greatest(...) > 12` floor matters: without it, 1 vs 2 µg/m³ registers as
 * a 50% disagreement and the panel fills with noise on clean days.
 */
export async function findConflicts(opts: {
  from: Date;
  to: Date;
  thresholdPct?: number;
  withinMeters?: number;
  limit?: number;
}): Promise<Conflict[]> {
  const threshold = (opts.thresholdPct ?? 30) / 100;
  const within = opts.withinMeters ?? 2000;

  const rows = await sql<{
    observed_at: Date;
    a_id: string; a_name: string; a_val: number; a_monitor: boolean;
    b_id: string; b_name: string; b_val: number; b_monitor: boolean;
    meters: number; pct: number;
  }>(
    `select a.observed_at,
            sa.id as a_id, coalesce(sa.name, 'Station ' || sa.id) as a_name,
            a.value as a_val,
            coalesce((sa.metadata->>'isMonitor')::boolean, false) as a_monitor,
            sb.id as b_id, coalesce(sb.name, 'Station ' || sb.id) as b_name,
            b.value as b_val,
            coalesce((sb.metadata->>'isMonitor')::boolean, false) as b_monitor,
            st_distance(sa.geom, sb.geom) as meters,
            abs(a.value - b.value) / nullif(greatest(a.value, b.value), 0) as pct
       from observations a
       join stations sa on sa.id = a.station_id
       join stations sb on sb.id > sa.id                 -- each pair once
                       and sb.source_id = 'openaq'
                       and st_dwithin(sa.geom, sb.geom, $3)
       join observations b on b.station_id = sb.id
                          and b.param = 'pm25'
                          and b.observed_at = a.observed_at
                          and b.value is not null
      where a.param = 'pm25'
        and a.value is not null
        and sa.source_id = 'openaq'
        and a.observed_at >= $1::timestamptz
        and a.observed_at <  $2::timestamptz
        and greatest(a.value, b.value) > 12
        and abs(a.value - b.value) / nullif(greatest(a.value, b.value), 0) > $4
      order by a.observed_at desc,
               abs(a.value - b.value) desc
      limit $5`,
    [
      opts.from.toISOString(),
      opts.to.toISOString(),
      within,
      threshold,
      Math.min(opts.limit ?? 50, 200),
    ],
  );

  return rows.map((r) => ({
    at: r.observed_at.toISOString(),
    a: {
      stationId: Number(r.a_id),
      name: r.a_name,
      value: Math.round(Number(r.a_val) * 10) / 10,
      isMonitor: r.a_monitor,
    },
    b: {
      stationId: Number(r.b_id),
      name: r.b_name,
      value: Math.round(Number(r.b_val) * 10) / 10,
      isMonitor: r.b_monitor,
    },
    distanceMeters: Math.round(Number(r.meters)),
    disagreementPct: Math.round(Number(r.pct) * 100),
  }));
}

export interface UncorroboratedReading {
  stationId: number;
  name: string;
  value: number;
  at: string;
  isMonitor: boolean;
  historyTier: string;
  neighboursChecked: number;
  radiusKm: number;
}

/**
 * Extreme readings with no nearby sensor to confirm them.
 *
 * Distinct from a conflict, and more dangerous. A conflict at least has two
 * measurements to weigh; this is one sensor claiming something alarming with
 * nothing to check it against. The worst reading in this archive — 412 µg/m³,
 * "Hazardous" on the EPA scale — is a low-cost sensor with no neighbour inside
 * 20 km. Reported naively it would read as a public health emergency.
 *
 * We do not drop these: the outlier might be a real, very local plume. We label
 * them, so the agent can say "one uncorroborated low-cost sensor reports X"
 * instead of "the air is hazardous".
 */
export async function findUncorroboratedExtremes(opts: {
  from: Date;
  to: Date;
  thresholdUgM3?: number;
  radiusKm?: number;
  limit?: number;
}): Promise<UncorroboratedReading[]> {
  const threshold = opts.thresholdUgM3 ?? 55.4; // EPA "Unhealthy" boundary
  const radiusKm = opts.radiusKm ?? 20;

  const rows = await sql<{
    id: string; name: string; value: number; observed_at: Date;
    monitor: boolean; history_tier: string; neighbours: string;
  }>(
    `select s.id,
            coalesce(s.name, 'Station ' || s.id) as name,
            o.value,
            o.observed_at,
            coalesce((s.metadata->>'isMonitor')::boolean, false) as monitor,
            s.history_tier,
            n.neighbours
       from observations o
       join stations s on s.id = o.station_id and s.source_id = 'openaq'
       cross join lateral (
          select count(*) as neighbours
            from observations b
            join stations sb on sb.id = b.station_id
           where sb.source_id = 'openaq'
             and sb.id <> s.id
             and st_dwithin(sb.geom, s.geom, $4)
             and b.param = 'pm25'
             and b.observed_at = o.observed_at
             and b.value is not null
       ) n
      where o.param = 'pm25'
        and o.value >= $3
        and o.observed_at >= $1::timestamptz
        and o.observed_at <  $2::timestamptz
        and n.neighbours = 0
      order by o.value desc
      limit $5`,
    [
      opts.from.toISOString(),
      opts.to.toISOString(),
      threshold,
      radiusKm * 1000,
      Math.min(opts.limit ?? 25, 100),
    ],
  );

  return rows.map((r) => ({
    stationId: Number(r.id),
    name: r.name,
    value: Math.round(Number(r.value) * 10) / 10,
    at: r.observed_at.toISOString(),
    isMonitor: r.monitor,
    historyTier: r.history_tier,
    neighboursChecked: Number(r.neighbours),
    radiusKm,
  }));
}
