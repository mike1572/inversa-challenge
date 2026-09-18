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
