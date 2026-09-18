import { config, PARAMS } from "../config";
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
 * Open-Meteo — wind and humidity. The "transport" feed.
 *
 * Design note: this builds its OWN grid of stations rather than sampling at
 * the OpenAQ station coordinates.
 *
 * The plan originally called for sharing station ids with OpenAQ so the upwind
 * join needed no spatial lookup. Two things argued against it: the adapter
 * would have to read the station table (breaking the pure fetch-and-normalize
 * contract every other adapter follows), and — more importantly — we need wind
 * at FIRE locations, not just where somebody happens to have installed an air
 * sensor, to answer "where is the smoke headed". A grid gives wind everywhere.
 *
 * The cost is one nearest-neighbour lookup in the upwind query, which is
 * negligible against a GIST index.
 *
 * No API key and no meaningful rate limit.
 */

const BASE = "https://api.open-meteo.com/v1/forecast";
const GRID_SPACING_DEG = 3;
const COORDS_PER_REQUEST = 100;

function buildGrid(): { lat: number; lon: number }[] {
  const [west, south, east, north] = config.regionBBox;
  const points: { lat: number; lon: number }[] = [];
  for (let lat = south; lat <= north; lat += GRID_SPACING_DEG) {
    for (let lon = west; lon <= east; lon += GRID_SPACING_DEG) {
      points.push({ lat: Number(lat.toFixed(4)), lon: Number(lon.toFixed(4)) });
    }
  }
  return points;
}

function gridId(lat: number, lon: number): string {
  return `grid:${lat.toFixed(2)}:${lon.toFixed(2)}`;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export const openMeteo: SourceAdapter = {
  id: "open_meteo",
  cadenceSec: 1800,
  canBackfill: true,
  isConfigured: () => true, // no key required

  async fetchWindow(from: Date, to: Date): Promise<FetchResult> {
    const grid = buildGrid();
    const requests = [];
    const stations: StationRow[] = [];
    const observations: ObsRow[] = [];

    const pastDays = Math.min(
      92,
      Math.max(1, Math.ceil((Date.now() - from.getTime()) / 86_400_000)),
    );

    for (const batch of chunk(grid, COORDS_PER_REQUEST)) {
      const url =
        `${BASE}?latitude=${batch.map((p) => p.lat).join(",")}` +
        `&longitude=${batch.map((p) => p.lon).join(",")}` +
        `&hourly=${PARAMS.windSpeed},${PARAMS.windDir},${PARAMS.humidity}` +
        `&past_days=${pastDays}&forecast_days=2` +
        `&timeformat=unixtime&timezone=UTC`;

      const req = await fetchText(url, { timeoutMs: 45_000 });
      const requestIndex = requests.push(req) - 1;
      assertOk(req);

      const parsed: ProviderJson = JSON.parse(req.body);
      // Open-Meteo returns an array for multi-coordinate requests and a bare
      // object for a single one.
      const results: ProviderJson[] = Array.isArray(parsed) ? parsed : [parsed];

      for (const [i, r] of results.entries()) {
        // Snap back to the requested coordinate: the API answers with the
        // model grid cell it actually used, which drifts from what we asked
        // for and would otherwise create a new station on every single run.
        const requested = batch[i];
        if (!requested) continue;

        const externalId = gridId(requested.lat, requested.lon);

        stations.push({
          sourceId: "open_meteo",
          externalId,
          name: `${requested.lat.toFixed(1)}, ${requested.lon.toFixed(1)}`,
          lat: requested.lat,
          lon: requested.lon,
          historyTier: "A",
          metadata: {
            modelLat: r.latitude,
            modelLon: r.longitude,
            elevation: r.elevation,
          },
        });

        const times: number[] = r.hourly?.time ?? [];
        const series: Record<string, (number | null)[]> = {
          [PARAMS.windSpeed]: r.hourly?.[PARAMS.windSpeed] ?? [],
          [PARAMS.windDir]: r.hourly?.[PARAMS.windDir] ?? [],
          [PARAMS.humidity]: r.hourly?.[PARAMS.humidity] ?? [],
        };
        const units: Record<string, string> = {
          [PARAMS.windSpeed]: r.hourly_units?.[PARAMS.windSpeed] ?? "km/h",
          [PARAMS.windDir]: "°",
          [PARAMS.humidity]: "%",
        };

        // Keep forecast hours as well as history: "where is the smoke headed
        // in the next 12 hours" is answered from forward wind, so the upper
        // bound is the forecast horizon rather than the ingest window's `to`.
        const horizon = to.getTime() + 48 * 3600_000;

        for (let t = 0; t < times.length; t++) {
          const observedAt = new Date(times[t] * 1000);
          if (observedAt < from || observedAt.getTime() > horizon) continue;

          for (const param of Object.keys(series)) {
            const v = series[param][t];
            if (v === null || v === undefined) continue;
            observations.push({
              sourceId: "open_meteo",
              externalId,
              param,
              observedAt,
              value: Number(v),
              unit: units[param],
              requestIndex,
            });
          }
        }
      }
    }

    return {
      requests,
      stations,
      observations,
      note: `${grid.length} grid points at ${GRID_SPACING_DEG}° spacing`,
    };
  },
};
