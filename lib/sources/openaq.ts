import { config } from "../config";
import {
  assertOk,
  fetchText,
  type FetchResult,
  type ObsRow,
  type ProviderJson,
  type SourceAdapter,
  type StationRow,
} from "./types";

/**
 * OpenAQ v3 — ground PM2.5 stations. The "effect" feed.
 *
 * Verified against the OpenAPI spec:
 *   - /v3/locations takes bbox as "minX,minY,maxX,maxY" (west,south,east,north),
 *     4 decimal places max.
 *   - /v3/parameters/{id}/latest takes only limit, page and datetime_min —
 *     NO bbox. So the live edge is fetched globally in pages of 1000 and
 *     filtered against our known sensor ids, which costs ~10-20 calls rather
 *     than one call per station.
 *   - Historical data is at /v3/sensors/{id}/measurements/hourly — sensor
 *     scoped, one request per sensor, which is why the backfill is tiered.
 *
 * Free tier: 60 req/min, 2,000/hour, with x-ratelimit-remaining on every
 * response.
 */

const BASE = "https://api.openaq.org/v3";
const PM25_PARAMETER_ID = 2;
const REQ_INTERVAL_MS = 1250; // ~48/min, comfortably under the 60/min ceiling

let lastRequestAt = 0;

/** Serialises OpenAQ calls to stay under the rate limit. */
async function throttle(): Promise<void> {
  const wait = lastRequestAt + REQ_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

async function get(path: string): Promise<{ req: Awaited<ReturnType<typeof fetchText>>; json: ProviderJson }> {
  if (!config.openaqApiKey) throw new Error("OPENAQ_API_KEY is not set");

  for (let attempt = 0; attempt < 4; attempt++) {
    await throttle();
    const req = await fetchText(`${BASE}${path}`, {
      headers: { "X-API-Key": config.openaqApiKey, Accept: "application/json" },
    });

    if (req.status === 429) {
      // Honour the limit rather than hammering through it.
      await new Promise((r) => setTimeout(r, 2 ** attempt * 5000));
      continue;
    }
    assertOk(req);
    return { req, json: JSON.parse(req.body) };
  }
  throw new Error(`OpenAQ rate limited after retries: ${path}`);
}

/** OpenAQ nests timestamps inconsistently across endpoints. */
function pickUtc(...candidates: unknown[]): Date | null {
  for (const c of candidates) {
    if (!c) continue;
    const raw = typeof c === "string" ? c : (c as { utc?: string })?.utc;
    if (!raw) continue;
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

function bbox4dp(): string {
  return config.regionBBox.map((n) => n.toFixed(4)).join(",");
}

interface DiscoveredSensor {
  locationId: number;
  sensorId: number;
  name: string;
  lat: number;
  lon: number;
  lastSeen: Date | null;
  isMonitor: boolean;
}

/**
 * Page through every PM2.5 location in the region.
 * Dead sensors are most of the long tail, so callers filter on lastSeen.
 */
async function discoverSensors(): Promise<{
  sensors: DiscoveredSensor[];
  requests: Awaited<ReturnType<typeof fetchText>>[];
}> {
  const sensors: DiscoveredSensor[] = [];
  const requests = [];
  const limit = 1000;

  for (let page = 1; page <= 10; page++) {
    const { req, json } = await get(
      `/locations?bbox=${bbox4dp()}&parameters_id=${PM25_PARAMETER_ID}&limit=${limit}&page=${page}`,
    );
    requests.push(req);

    const results: ProviderJson[] = json.results ?? [];
    for (const loc of results) {
      const lat = loc?.coordinates?.latitude;
      const lon = loc?.coordinates?.longitude;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      const pm25 = (loc.sensors ?? []).find(
        (s: ProviderJson) => s?.parameter?.id === PM25_PARAMETER_ID || s?.parameter?.name === "pm25",
      );
      if (!pm25) continue;

      sensors.push({
        locationId: loc.id,
        sensorId: pm25.id,
        name: loc.name ?? `Location ${loc.id}`,
        lat,
        lon,
        lastSeen: pickUtc(loc.datetimeLast),
        isMonitor: Boolean(loc.isMonitor ?? loc.monitor),
      });
    }

    if (results.length < limit) break;
  }

  return { sensors, requests };
}

/** Tier A = full 7-day backfill. Sticky once assigned (see ingest/run.ts). */
function assignTiers(sensors: DiscoveredSensor[]): StationRow[] {
  const cutoff = Date.now() - 48 * 3600_000;
  const live = sensors.filter((s) => s.lastSeen && s.lastSeen.getTime() > cutoff);

  // Prefer reference monitors, then recency. Reference-grade instruments give
  // the historical series its credibility; low-cost sensors fill in coverage.
  const ranked = [...live].sort((a, b) => {
    if (a.isMonitor !== b.isMonitor) return a.isMonitor ? -1 : 1;
    return (b.lastSeen?.getTime() ?? 0) - (a.lastSeen?.getTime() ?? 0);
  });

  const tierA = new Set(ranked.slice(0, config.tierASensors).map((s) => s.sensorId));

  return sensors.map((s) => ({
    sourceId: "openaq",
    externalId: String(s.locationId),
    name: s.name,
    lat: s.lat,
    lon: s.lon,
    historyTier: tierA.has(s.sensorId) ? ("A" as const) : ("B" as const),
    metadata: {
      sensorId: s.sensorId,
      locationId: s.locationId,
      isMonitor: s.isMonitor,
      lastSeen: s.lastSeen?.toISOString() ?? null,
    },
  }));
}

export const openaq: SourceAdapter = {
  id: "openaq",
  cadenceSec: 900,
  canBackfill: true,
  isConfigured: () => Boolean(config.openaqApiKey),

  /**
   * The recurring poll: refresh the station roster, then pull the global
   * latest-PM2.5 pages and keep the ones we care about.
   */
  async fetchWindow(from: Date, to: Date): Promise<FetchResult> {
    const { sensors, requests } = await discoverSensors();
    const stations = assignTiers(sensors);

    const bySensor = new Map(sensors.map((s) => [s.sensorId, s]));
    const observations: ObsRow[] = [];
    const limit = 1000;

    // No bbox filter exists on this endpoint, so page globally and intersect.
    const since = new Date(Math.max(from.getTime(), Date.now() - 12 * 3600_000));
    for (let page = 1; page <= 25; page++) {
      const { req, json } = await get(
        `/parameters/${PM25_PARAMETER_ID}/latest?limit=${limit}&page=${page}` +
          `&datetime_min=${since.toISOString()}`,
      );
      const requestIndex = requests.push(req) - 1;

      const results: ProviderJson[] = json.results ?? [];
      for (const item of results) {
        const sensorId = item.sensorsId ?? item.sensors_id;
        const sensor = bySensor.get(sensorId);
        if (!sensor) continue; // outside our region

        const observedAt = pickUtc(item.datetime, item.period?.datetimeTo);
        if (!observedAt || observedAt > to) continue;

        const value = Number(item.value);
        observations.push({
          sourceId: "openaq",
          externalId: String(sensor.locationId),
          param: "pm25",
          observedAt: floorToHour(observedAt),
          value: Number.isFinite(value) && value >= 0 ? value : null,
          unit: "µg/m³",
          qualityFlag: sensor.isMonitor ? null : "low_cost_sensor",
          requestIndex,
        });
      }

      if (results.length < limit) break;
    }

    return {
      requests,
      stations,
      observations,
      note: `${sensors.length} PM2.5 sensors in region, ${stations.filter((s) => s.historyTier === "A").length} in tier A`,
    };
  },
};

function floorToHour(d: Date): Date {
  const out = new Date(d);
  out.setUTCMinutes(0, 0, 0);
  return out;
}

/**
 * Tier-A history backfill. Separate from the adapter because it needs sensor
 * ids that live in the database, and because it is a long-running one-off
 * rather than part of the regular poll.
 */
export async function fetchSensorHistory(
  sensorId: number,
  locationId: number,
  isMonitor: boolean,
  from: Date,
  to: Date,
): Promise<{ requests: Awaited<ReturnType<typeof fetchText>>[]; observations: ObsRow[] }> {
  const requests = [];
  const observations: ObsRow[] = [];
  const limit = 1000;

  for (let page = 1; page <= 3; page++) {
    const { req, json } = await get(
      `/sensors/${sensorId}/measurements/hourly` +
        `?datetime_from=${from.toISOString()}&datetime_to=${to.toISOString()}` +
        `&limit=${limit}&page=${page}`,
    );
    const requestIndex = requests.push(req) - 1;

    const results: ProviderJson[] = json.results ?? [];
    for (const m of results) {
      const observedAt = pickUtc(m.period?.datetimeFrom, m.datetime);
      if (!observedAt) continue;

      const value = Number(m.value);
      observations.push({
        sourceId: "openaq",
        externalId: String(locationId),
        param: "pm25",
        observedAt: floorToHour(observedAt),
        value: Number.isFinite(value) && value >= 0 ? value : null,
        unit: "µg/m³",
        qualityFlag: isMonitor ? null : "low_cost_sensor",
        requestIndex,
      });
    }

    if (results.length < limit) break;
  }

  return { requests, observations };
}
