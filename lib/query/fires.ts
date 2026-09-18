import { config, type BBox } from "../config";
import { sql } from "../db";

export interface FireHit {
  lat: number;
  lon: number;
  frp: number;
  at: string;
  confidence: string | null;
  satellite: string | null;
}

export async function getFires(opts: {
  bbox?: BBox;
  from: Date;
  to: Date;
  minFrp?: number;
  limit?: number;
}): Promise<FireHit[]> {
  const bbox = opts.bbox ?? config.regionBBox;
  const rows = await sql<{
    lat: number; lon: number; frp: number; valid_from: Date;
    confidence: string | null; satellite: string | null;
  }>(
    `select st_y(e.geom::geometry) as lat,
            st_x(e.geom::geometry) as lon,
            coalesce((e.attrs->>'frp')::float, 0) as frp,
            e.valid_from,
            e.attrs->>'confidence' as confidence,
            e.attrs->>'satellite'  as satellite
       from events e
      where e.kind = 'fire_detection'
        and e.valid_from >= $5::timestamptz
        and e.valid_from <  $6::timestamptz
        and coalesce((e.attrs->>'frp')::float, 0) >= $7
        and st_intersects(e.geom, st_makeenvelope($1, $2, $3, $4, 4326)::geography)
      order by coalesce((e.attrs->>'frp')::float, 0) desc
      limit $8`,
    [
      ...bbox,
      opts.from.toISOString(),
      opts.to.toISOString(),
      opts.minFrp ?? 0,
      Math.min(opts.limit ?? 100, 1000),
    ],
  );

  return rows.map((r) => ({
    lat: Number(r.lat),
    lon: Number(r.lon),
    frp: Number(r.frp),
    at: r.valid_from.toISOString(),
    confidence: r.confidence,
    satellite: r.satellite,
  }));
}

export interface SmokeSource {
  stationId: number;
  stationName: string;
  pm25: number | null;
  windFromDeg: number;
  fireCount: number;
  totalFrp: number;
  nearestKm: number;
  /** Fires upwind that lie outside US territory — i.e. Canadian or Mexican. */
  foreignFireCount: number;
  stationInUs: boolean;
  /**
   * True only for genuine cross-border transport: a station inside the US with
   * fire upwind outside it.
   *
   * Without the station-side test this flag also fires for a Canadian station
   * downwind of a Canadian fire, which is not smoke crossing a border at all —
   * a trap the model had to notice and reason around on its own.
   */
  crossBorder: boolean;
}

export interface SmokeSourcesResult {
  at: string;
  stationsExamined: number;
  rows: SmokeSource[];
  note?: string;
}

/**
 * The regional form of upwindFires: which stations in an area have fire upwind
 * right now, and is that fire on the other side of the border?
 *
 * Exists because "is any Canadian smoke reaching the US" is a question about a
 * whole region, and with only a per-station tool the agent was forced to walk
 * the border one station at a time — it fetched 200 stations and then called
 * upwind_fires repeatedly until it ran out of turns without ever answering.
 *
 * Cross-border attribution comes from the same US boundary polygon the coverage
 * mask uses, so "this fire is outside the US" is decided by real geometry
 * rather than by the model guessing from coordinates.
 *
 * Bounded by examining only the worst-air stations in the box: those are the
 * ones the question is actually about, and it keeps the join from going
 * quadratic across thousands of stations.
 */
