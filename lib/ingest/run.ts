import {
  asGeoJson,
  asGeography,
  asJsonb,
  asTimestamp,
  bulkInsert,
  sql,
  withClient,
  type Querier,
} from "../db";
import { acquireLock, releaseLock } from "./lock";
import { getAdapter } from "../sources";
import type {
  EventRow,
  ObsRow,
  RawRequest,
  StationRow,
  ZoneRow,
} from "../sources/types";

/**
 * The one write path. Adapters fetch and normalize; everything that touches the
 * database happens here, so provenance linking, upsert semantics and error
 * logging are written once rather than once per feed.
 */

export interface IngestResult {
  sourceId: string;
  ok: boolean;
  skipped?: "locked" | "not_configured";
  rowsWritten: number;
  runId?: number;
  error?: string;
  note?: string;
  durationMs: number;
}

/** Provider bodies are kept to stay inspectable, not byte-perfect. */
const MAX_BODY_CHARS = 200_000;

/**
 * Collapse rows that share a natural key, keeping the last.
 *
 * Postgres rejects an INSERT ... ON CONFLICT DO UPDATE that touches the same
 * row twice in one statement, and providers do emit duplicates: OpenAQ's
 * /latest is offset-paginated over live data, so rows shift between pages and
 * reappear. Deduping belongs here rather than in each adapter — the writer owns
 * upsert semantics, and this way one careless feed can't break ingestion.
 */
function dedupeBy<T>(rows: T[], key: (row: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const row of rows) seen.set(key(row), row);
  return [...seen.values()];
}

/** Raw payloads go in first — every fact must point at the bytes it came from. */
async function writeRawPayloads(
  c: Querier,
  sourceId: string,
  requests: RawRequest[],
): Promise<number[]> {
  const { rows } = await bulkInsert<{ id: string }>(
    c,
    "raw_payloads",
    [{ name: "source_id" }, { name: "request_url" }, { name: "status" }, { name: "body" }],
    requests.map((r) => [sourceId, r.url, r.status, r.body.slice(0, MAX_BODY_CHARS)]),
    { returning: "id" },
  );
  return rows.map((r) => Number(r.id));
}

/**
 * history_tier promotion is sticky: once a station has been backfilled as tier
 * A, a later discovery run must not demote it, or we would silently orphan the
 * history we already paid for.
 */
async function upsertStations(c: Querier, stations: StationRow[]): Promise<void> {
  await bulkInsert(
    c,
    "stations",
    [
      { name: "source_id" },
      { name: "external_id" },
      { name: "name" },
      { name: "geom", expr: asGeography },
      { name: "history_tier" },
      { name: "metadata", expr: asJsonb },
    ],
    dedupeBy(stations, (s) => `${s.sourceId}:${s.externalId}`).map((s) => [
      s.sourceId,
      s.externalId,
      s.name,
      `SRID=4326;POINT(${s.lon} ${s.lat})`,
      s.historyTier ?? "B",
      JSON.stringify(s.metadata ?? {}),
    ]),
    {
      chunkSize: 500,
      onConflict: `on conflict (source_id, external_id) do update
         set name         = excluded.name,
             geom         = excluded.geom,
             metadata     = excluded.metadata,
             history_tier = case when stations.history_tier = 'A' then 'A'
                                 else excluded.history_tier end`,
    },
  );
}

/**
 * Natural key → station id.
 *
 * Resolved from the database rather than from the upsert's RETURNING, because
 * observations routinely reference stations inserted by an EARLIER run (the
 * Open-Meteo grid, or OpenAQ stations discovered last poll). One query covers
 * both cases.
 */
async function resolveStationIds(
  c: Querier,
  sourceId: string,
  externalIds: string[],
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (externalIds.length === 0) return map;

  const { rows } = await c.query<{ id: string; external_id: string }>(
    `select id, external_id from stations
      where source_id = $1 and external_id = any($2::text[])`,
    [sourceId, externalIds],
  );
  for (const r of rows) map.set(r.external_id, Number(r.id));
  return map;
}

/**
 * Providers revise values, so last-write-wins with a fresh ingested_at is
 * correct — and it is exactly what makes the observed_at/ingested_at split
 * meaningful.
 */
async function upsertObservations(
  c: Querier,
  observations: ObsRow[],
  stationIds: Map<string, number>,
  rawIds: number[],
): Promise<number> {
  const unique = dedupeBy(
    observations,
    (o) => `${o.externalId}:${o.param}:${o.observedAt.toISOString()}`,
  );

  const rows: unknown[][] = [];
  for (const o of unique) {
    const stationId = stationIds.get(o.externalId);
    if (!stationId) continue; // unknown station — skip rather than orphan
    rows.push([
      stationId,
      o.param,
      o.observedAt.toISOString(),
      o.value,
      o.unit,
      o.qualityFlag ?? null,
      o.requestIndex !== undefined ? (rawIds[o.requestIndex] ?? null) : null,
    ]);
  }

  const { count } = await bulkInsert(c, "observations", OBSERVATION_COLUMNS, rows, {
    onConflict: OBSERVATION_ON_CONFLICT,
  });
  return count;
}

/** Shared with the backfill script, which writes observations the same way. */
export const OBSERVATION_COLUMNS = [
  { name: "station_id" },
  { name: "param" },
  { name: "observed_at", expr: asTimestamp },
  { name: "value" },
  { name: "unit" },
  { name: "quality_flag" },
  { name: "raw_id" },
];

