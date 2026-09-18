import type { BBox } from "../config";
import { config } from "../config";
import { getAlerts } from "../query/alerts";
import { findConflicts, findUncorroboratedExtremes } from "../query/conflicts";
import { getFires, upwindFires } from "../query/fires";
import { getSourceHealth } from "../query/freshness";
import { compareToNormal, getSeries } from "../query/series";
import { findStations } from "../query/stations";

/**
 * Narrow, typed tools — never free-form SQL.
 *
 * This bounds the failure surface (a hallucinated argument produces an empty
 * result, not a wrong number), makes every call loggable as evidence, and lets
 * a smaller model drive the loop safely. Handlers call lib/query/* — the same
 * readers the map uses — so the number the agent quotes and the dot you see on
 * the map come from one code path and cannot disagree.
 */

export interface ToolResult {
  rows?: unknown;
  note?: string;
  sourceIds: string[];
  [k: string]: unknown;
}

function parseDate(s: string | null | undefined, fallback: Date): Date {
  if (!s) return fallback;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

function asBBox(v: unknown): BBox | undefined {
  if (!Array.isArray(v) || v.length !== 4) return undefined;
  const nums = v.map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return undefined;
  return nums as BBox;
}

const num = (t = "number") => ({ type: t });

export const TOOL_DEFINITIONS = [
  {
    type: "function" as const,
    name: "find_stations",
    strict: true,
    description:
      "Find PM2.5 monitoring stations, with their latest reading and how old it is. " +
      "To resolve a place name, supply approximate lat/lon for that place from your " +
      "own knowledge plus a radius_km — there is no geocoder. Use bbox for regions.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["lat", "lon", "radius_km", "bbox", "limit"],
      properties: {
        lat: { type: ["number", "null"], description: "Latitude of the place of interest." },
        lon: { type: ["number", "null"], description: "Longitude of the place of interest." },
        radius_km: { type: ["number", "null"], description: "Search radius. Try 50." },
        bbox: {
          type: ["array", "null"],
          items: num(),
          description: "[west,south,east,north]. Use instead of lat/lon for a region.",
        },
        limit: { type: ["integer", "null"] },
      },
    },
  },
  {
    type: "function" as const,
    name: "get_series",
    strict: true,
    description:
      "Hourly time series for stations. Gaps come back as explicit nulls and each " +
      "series reports its history_tier — tier B stations hold only the live edge, so " +
      "a short series there means a limited archive, NOT clean air.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["station_ids", "param", "from", "to"],
      properties: {
        station_ids: { type: "array", items: { type: "integer" } },
        param: {
          type: "string",
          enum: ["pm25", "wind_speed_10m", "wind_direction_10m", "relative_humidity_2m"],
        },
        from: { type: "string", description: "ISO 8601 UTC" },
        to: { type: "string", description: "ISO 8601 UTC" },
      },
    },
  },
  {
    type: "function" as const,
    name: "get_fires",
    strict: true,
    description:
      "Satellite fire detections in a box and time range, strongest first. " +
      "Use upwind_fires instead when you need to explain a specific station's air.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["bbox", "from", "to", "min_frp", "limit"],
      properties: {
        bbox: { type: "array", items: num() },
        from: { type: "string" },
        to: { type: "string" },
        min_frp: { type: ["number", "null"], description: "Fire radiative power floor, MW." },
        limit: { type: ["integer", "null"] },
      },
    },
  },
  {
    type: "function" as const,
    name: "upwind_fires",
    strict: true,
    description:
      "THE KEY TOOL for explaining why air is bad somewhere. Reads the wind at the " +
      "station for that hour, projects the upwind sector, and returns the fires inside " +
      "it ranked by intensity over distance. Joins three feeds at once.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["station_id", "at", "hours_back", "sector_deg", "max_distance_km"],
      properties: {
        station_id: { type: "integer" },
        at: { type: "string", description: "ISO 8601 UTC. Use the latest reading's time." },
        hours_back: { type: ["integer", "null"], description: "1-72. Try 24." },
        sector_deg: { type: ["integer", "null"], description: "15-180. Try 60." },
        max_distance_km: { type: ["integer", "null"], description: "Try 300." },
      },
    },
  },
  {
    type: "function" as const,
    name: "compare_to_normal",
    strict: true,
    description:
      "Percentile of a station's current value against its OWN history. Call this " +
      "before describing any value as high or low — 35 µg/m³ is routine in one place " +
      "and alarming in another, and only the station's distribution knows which.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["station_id", "param", "at"],
      properties: {
        station_id: { type: "integer" },
        param: { type: "string", enum: ["pm25"] },
        at: { type: "string", description: "ISO 8601 UTC" },
      },
    },
  },
  {
    type: "function" as const,
    name: "get_alerts",
    strict: true,
    description:
      "Active NWS weather alerts in an area. Returns out_of_coverage=true outside US " +
      "territory. If it does, say you have NO COVERAGE there — do not say there are no " +
      "alerts. Those are different claims.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["bbox", "at"],
      properties: {
        bbox: { type: "array", items: num() },
        at: { type: ["string", "null"] },
      },
    },
  },
  {
    type: "function" as const,
    name: "find_conflicts",
    strict: true,
    description:
      "Corroboration check. Returns (a) nearby stations reporting materially different " +
      "PM2.5 for the same hour — typically a reference monitor disagreeing with a " +
      "low-cost sensor, where you must report both values rather than picking one; and " +
      "(b) extreme readings with NO neighbouring sensor to confirm them. Call this " +
      "before reporting any alarming value: the highest readings are often single " +
      "unverified low-cost sensors.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["from", "to", "threshold_pct"],
      properties: {
        from: { type: "string" },
        to: { type: "string" },
        threshold_pct: { type: ["number", "null"], description: "Default 30." },
      },
    },
  },
  {
    type: "function" as const,
    name: "data_freshness",
    strict: true,
    description:
      "Per-feed health: last successful ingest, lag against expected cadence, status " +
      "and last error. Call this when asked about data quality or recency, and whenever " +
      "a result looks suspiciously empty.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: {},
    },
  },
];

