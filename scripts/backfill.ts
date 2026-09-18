/**
 * One-off history backfill. Run locally, not on Vercel — the tier-A PM2.5
 * sweep takes minutes and would blow any serverless time limit.
 *
 *   npx tsx scripts/backfill.ts            # everything
 *   npx tsx scripts/backfill.ts firms      # one source
 *   npx tsx scripts/backfill.ts openaq-history
 *
 * Progress is checkpointed per sensor, so an interrupted run resumes instead
 * of restarting from zero.
 */

import "./env";
import { config } from "../lib/config";
import { bulkInsert, pool, sql } from "../lib/db";
import { historyWindow } from "../lib/ingest/revalidate";
import {
  OBSERVATION_COLUMNS,
  OBSERVATION_ON_CONFLICT,
  runIngest,
} from "../lib/ingest/run";
import { fetchSensorHistory } from "../lib/sources/openaq";

function log(...args: unknown[]): void {
  console.log(new Date().toISOString().slice(11, 19), ...args);
}

async function backfillSource(id: string): Promise<void> {
  const { from, to } = historyWindow();
  log(`→ ${id}: ${from.toISOString()} … ${to.toISOString()}`);
  const result = await runIngest(id, from, to);
  if (result.ok) {
    log(`✓ ${id}: ${result.rowsWritten} rows in ${(result.durationMs / 1000).toFixed(1)}s${result.note ? ` — ${result.note}` : ""}`);
  } else {
    log(`✗ ${id}: ${result.skipped ?? ""} ${result.error ?? ""}`);
  }
}

/**
 * Tier-A PM2.5 history. This is the long pole: OpenAQ's historical API is
 * sensor-scoped (no "everything in this bbox last week" endpoint), so 7 days
 * of history costs one request per sensor at ~48/min.
 *
 * Tiering is what keeps this under 10 minutes instead of 40: ~300 stations get
 * full history, everything else gets the live edge from the bulk /latest call
 * in the regular poll.
 */
async function backfillOpenAQHistory(): Promise<void> {
  const { from, to } = historyWindow();

  const stations = await sql<{
    id: string;
    external_id: string;
    metadata: { sensorId?: number; isMonitor?: boolean };
  }>(
    `select s.id, s.external_id, s.metadata
       from stations s
      where s.source_id = 'openaq'
        and s.history_tier = 'A'
        and not exists (
          select 1 from observations o
           where o.station_id = s.id
             and o.param = 'pm25'
             and o.observed_at < now() - interval '24 hours'
        )
      order by s.id`,
  );

  if (stations.length === 0) {
    log("✓ openaq-history: every tier-A station already has history");
    return;
  }

  log(`→ openaq-history: ${stations.length} tier-A sensors need backfill (~${Math.ceil((stations.length * 1.3) / 60)} min)`);

  const runRows = await sql<{ id: string }>(
    `insert into ingest_runs (source_id, window_from, window_to)
     values ('openaq', $1::timestamptz, $2::timestamptz) returning id`,
    [from.toISOString(), to.toISOString()],
  );
  const runId = Number(runRows[0].id);

  let written = 0;
  let failed = 0;

  for (const [i, station] of stations.entries()) {
    const sensorId = station.metadata?.sensorId;
    if (!sensorId) continue;

    try {
      const { requests, observations } = await fetchSensorHistory(
        sensorId,
        Number(station.external_id),
        Boolean(station.metadata?.isMonitor),
        from,
        to,
      );

      if (observations.length > 0) {
        const raw = await sql<{ id: string }>(
          `insert into raw_payloads (source_id, request_url, status, body)
           values ('openaq', $1, $2, $3) returning id`,
          [requests[0].url, requests[0].status, requests[0].body.slice(0, 200_000)],
        );
        const rawId = Number(raw[0].id);

        const { count } = await bulkInsert(
          pool,
          "observations",
          OBSERVATION_COLUMNS,
          observations.map((o) => [
            station.id,
            o.param,
            o.observedAt.toISOString(),
            o.value,
            o.unit,
            o.qualityFlag ?? null,
            rawId,
          ]),
          { onConflict: OBSERVATION_ON_CONFLICT },
        );
        written += count;
      }
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      log(`  ! sensor ${sensorId}: ${message.slice(0, 120)}`);
    }

    if ((i + 1) % 25 === 0) {
      log(`  … ${i + 1}/${stations.length} sensors, ${written} rows`);
    }
  }

  await sql(
    `update ingest_runs set finished_at = now(), ok = true, rows_written = $2, error = $3
      where id = $1`,
    [runId, written, `tier-A history: ${stations.length - failed} ok, ${failed} failed`],
  );

  log(`✓ openaq-history: ${written} rows, ${failed} sensors failed`);
}

async function main(): Promise<void> {
  const target = process.argv[2] ?? "all";
  log(`region ${config.regionBBox.join(",")}, ${config.historyDays}d history`);

  try {
    if (target === "all") {
      // Order matters: OpenAQ discovery must run before its history sweep,
      // and both are slower than the others.
      for (const id of ["firms", "nws", "open_meteo", "openaq"]) {
        await backfillSource(id);
      }
      await backfillOpenAQHistory();
    } else if (target === "openaq-history") {
      await backfillOpenAQHistory();
    } else {
      await backfillSource(target);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