export async function findSmokeSources(opts: {
  bbox?: BBox;
  at: Date;
  hoursBack?: number;
  sectorDeg?: number;
  maxDistanceKm?: number;
  stationLimit?: number;
}): Promise<SmokeSourcesResult> {
  const bbox = opts.bbox ?? config.regionBBox;
  const hoursBack = Math.min(Math.max(opts.hoursBack ?? 24, 1), 72);
  const sectorDeg = Math.min(Math.max(opts.sectorDeg ?? 60, 15), 180);
  const maxDistanceKm = Math.min(opts.maxDistanceKm ?? 400, 1000);
  const stationLimit = Math.min(opts.stationLimit ?? 40, 120);

  const rows = await sql<{
    id: string; name: string; pm25: number | null; from_dir: number;
    fire_count: string; total_frp: number; nearest_km: number;
    foreign_count: string; station_in_us: boolean;
  }>(
    `with candidates as (
        select s.id, coalesce(s.name, 'Station ' || s.id) as name, s.geom, latest.value as pm25
          from stations s
          join lateral (
             select o.value, o.observed_at
               from observations o
              where o.station_id = s.id and o.param = 'pm25' and o.value is not null
                and o.observed_at <= $5::timestamptz
                and o.observed_at >  $5::timestamptz - interval '6 hours'
              order by o.observed_at desc limit 1
          ) latest on true
         where s.source_id = 'openaq'
           and st_intersects(s.geom, st_makeenvelope($1, $2, $3, $4, 4326)::geography)
         order by latest.value desc
         limit $6
     ),
     with_wind as (
        select c.*, d.value as from_dir
          from candidates c
          cross join lateral (
             select g.id from stations g
              where g.source_id = 'open_meteo'
              order by g.geom <-> c.geom limit 1
          ) g
          join observations d
            on d.station_id = g.id and d.param = 'wind_direction_10m'
           and d.observed_at = date_trunc('hour', $5::timestamptz)
     ),
     us as (select coverage_geom from sources where id = 'nws')
     select w.id, w.name, w.pm25, w.from_dir,
            bool_or(us.coverage_geom is not null
                    and st_intersects(w.geom, us.coverage_geom)) as station_in_us,
            count(e.id)::text                                   as fire_count,
            coalesce(sum((e.attrs->>'frp')::float), 0)          as total_frp,
            min(st_distance(e.geom, w.geom)) / 1000.0           as nearest_km,
            count(e.id) filter (
              where us.coverage_geom is not null
                and not st_intersects(e.geom, us.coverage_geom)
            )::text                                             as foreign_count
       from with_wind w
       cross join us
       join events e
         on e.kind = 'fire_detection'
        and e.valid_from between $5::timestamptz - make_interval(hours => $7) and $5::timestamptz
        and st_dwithin(e.geom, w.geom, $8)
        -- Same convention as upwindFires: wind_direction is where the wind
        -- comes FROM, so the fire lies along that bearing, not opposite it.
        and abs(((degrees(st_azimuth(w.geom::geometry, e.geom::geometry))
                  - w.from_dir + 540)::numeric % 360) - 180) < $9 / 2.0
      group by w.id, w.name, w.pm25, w.from_dir
      order by coalesce(sum((e.attrs->>'frp')::float), 0) desc
      limit 25`,
    [
      ...bbox,
      opts.at.toISOString(),
      stationLimit,
      hoursBack,
      maxDistanceKm * 1000,
      sectorDeg,
    ],
  );

  const out = rows.map((r) => ({
    stationId: Number(r.id),
    stationName: r.name,
    pm25: r.pm25 === null ? null : Math.round(Number(r.pm25) * 10) / 10,
    windFromDeg: Math.round(Number(r.from_dir)),
    fireCount: Number(r.fire_count),
    totalFrp: Math.round(Number(r.total_frp) * 10) / 10,
    nearestKm: Math.round(Number(r.nearest_km)),
    foreignFireCount: Number(r.foreign_count),
    stationInUs: Boolean(r.station_in_us),
    crossBorder: Boolean(r.station_in_us) && Number(r.foreign_count) > 0,
  }));

  const crossing = out.filter((r) => r.crossBorder);

  return {
    at: opts.at.toISOString(),
    stationsExamined: stationLimit,
    rows: out,
    note:
      out.length === 0
        ? `No station among the worst-air ${stationLimit} in this box had any fire in its ` +
          `${sectorDeg}° upwind sector within ${maxDistanceKm} km over the past ${hoursBack}h.`
        : crossing.length > 0
          ? `${crossing.length} of ${out.length} stations show genuine CROSS-BORDER transport: ` +
            "the station is inside US territory and its upwind fires are outside it. " +
            "Both sides of that test come from the national boundary, not from coordinates. " +
            "Rows with foreignFireCount > 0 but stationInUs = false are a foreign station " +
            "downwind of a foreign fire — not smoke crossing a border."
          : "No cross-border transport found: every US station's upwind fires are also inside " +
            "the US. Any foreignFireCount here belongs to stations that are themselves outside " +
            "the US.",
  };
}

export interface UpwindResult {
  stationId: number;
  stationName: string;
  at: string;
  wind: { fromDirectionDeg: number; speed: number; unit: string; gridDistanceKm: number } | null;
  sectorDeg: number;
  hoursBack: number;
  fires: {
    lat: number;
    lon: number;
    frp: number;
    at: string;
    distanceKm: number;
    bearingDeg: number;
    /** frp / max(distanceKm, 1) — a crude but effective influence ranking. */
    influence: number;
  }[];
  note?: string;
}

/**
 * Fires upwind of a station — the three-feed spatial join that no single
 * provider could answer, and the reason this system exists.
 *
 * THE CRITICAL SEMANTIC: meteorological wind_direction_10m is the direction the
 * wind blows FROM. A wind_direction of 90° means wind arriving out of the east.
 * So smoke reaching the station comes from fires lying at bearing ~90° FROM the
 * station — along the reported bearing, with NO 180° flip. Inverting this is
 * the single most likely silent bug in the whole build: every answer would be
 * confidently, invisibly wrong, and nothing in the UI would look off.
 *
 * Wind comes from the Open-Meteo grid rather than the air-quality station
 * itself, so we take the nearest grid point (cheap against the GIST index).
 */
