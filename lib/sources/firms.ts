import { bboxParam, config } from "../config";
import { assertOk, fetchText, type FetchResult, type SourceAdapter } from "./types";

/**
 * NASA FIRMS — satellite active-fire detections. The "cause" feed.
 *
 * Verified against the docs: bbox order is west,south,east,north, and
 * day_range maxes out at 5 (not 10), so a 7-day backfill needs two calls.
 * A continental bbox costs no more requests than a small one.
 * Limit is 5,000 transactions / 10 minutes, which we are nowhere near.
 */

const BASE = "https://firms.modaps.eosdis.nasa.gov/api/area/csv";
const SATELLITE = "VIIRS_SNPP_NRT";
const MAX_DAY_RANGE = 5;

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** FIRMS CSV gives acq_date=YYYY-MM-DD and acq_time=HHMM, both UTC. */
function acquiredAt(date: string, time: string): Date {
  const padded = time.padStart(4, "0");
  return new Date(`${date}T${padded.slice(0, 2)}:${padded.slice(2, 4)}:00Z`);
}

function parseCsv(body: string): Record<string, string>[] {
  const lines = body.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((h) => h.trim());
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",");
    if (cells.length !== header.length) continue;
    const row: Record<string, string> = {};
    header.forEach((h, j) => (row[h] = cells[j].trim()));
    rows.push(row);
  }
  return rows;
}

export const firms: SourceAdapter = {
  id: "firms",
  cadenceSec: 1800,
  canBackfill: true,
  isConfigured: () => Boolean(config.firmsMapKey),

  async fetchWindow(from: Date, to: Date): Promise<FetchResult> {
    if (!config.firmsMapKey) throw new Error("FIRMS_MAP_KEY is not set");

    /**
     * DATE is the START of the range and DAY_RANGE counts FORWARD from it.
     *
     * Verified against the live API: (days=5, date=09-12) returns 09-12..09-16,
     * while (days=5, date=09-17) returns only 09-17 because the rest is in the
     * future. Reading it as an end date silently drops most of the window —
     * every request still succeeds, so the only symptom is holes in the
     * timeline that look like quiet days.
     */
    const dayStart = (d: Date) =>
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

    const firstDay = dayStart(from);
    const lastDay = dayStart(to);

    const chunks: { days: number; startDate: string }[] = [];
    for (let cursor = firstDay; cursor <= lastDay; ) {
      const remaining = Math.floor((lastDay - cursor) / 86_400_000) + 1;
      const days = Math.min(MAX_DAY_RANGE, remaining);
      chunks.push({ days, startDate: ymd(new Date(cursor)) });
      cursor += days * 86_400_000;
    }

    const requests = [];
    const seen = new Set<string>();
    const events: FetchResult["events"] = [];

    for (const [index, chunk] of chunks.entries()) {
      const url = `${BASE}/${config.firmsMapKey}/${SATELLITE}/${bboxParam()}/${chunk.days}/${chunk.startDate}`;
      const req = await fetchText(url);
      requests.push(req);
      assertOk(req);

      // FIRMS answers an invalid key with HTTP 200 and a plaintext complaint.
      if (req.body.startsWith("Invalid") || !req.body.includes("latitude")) {
        throw new Error(`FIRMS returned no CSV header: ${req.body.slice(0, 200)}`);
      }

      for (const row of parseCsv(req.body)) {
        const lat = Number(row.latitude);
        const lon = Number(row.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

        const validFrom = acquiredAt(row.acq_date, row.acq_time);
        if (Number.isNaN(validFrom.getTime())) continue;
        if (validFrom < from || validFrom > to) continue;

        // Detections are immutable; this natural key dedupes the chunk overlap.
        const externalId = `${lat.toFixed(5)}:${lon.toFixed(5)}:${validFrom.toISOString()}:${row.satellite ?? "n"}`;
        if (seen.has(externalId)) continue;
        seen.add(externalId);

        events.push({
          sourceId: "firms",
          kind: "fire_detection",
          externalId,
          geometry: { type: "Point", coordinates: [lon, lat] },
          validFrom,
          validTo: null,
          attrs: {
            frp: Number(row.frp) || 0,
            confidence: row.confidence ?? null,
            satellite: row.satellite ?? null,
            daynight: row.daynight ?? null,
            bright_ti4: Number(row.bright_ti4) || null,
          },
          requestIndex: index,
        });
      }
    }

    return { requests, events };
  },
};
