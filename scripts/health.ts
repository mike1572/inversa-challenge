/**
 * End-to-end data health check. Run after a backfill.
 *
 *   npm run health
 */

import "./env";
import { pool, sql } from "../lib/db";
import { getSourceHealth } from "../lib/query/freshness";

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

async function main(): Promise<void> {
  console.log("\n── feeds ───────────────────────────────────────────────");
  const health = await getSourceHealth();
  for (const h of health) {
    const mark = { fresh: "✓", stale: "~", down: "✗", never: "·" }[h.status];
    const lag = h.lagSec === null ? "never ingested" : `${Math.round(h.lagSec / 60)}m ago`;
    console.log(`${mark} ${pad(h.id, 12)} ${pad(h.status, 7)} ${pad(lag, 18)}${h.lastError ? ` last error: ${h.lastError.slice(0, 70)}` : ""}`);
  }

  console.log("\n── stored data ─────────────────────────────────────────");
  const counts = await sql<{ label: string; n: string; oldest: Date | null; newest: Date | null }>(
    `select 'observations: ' || param as label, count(*)::text as n,
            min(observed_at) as oldest, max(observed_at) as newest
       from observations group by param
     union all
     select 'events: ' || kind, count(*)::text, min(valid_from), max(valid_from)
       from events group by kind
     union all
     select 'stations: ' || source_id || ' tier ' || history_tier, count(*)::text, null, null
       from stations group by source_id, history_tier
     order by 1`,
  );
  for (const c of counts) {
    const range =
      c.oldest && c.newest
        ? `  ${c.oldest.toISOString().slice(0, 16)} → ${c.newest.toISOString().slice(0, 16)}`
        : "";
    console.log(`  ${pad(c.label, 38)} ${pad(c.n, 9)}${range}`);
  }

  console.log("\n── data quality ────────────────────────────────────────");
  const [stale] = await sql<{ n: string }>(
    `select count(*)::text as n from stations s
      where s.source_id = 'openaq'
        and not exists (
          select 1 from observations o
           where o.station_id = s.id and o.param = 'pm25'
             and o.observed_at > now() - interval '2 hours')`,
  );
  console.log(`  stations with no reading in 2h   ${stale?.n ?? "0"}`);

  const [conflicts] = await sql<{ n: string }>(
    `select count(*)::text as n
       from observations a
       join stations sa on sa.id = a.station_id and sa.source_id = 'openaq'
       join stations sb on sb.id > sa.id and sb.source_id = 'openaq'
                       and st_dwithin(sa.geom, sb.geom, 2000)
       join observations b on b.station_id = sb.id and b.param = 'pm25'
                          and b.observed_at = a.observed_at and b.value is not null
      where a.param = 'pm25' and a.value is not null
        and a.observed_at > now() - interval '7 days'
        and greatest(a.value, b.value) > 12
        and abs(a.value - b.value) / nullif(greatest(a.value, b.value), 0) > 0.3`,
  );
  console.log(`  co-located sensor conflicts      ${conflicts?.n ?? "0"}`);

  const [runs] = await sql<{ ok: string; failed: string }>(
    `select count(*) filter (where ok)::text as ok,
            count(*) filter (where ok is false)::text as failed
       from ingest_runs where started_at > now() - interval '24 hours'`,
  );
  console.log(`  ingest runs (24h)                ${runs?.ok ?? 0} ok, ${runs?.failed ?? 0} failed`);

  const [queries] = await sql<{ n: string; ev: string }>(
    `select (select count(*)::text from queries) as n,
            (select count(*)::text from evidence) as ev`,
  );
  console.log(`  agent queries / evidence rows    ${queries?.n ?? 0} / ${queries?.ev ?? 0}`);

  console.log("");
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
