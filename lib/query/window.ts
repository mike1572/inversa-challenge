import { config, type BBox } from "../config";
import { sql } from "../db";
import { detailLevelFor, fireLimitsFor, type DetailLevel } from "../lod";
import { getSourceHealth, type SourceHealth } from "./freshness";
import { bboxEnvelope, frp, isMonitor, lat, lon, round1, round4, stationName } from "./sql";

/**
 * The timeline payload: everything the map and scrubber need for a time
 * window, fetched ONCE. Scrubbing then indexes into memory with no network
 * per frame, which is what makes the timeline feel instant.
 *
 * Parallel arrays rather than arrays of objects: far smaller over the wire and
 * they feed deck.gl's typed-array path directly.
 */

export type { DetailLevel };

export interface WindowPayload {
  meta: {
    generatedAt: string;
    from: string;
    to: string;
    hours: number;
    bbox: BBox;
    /** Full extent of the archive, so the client need not hardcode the region. */
    regionBBox: BBox;
    detailLevel: DetailLevel;
    firesTruncated: boolean;
    /** Stations in view that reported nothing in this window — absence, counted. */
    silentStations: number;
    sources: SourceHealth[];
    /**
     * The NWS coverage boundary, coarsely simplified for display. Shipped so
     * the map's "no coverage" mask traces the real border rather than a
     * rectangle — otherwise the map would shade Windsor as covered while the
     * agent correctly says it has no data there.
     */
    alertCoverage: unknown | null;
  };
  stations: {
    id: number[];
    lat: number[];
    lon: number[];
    name: string[];
    tier: string[];
    monitor: boolean[];
  };
  /** Sparse triples into the stations array. */
  pm25: { station: number[]; hour: number[]; value: number[] };
  wind: { lat: number[]; lon: number[]; hour: number[]; dir: number[]; speed: number[] };
  fires: { lat: number[]; lon: number[]; hour: number[]; frp: number[] };
  alerts: {
    id: number;
    event: string;
    severity: string | null;
    headline: string | null;
    area: string | null;
    fromHour: number;
    toHour: number | null;
    geometry: unknown;
  }[];
  /** Per-hour aggregates for the timeline's activity strip. */
  activity: { fires: number[]; meanPm25: (number | null)[]; maxPm25: (number | null)[] };
}

function hourIndex(t: Date | string, from: Date): number {
  const ms = (typeof t === "string" ? new Date(t) : t).getTime() - from.getTime();
  return Math.floor(ms / 3600_000);
}