export const OBSERVATION_ON_CONFLICT = `on conflict (station_id, param, observed_at) do update
   set value        = excluded.value,
       unit         = excluded.unit,
       quality_flag = excluded.quality_flag,
       raw_id       = excluded.raw_id,
       ingested_at  = now()`;

/**
 * Zone boundaries are static, so this is write-once and read forever. Lending
 * the adapter a lookup (rather than letting it import the database) keeps the
 * fetch-and-normalize contract intact.
 */
async function lookupZones(ids: string[]): Promise<Map<string, unknown>> {
  const map = new Map<string, unknown>();
  if (ids.length === 0) return map;
  const rows = await sql<{ id: string; geometry: unknown }>(
    `select id, st_asgeojson(geom::geometry)::json as geometry
       from nws_zones where id = any($1::text[])`,
    [ids],
  );
  for (const r of rows) map.set(r.id, r.geometry);
  return map;
}

async function upsertZones(c: Querier, zones: ZoneRow[]): Promise<void> {
  await bulkInsert(
    c,
    "nws_zones",
    [{ name: "id" }, { name: "name" }, { name: "geom", expr: asGeoJson }],
    dedupeBy(zones, (z) => z.id).map((z) => [z.id, z.name, JSON.stringify(z.geometry)]),
    { chunkSize: 200, onConflict: "on conflict (id) do nothing" },
  );
}

/**
 * Fire detections are immutable, but NWS alerts get extended or amended in
 * place, so valid_to and attrs are refreshed while the geometry and timestamps
 * that define the event stay put.
 */
async function upsertEvents(
  c: Querier,
  events: EventRow[],
  rawIds: number[],
): Promise<number> {
  const { count } = await bulkInsert(
    c,
    "events",
    [
      { name: "source_id" },
      { name: "kind" },
      { name: "external_id" },
      { name: "geom", expr: asGeoJson },
      { name: "valid_from", expr: asTimestamp },
      { name: "valid_to", expr: asTimestamp },
      { name: "attrs", expr: asJsonb },
      { name: "raw_id" },
    ],
    dedupeBy(events, (e) => `${e.sourceId}:${e.kind}:${e.externalId}`).map((e) => [
      e.sourceId,
      e.kind,
      e.externalId,
      JSON.stringify(e.geometry),
      e.validFrom.toISOString(),
      e.validTo ? e.validTo.toISOString() : null,
      JSON.stringify(e.attrs ?? {}),
      e.requestIndex !== undefined ? (rawIds[e.requestIndex] ?? null) : null,
    ]),
    {
      chunkSize: 500,
      onConflict: `on conflict (source_id, kind, external_id) do update
         set valid_to = excluded.valid_to, attrs = excluded.attrs`,
    },
  );
  return count;
}

/**
 * Fetch one source's window and write it. Never throws: a failure becomes an
 * ingest_runs row with ok=false and the error text, so no window is ever lost
 * silently.
 */
export async function runIngest(
  sourceId: string,
  from: Date,
  to: Date,
): Promise<IngestResult> {
  const startedAt = Date.now();
  const adapter = getAdapter(sourceId);

  if (!adapter.isConfigured()) {
    return {
      sourceId,
      ok: false,
      skipped: "not_configured",
      rowsWritten: 0,
      error: `${sourceId} is missing its API key`,
      durationMs: Date.now() - startedAt,
    };
  }

  if (!(await acquireLock(sourceId))) {
    return {
      sourceId,
      ok: true,
      skipped: "locked",
      rowsWritten: 0,
      durationMs: Date.now() - startedAt,
    };
  }

  const runRows = await sql<{ id: string }>(
    `insert into ingest_runs (source_id, window_from, window_to)
     values ($1, $2::timestamptz, $3::timestamptz) returning id`,
    [sourceId, from.toISOString(), to.toISOString()],
  );
  const runId = Number(runRows[0].id);

  try {
    const result = await adapter.fetchWindow(from, to, { lookupZones });
    const observations = result.observations ?? [];

    const rowsWritten = await withClient(async (c) => {
      await c.query("begin");
      try {
        const rawIds = await writeRawPayloads(c, sourceId, result.requests);
        await upsertStations(c, result.stations ?? []);
        await upsertZones(c, result.zones ?? []);

        const stationIds = await resolveStationIds(
          c,
          sourceId,
          [...new Set(observations.map((o) => o.externalId))],
        );

        const written =
          (await upsertObservations(c, observations, stationIds, rawIds)) +
          (await upsertEvents(c, result.events ?? [], rawIds));

        await c.query("commit");
        return written;
      } catch (err) {
        await c.query("rollback");
        throw err;
      }
    });

    await sql(
      `update ingest_runs
         set finished_at = now(), ok = true, rows_written = $2, error = $3
       where id = $1`,
      [runId, rowsWritten, result.note ?? null],
    );

    return {
      sourceId,
      ok: true,
      rowsWritten,
      runId,
      note: result.note,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await sql(
      `update ingest_runs set finished_at = now(), ok = false, error = $2 where id = $1`,
      [runId, message.slice(0, 2000)],
    );
    return {
      sourceId,
      ok: false,
      rowsWritten: 0,
      runId,
      error: message,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    await releaseLock(sourceId).catch(() => {});
  }
}