/**
 * Arguments as the model produced them. Schema-validated by the API before they
 * reach us, but each handler still coerces and clamps what it reads — a
 * hallucinated argument should yield an empty result, never a wrong number.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolArgs = Record<string, any>;

type Handler = (args: ToolArgs, ctx: { now: Date }) => Promise<ToolResult>;

export const TOOL_HANDLERS: Record<string, Handler> = {
  async find_stations(a) {
    const rows = await findStations({
      lat: a.lat ?? undefined,
      lon: a.lon ?? undefined,
      radiusKm: a.radius_km ?? undefined,
      bbox: asBBox(a.bbox),
      limit: a.limit ?? 20,
    });
    return {
      rows,
      sourceIds: ["openaq"],
      note:
        rows.length === 0
          ? "No stations found. Widen radius_km, or the area may genuinely have no PM2.5 monitoring."
          : undefined,
    };
  },

  async get_series(a, ctx) {
    const rows = await getSeries({
      stationIds: (a.station_ids ?? []).slice(0, 25),
      param: a.param,
      from: parseDate(a.from, new Date(ctx.now.getTime() - 86_400_000)),
      to: parseDate(a.to, ctx.now),
    });
    return {
      rows,
      sourceIds: a.param === "pm25" ? ["openaq"] : ["open_meteo"],
      note: rows.length === 0 ? "No such stations." : undefined,
    };
  },

  async get_fires(a, ctx) {
    const rows = await getFires({
      bbox: asBBox(a.bbox) ?? config.regionBBox,
      from: parseDate(a.from, new Date(ctx.now.getTime() - 86_400_000)),
      to: parseDate(a.to, ctx.now),
      minFrp: a.min_frp ?? 0,
      limit: a.limit ?? 100,
    });
    return {
      rows,
      sourceIds: ["firms"],
      note:
        rows.length === 0
          ? "No fire detections in this box and time range. FIRMS detections arrive with ~3h satellite latency."
          : undefined,
    };
  },

  async upwind_fires(a, ctx) {
    const result = await upwindFires({
      stationId: a.station_id,
      at: parseDate(a.at, ctx.now),
      hoursBack: a.hours_back ?? 24,
      sectorDeg: a.sector_deg ?? 60,
      maxDistanceKm: a.max_distance_km ?? 300,
    });
    if (!result) {
      return { rows: null, sourceIds: [], note: `No station with id ${a.station_id}.` };
    }
    return { ...result, rows: result.fires, sourceIds: ["firms", "open_meteo", "openaq"] };
  },

  async compare_to_normal(a, ctx) {
    const result = await compareToNormal({
      stationId: a.station_id,
      param: a.param ?? "pm25",
      at: parseDate(a.at, ctx.now),
    });
    if (!result) {
      return { rows: null, sourceIds: [], note: `No station with id ${a.station_id}.` };
    }
    return { ...result, rows: result, sourceIds: ["openaq"] };
  },

  async get_alerts(a, ctx) {
    const result = await getAlerts({
      bbox: asBBox(a.bbox) ?? config.regionBBox,
      at: parseDate(a.at, ctx.now),
    });
    return { ...result, rows: result.alerts, sourceIds: ["nws"] };
  },

  async find_conflicts(a, ctx) {
    const from = parseDate(a.from, new Date(ctx.now.getTime() - 7 * 86_400_000));
    const to = parseDate(a.to, ctx.now);

    const [rows, uncorroborated] = await Promise.all([
      findConflicts({ from, to, thresholdPct: a.threshold_pct ?? 30 }),
      findUncorroboratedExtremes({ from, to }),
    ]);

    const notes: string[] = [];
    notes.push(
      rows.length === 0
        ? "No co-located sensors disagreed beyond the threshold in this window."
        : `${rows.length} pairs of sensors within 2 km reported different values for the same hour.`,
    );
    if (uncorroborated.length > 0) {
      notes.push(
        `${uncorroborated.length} extreme readings have NO sensor within 20 km to confirm them. ` +
          "Attribute these to the individual sensor, and do not describe an area's air as " +
          "unhealthy on the strength of one unverified reading.",
      );
    }

    return {
      rows,
      uncorroborated,
      sourceIds: ["openaq"],
      note: notes.join(" "),
    };
  },

  async data_freshness() {
    const rows = await getSourceHealth();
    return { rows, sourceIds: rows.map((r) => r.id) };
  },
};
