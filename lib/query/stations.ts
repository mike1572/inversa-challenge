import { config, type BBox } from "../config";
import { sql } from "../db";

export interface StationHit {
  id: number;
  name: string;
  lat: number;
  lon: number;
  historyTier: "A" | "B";
  isMonitor: boolean;
  latestPm25: number | null;
  latestAt: string | null;
  ageMinutes: number | null;
}

/**
 * Resolve an area (or a point + radius) to stations, newest reading first.
 * The agent uses this to turn "Bend, Oregon" into station ids.
 */
export async function findStations(opts: {
  bbox?: BBox;
  lat?: number;
  lon?: number;
  radiusKm?: number;
  limit?: number;
}): Promise<StationHit[]> {
  const limit = Math.min(opts.limit ?? 20, 200);

  // Two search shapes. Args are ordered to match the placeholders exactly —
  // st_makepoint takes (lon, lat), and passing them the other way round is a
  // silent bug that just returns the wrong stations.
  const usePoint =
    Number.isFinite(opts.lat) && Number.isFinite(opts.lon) && Boolean(opts.radiusKm);

  const { where, orderBy, args } = usePoint
    ? {
        where: `st_dwithin(s.geom, st_makepoint($1, $2)::geography, $3)`,
        orderBy: `st_distance(s.geom, st_makepoint($1, $2)::geography)`,
        args: [opts.lon, opts.lat, (opts.radiusKm ?? 50) * 1000] as unknown[],
      }
    : {
        where: `st_intersects(s.geom, st_makeenvelope($1, $2, $3, $4, 4326)::geography)`,
        orderBy: `latest.observed_at desc nulls last`,
        args: [...(opts.bbox ?? config.regionBBox)] as unknown[],
      };

  const rows = await sql<{
    id: string; name: string; lat: number; lon: number;
    history_tier: "A" | "B"; monitor: boolean;
    value: number | null; observed_at: Date | null;
  }>(
    `select s.id,
            coalesce(s.name, 'Station ' || s.id) as name,
            st_y(s.geom::geometry) as lat,
            st_x(s.geom::geometry) as lon,
            s.history_tier,
            coalesce((s.metadata->>'isMonitor')::boolean, false) as monitor,
            latest.value,
            latest.observed_at
       from stations s
       left join lateral (
            select o.value, o.observed_at
              from observations o
             where o.station_id = s.id and o.param = 'pm25' and o.value is not null
             order by o.observed_at desc
             limit 1
       ) latest on true
      where s.source_id = 'openaq' and ${where}
      order by ${orderBy}
      limit $${args.length + 1}`,
    [...args, limit],
  );

  const now = Date.now();
  return rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    lat: Number(r.lat),
    lon: Number(r.lon),
    historyTier: r.history_tier,
    isMonitor: r.monitor,
    latestPm25: r.value === null ? null : Number(r.value),
    latestAt: r.observed_at ? r.observed_at.toISOString() : null,
    ageMinutes: r.observed_at
      ? Math.round((now - r.observed_at.getTime()) / 60_000)
      : null,
  }));
}