export async function upwindFires(opts: {
  stationId: number;
  at: Date;
  hoursBack?: number;
  sectorDeg?: number;
  maxDistanceKm?: number;
}): Promise<UpwindResult | null> {
  const hoursBack = Math.min(Math.max(opts.hoursBack ?? 24, 1), 72);
  const sectorDeg = Math.min(Math.max(opts.sectorDeg ?? 60, 15), 180);
  const maxDistanceKm = Math.min(opts.maxDistanceKm ?? 300, 1000);
  const at = opts.at;

  const stationRows = await sql<{ id: string; name: string; lat: number; lon: number }>(
    `select id, coalesce(name, 'Station ' || id) as name,
            st_y(geom::geometry) as lat, st_x(geom::geometry) as lon
       from stations where id = $1`,
    [opts.stationId],
  );
  if (stationRows.length === 0) return null;
  const station = stationRows[0];

  // Nearest wind grid point, and its reading for this hour.
  const windRows = await sql<{
    dir: number; speed: number | null; unit: string; dist_m: number; observed_at: Date;
  }>(
    `select d.value as dir,
            sp.value as speed,
            d.unit,
            st_distance(g.geom, s.geom) as dist_m,
            d.observed_at
       from stations s
       cross join lateral (
            select g2.id, g2.geom from stations g2
             where g2.source_id = 'open_meteo'
             order by g2.geom <-> s.geom
             limit 1
       ) g
       join observations d
              on d.station_id = g.id
             and d.param = 'wind_direction_10m'
             and d.observed_at = date_trunc('hour', $2::timestamptz)
       left join observations sp
              on sp.station_id = g.id
             and sp.param = 'wind_speed_10m'
             and sp.observed_at = d.observed_at
      where s.id = $1`,
    [opts.stationId, at.toISOString()],
  );

  const base = {
    stationId: Number(station.id),
    stationName: station.name,
    at: at.toISOString(),
    sectorDeg,
    hoursBack,
  };

  if (windRows.length === 0) {
    // No wind for this hour: say so rather than guessing a direction.
    return {
      ...base,
      wind: null,
      fires: [],
      note:
        "No wind data for this hour, so upwind direction cannot be determined. " +
        "Fires may still be present — use get_fires for an undirected search.",
    };
  }

  const w = windRows[0];
  const fromDirection = Number(w.dir);

  const fireRows = await sql<{
    lat: number; lon: number; frp: number; valid_from: Date;
    km: number; bearing: number;
  }>(
    `select st_y(e.geom::geometry) as lat,
            st_x(e.geom::geometry) as lon,
            coalesce((e.attrs->>'frp')::float, 0) as frp,
            e.valid_from,
            st_distance(e.geom, s.geom) / 1000.0 as km,
            degrees(st_azimuth(s.geom::geometry, e.geom::geometry)) as bearing
       from events e
       join stations s on s.id = $1
      where e.kind = 'fire_detection'
        and e.valid_from between $2::timestamptz - make_interval(hours => $3)
                             and $2::timestamptz
        and st_dwithin(e.geom, s.geom, $4)
        -- Smallest absolute angle between the fire's bearing and the direction
        -- the wind is coming FROM. No 180 flip: see the note above.
        and abs(((degrees(st_azimuth(s.geom::geometry, e.geom::geometry))
                  - $5 + 540)::numeric % 360) - 180) < $6 / 2.0
      order by coalesce((e.attrs->>'frp')::float, 0)
               / greatest(st_distance(e.geom, s.geom) / 1000.0, 1) desc
      limit 25`,
    [
      opts.stationId,
      at.toISOString(),
      hoursBack,
      maxDistanceKm * 1000,
      fromDirection,
      sectorDeg,
    ],
  );

  return {
    ...base,
    wind: {
      fromDirectionDeg: Math.round(fromDirection),
      speed: w.speed === null ? 0 : Math.round(Number(w.speed)),
      unit: w.unit ?? "km/h",
      gridDistanceKm: Math.round(Number(w.dist_m) / 1000),
    },
    fires: fireRows.map((r) => ({
      lat: Number(r.lat),
      lon: Number(r.lon),
      frp: Math.round(Number(r.frp) * 10) / 10,
      at: r.valid_from.toISOString(),
      distanceKm: Math.round(Number(r.km)),
      bearingDeg: Math.round(Number(r.bearing)),
      influence: Math.round((Number(r.frp) / Math.max(Number(r.km), 1)) * 100) / 100,
    })),
    note:
      fireRows.length === 0
        ? `No fire detections within ${maxDistanceKm} km in the ${sectorDeg}° sector upwind ` +
          `(wind from ${Math.round(fromDirection)}°) over the past ${hoursBack}h.`
        : undefined,
  };
}
