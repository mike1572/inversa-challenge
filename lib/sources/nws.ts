import { config } from "../config";
import {
  assertOk,
  fetchText,
  type FetchContext,
  type FetchResult,
  type ProviderJson,
  type SourceAdapter,
  type ZoneRow,
} from "./types";

/**
 * NOAA / National Weather Service alerts. The "official signal" feed.
 *
 * Two properties that shape the whole system:
 *
 * 1. canBackfill = false. /alerts/active returns only what is active RIGHT
 *    NOW; there is no "what was active last Tuesday" endpoint. Anything we
 *    don't capture is gone permanently, so alert history only accumulates
 *    while the app is being used. This is disclosed in the UI rather than
 *    quietly papered over.
 *
 * 2. US-only coverage. Areas outside US territory have NO ALERT COVERAGE,
 *    which is a different claim from "there are no alerts". sources.coverage_geom
 *    carries the boundary so the map can grey out Canada with a reason and the
 *    agent can say "I have no coverage there" instead of "there is nothing there".
 *
 * One unfiltered call returns every active US alert — simpler and cheaper than
 * enumerating 49 state codes. We filter to the region ourselves.
 */

const URL = "https://api.weather.gov/alerts/active";

/**
 * Most alerts have no inline polygon.
 *
 * Measured against the live feed: 18 of 177 active alerts carried geometry; the
 * other 159 referenced forecast/county zones by URL — and the ones that matter
 * most here (Air Quality Alert, Red Flag Warning) were all in that group.
 * Dropping them would leave the alerts layer permanently near-empty, so zones
 * are resolved to geometry and cached.
 */
const MAX_ZONE_FETCHES_PER_RUN = 60;
const ZONE_FETCH_CONCURRENCY = 4;

/** Alert types worth surfacing for a smoke-and-air-quality question. */
const RELEVANT = [
  "Air Quality Alert",
  "Red Flag Warning",
  "Fire Weather Watch",
  "Dense Smoke Advisory",
  "Excessive Heat Warning",
  "Heat Advisory",
  "High Wind Warning",
  "Wind Advisory",
];

function intersectsRegion(geometry: ProviderJson): boolean {
  if (!geometry) return false;
  const [west, south, east, north] = config.regionBBox;

  const coords: number[][] = [];
  const walk = (node: ProviderJson): void => {
    if (!Array.isArray(node)) return;
    if (typeof node[0] === "number" && typeof node[1] === "number") {
      coords.push(node as number[]);
      return;
    }
    node.forEach(walk);
  };
  walk(geometry.coordinates);

  return coords.some(
    ([lon, lat]) => lon >= west && lon <= east && lat >= south && lat <= north,
  );
}

/** Merge several zone polygons into one MultiPolygon for the alert's footprint. */
function mergeGeometries(geometries: ProviderJson[]): ProviderJson | null {
  const polygons: unknown[] = [];
  for (const g of geometries) {
    if (!g) continue;
    if (g.type === "Polygon") polygons.push(g.coordinates);
    else if (g.type === "MultiPolygon") polygons.push(...g.coordinates);
  }
  if (polygons.length === 0) return null;
  return { type: "MultiPolygon", coordinates: polygons };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    results.push(...(await Promise.all(items.slice(i, i + limit).map(fn))));
  }
  return results;
}

export const nws: SourceAdapter = {
  id: "nws",
  cadenceSec: 900,
  canBackfill: false,
  isConfigured: () => true, // no key required

  async fetchWindow(_from: Date, _to: Date, ctx?: FetchContext): Promise<FetchResult> {
    const headers = {
      // NWS rejects requests without a real contact string.
      "User-Agent": config.nwsUserAgent,
      Accept: "application/geo+json",
    };

    const req = await fetchText(URL, { headers, timeoutMs: 30_000 });
    assertOk(req);

    const json: ProviderJson = JSON.parse(req.body);
    const features: ProviderJson[] = json.features ?? [];
    const requests = [req];
    const events: FetchResult["events"] = [];

    // Narrow to what we care about before spending any zone requests.
    const candidates = features.filter(
      (f: ProviderJson) => RELEVANT.includes(f.properties?.event),
    );

    // Resolve zone geometry for the candidates that have no inline polygon.
    const neededZones = new Set<string>();
    for (const f of candidates) {
      if (f.geometry) continue;
      for (const z of (f.properties?.affectedZones ?? []) as string[]) {
        neededZones.add(z);
      }
    }

    const zoneGeom = new Map<string, unknown>(
      neededZones.size > 0 && ctx?.lookupZones
        ? await ctx.lookupZones([...neededZones])
        : [],
    );

    const missing = [...neededZones]
      .filter((z) => !zoneGeom.has(z))
      .slice(0, MAX_ZONE_FETCHES_PER_RUN);

    const fetched: ZoneRow[] = [];
    await mapWithConcurrency(missing, ZONE_FETCH_CONCURRENCY, async (url) => {
      const zr = await fetchText(url, { headers, timeoutMs: 20_000 });
      requests.push(zr);
      if (zr.status < 200 || zr.status >= 300) return;
      try {
        const zone: ProviderJson = JSON.parse(zr.body);
        if (!zone.geometry) return;
        zoneGeom.set(url, zone.geometry);
        fetched.push({ id: url, name: zone.properties?.name ?? null, geometry: zone.geometry });
      } catch {
        /* malformed zone — the alert simply stays unplaced */
      }
    });

    let unplaced = 0;

    for (const f of candidates) {
      const p = f.properties ?? {};

      const geometry =
        f.geometry ??
        mergeGeometries(
          ((p.affectedZones ?? []) as string[])
            .map((z) => zoneGeom.get(z))
            .filter(Boolean) as ProviderJson[],
        );

      if (!geometry) {
        unplaced++;
        continue;
      }
      if (!intersectsRegion(geometry)) continue;

      const validFrom = new Date(p.effective ?? p.onset ?? p.sent);
      if (Number.isNaN(validFrom.getTime())) continue;
      const expires = p.expires ? new Date(p.expires) : null;

      events.push({
        sourceId: "nws",
        kind: "nws_alert",
        externalId: p.id ?? f.id,
        geometry,
        validFrom,
        validTo: expires && !Number.isNaN(expires.getTime()) ? expires : null,
        attrs: {
          event: p.event,
          severity: p.severity,
          urgency: p.urgency,
          certainty: p.certainty,
          headline: p.headline,
          areaDesc: p.areaDesc,
          senderName: p.senderName,
          geometrySource: f.geometry ? "inline" : "zones",
        },
        requestIndex: 0,
      });
    }

    return {
      requests,
      events,
      zones: fetched,
      note:
        `${features.length} active US alerts, ${candidates.length} of relevant type, ` +
        `${events.length} placed in region` +
        (fetched.length > 0 ? `, ${fetched.length} zones newly cached` : "") +
        (unplaced > 0 ? `, ${unplaced} unplaced (no geometry)` : ""),
    };
  },
};