export async function getWindow(
  from: Date,
  to: Date,
  bbox: BBox = config.regionBBox,
): Promise<WindowPayload> {
  const hours = Math.max(1, Math.round((to.getTime() - from.getTime()) / 3600_000));
  const detailLevel = detailLevelFor(bbox);

  // Level of detail: a 7-day continental window holds tens of thousands of
  // detections. deck.gl renders that happily, but shipping it as JSON on first
  // load does not feel interactive. Cap by intensity when zoomed out and say so
  // in the meta, rather than quietly implying completeness.
  const { cap: fireCap, minFrp } = fireLimitsFor(detailLevel, config.lodFireCap);

  const envelope = bboxEnvelope();
  const geoArgs = [bbox[0], bbox[1], bbox[2], bbox[3]];
  const timeArgs = [from.toISOString(), to.toISOString()];

  const [stationRows, pm25Rows, windRows, fireRows, alertRows, fireCount, sources, coverageRows] =
    await Promise.all([
      sql<{
        id: string; lat: number; lon: number; name: string;
        history_tier: string; monitor: boolean;
      }>(
        `select s.id,
                ${lat("s")} as lat,
                ${lon("s")} as lon,
                ${stationName("s")} as name,
                s.history_tier,
                ${isMonitor("s")} as monitor
           from stations s
          where s.source_id = 'openaq'
            and st_intersects(s.geom, ${envelope})`,
        geoArgs,
      ),

      sql<{ station_id: string; observed_at: Date; value: number }>(
        `select o.station_id, o.observed_at, o.value
           from observations o
           join stations s on s.id = o.station_id
          where o.param = 'pm25'
            and o.value is not null
            and o.observed_at >= $5::timestamptz
            and o.observed_at <  $6::timestamptz
            and st_intersects(s.geom, ${envelope})`,
        [...geoArgs, ...timeArgs],
      ),

      // Wind is a coarse grid; thin it further at continental zoom so the
      // barbs stay legible rather than becoming a smear.
      sql<{ lat: number; lon: number; observed_at: Date; dir: number; speed: number }>(
        `select ${lat("s")} as lat,
                ${lon("s")} as lon,
                d.observed_at,
                d.value as dir,
                coalesce(sp.value, 0) as speed
           from observations d
           join stations s on s.id = d.station_id
           left join observations sp
                  on sp.station_id = d.station_id
                 and sp.param = 'wind_speed_10m'
                 and sp.observed_at = d.observed_at
          where d.param = 'wind_direction_10m'
            and d.observed_at >= $5::timestamptz
            and d.observed_at <  $6::timestamptz
            and st_intersects(s.geom, ${envelope})`,
        [...geoArgs, ...timeArgs],
      ),

      sql<{ lat: number; lon: number; valid_from: Date; frp: number }>(
        `select ${lat("e")} as lat,
                ${lon("e")} as lon,
                e.valid_from,
                ${frp("e")} as frp
           from events e
          where e.kind = 'fire_detection'
            and e.valid_from >= $5::timestamptz
            and e.valid_from <  $6::timestamptz
            and ${frp("e")} >= $7
            and st_intersects(e.geom, ${envelope})
          order by ${frp("e")} desc
          limit $8`,
        [...geoArgs, ...timeArgs, minFrp, fireCap],
      ),

      sql<{
        id: string; attrs: Record<string, string>;
        valid_from: Date; valid_to: Date | null; geometry: unknown;
      }>(
        // Simplified and rounded for display. An alert built from dozens of
        // merged county zones is enormous at full resolution — 23 alerts came
        // to 1.5 MB, over half the entire payload, one of them 255 KB alone.
        // These are advisory areas drawn as translucent fills, so ~1 km
        // precision and 4 decimal places lose nothing a viewer can see.
        `select e.id, e.attrs, e.valid_from, e.valid_to,
                st_asgeojson(
                  st_makevalid(st_simplifypreservetopology(e.geom::geometry, 0.01)),
                  4
                )::json as geometry
           from events e
          where e.kind = 'nws_alert'
            and e.valid_from < $6::timestamptz
            and (e.valid_to is null or e.valid_to > $5::timestamptz)
            and st_intersects(e.geom, ${envelope})
          limit 500`,
        [...geoArgs, ...timeArgs],
      ),

      sql<{ n: string }>(
        `select count(*) as n from events e
          where e.kind = 'fire_detection'
            and e.valid_from >= $5::timestamptz
            and e.valid_from <  $6::timestamptz
            and st_intersects(e.geom, ${envelope})`,
        [...geoArgs, ...timeArgs],
      ),

      getSourceHealth(),

      // 0.15° ≈ 15 km: far coarser than the stored boundary, but the mask is a
      // background hint, and this keeps it to a few KB on the wire.
      sql<{ geojson: unknown }>(
        `select st_asgeojson(st_simplify(coverage_geom::geometry, 0.15), 3)::json as geojson
           from sources where id = 'nws' and coverage_geom is not null`,
      ),
    ]);

  // ── stations ───────────────────────────────────────────────────────────
  // Only ship stations that reported at least once in this window. A station
  // silent for seven days is a dead sensor: three thousand grey dots on the map
  // and a third of a megabyte on the wire, telling you nothing a count can't.
  // The count still goes out, so the absence is reported rather than hidden.
  const reporting = new Set(pm25Rows.map((r) => Number(r.station_id)));

  const stationIndex = new Map<number, number>();
  const stations: WindowPayload["stations"] = {
    id: [], lat: [], lon: [], name: [], tier: [], monitor: [],
  };
  for (const s of stationRows) {
    const id = Number(s.id);
    if (!reporting.has(id)) continue;
    stationIndex.set(id, stations.id.length);
    stations.id.push(id);
    stations.lat.push(round4(s.lat));
    stations.lon.push(round4(s.lon));
    stations.name.push(s.name);
    stations.tier.push(s.history_tier);
    stations.monitor.push(s.monitor);
  }
  const silentStations = stationRows.length - stations.id.length;

  // ── pm2.5 ──────────────────────────────────────────────────────────────
  const pm25: WindowPayload["pm25"] = { station: [], hour: [], value: [] };
  const sumByHour = new Array<number>(hours).fill(0);
  const countByHour = new Array<number>(hours).fill(0);
  const maxByHour = new Array<number>(hours).fill(-1);

  for (const r of pm25Rows) {
    const si = stationIndex.get(Number(r.station_id));
    if (si === undefined) continue;
    const h = hourIndex(r.observed_at, from);
    if (h < 0 || h >= hours) continue;
    const v = round1(Number(r.value));
    pm25.station.push(si);
    pm25.hour.push(h);
    pm25.value.push(v);
    sumByHour[h] += v;
    countByHour[h]++;
    if (v > maxByHour[h]) maxByHour[h] = v;
  }

  // ── wind ───────────────────────────────────────────────────────────────
  const windStride = detailLevel === "continental" ? 3 : 1;
  const wind: WindowPayload["wind"] = { lat: [], lon: [], hour: [], dir: [], speed: [] };
  for (const r of windRows) {
    const h = hourIndex(r.observed_at, from);
    if (h < 0 || h >= hours) continue;
    if (h % windStride !== 0) continue;
    wind.lat.push(round4(r.lat));
    wind.lon.push(round4(r.lon));
    wind.hour.push(h);
    wind.dir.push(Math.round(Number(r.dir)));
    wind.speed.push(Math.round(Number(r.speed)));
  }

  // ── fires ──────────────────────────────────────────────────────────────
  const fires: WindowPayload["fires"] = { lat: [], lon: [], hour: [], frp: [] };
  const firesByHour = new Array<number>(hours).fill(0);
  for (const r of fireRows) {
    const h = hourIndex(r.valid_from, from);
    if (h < 0 || h >= hours) continue;
    fires.lat.push(round4(r.lat));
    fires.lon.push(round4(r.lon));
    fires.hour.push(h);
    fires.frp.push(round1(Number(r.frp)));
    firesByHour[h]++;
  }

  const totalFires = Number(fireCount[0]?.n ?? 0);

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      from: from.toISOString(),
      to: to.toISOString(),
      hours,
      bbox,
      regionBBox: config.regionBBox,
      detailLevel,
      alertCoverage: coverageRows[0]?.geojson ?? null,
      silentStations,
      firesTruncated: totalFires > fires.lat.length,
      sources,
    },
    stations,
    pm25,
    wind,
    fires,
    alerts: alertRows.map((a) => ({
      id: Number(a.id),
      event: a.attrs?.event ?? "Alert",
      severity: a.attrs?.severity ?? null,
      headline: a.attrs?.headline ?? null,
      area: a.attrs?.areaDesc ?? null,
      fromHour: hourIndex(a.valid_from, from),
      toHour: a.valid_to ? hourIndex(a.valid_to, from) : null,
      geometry: a.geometry,
    })),
    activity: {
      fires: firesByHour,
      meanPm25: sumByHour.map((s, i) =>
        countByHour[i] > 0 ? round1(s / countByHour[i]) : null,
      ),
      maxPm25: maxByHour.map((v) => (v < 0 ? null : v)),
    },
  };
}

