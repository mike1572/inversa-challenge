import { sql } from "../db";

/**
 * One query behind both the UI freshness strip and the agent's data_freshness
 * tool, so the dots on screen and what the agent claims can never disagree.
 */

export type SourceStatus = "fresh" | "stale" | "down" | "never";

export interface SourceHealth {
  id: string;
  name: string;
  homepage: string;
  license: string | null;
  cadenceSec: number;
  canBackfill: boolean;
  coverageNote: string | null;
  lastSuccess: string | null;
  lagSec: number | null;
  status: SourceStatus;
  lastError: string | null;
}

interface Row {
  id: string;
  name: string;
  homepage: string;
  license: string | null;
  cadence_sec: number;
  can_backfill: boolean;
  coverage_note: string | null;
  last_success: Date | null;
  lag_sec: string | null;
  last_error: string | null;
}

export async function getSourceHealth(): Promise<SourceHealth[]> {
  const rows = await sql<Row>(
    `with success as (
        select source_id, max(finished_at) as last_success
          from ingest_runs where ok group by source_id
     )
     select s.id,
            s.name,
            s.homepage,
            s.license,
            s.cadence_sec,
            s.can_backfill,
            s.coverage_note,
            su.last_success,
            extract(epoch from now() - su.last_success) as lag_sec,
            -- Only failures SINCE the last success. A stale error sitting next
            -- to a green dot reads as "broken but pretending", which is worse
            -- than showing nothing at all.
            (select r.error
               from ingest_runs r
              where r.source_id = s.id
                and r.ok is false
                and r.started_at > coalesce(su.last_success, '-infinity'::timestamptz)
              order by r.started_at desc
              limit 1) as last_error
       from sources s
       left join success su on su.source_id = s.id
      order by s.id`,
  );

  return rows.map((r) => {
    const lagSec = r.lag_sec === null ? null : Number(r.lag_sec);
    let status: SourceStatus;
    if (lagSec === null) status = "never";
    else if (lagSec < r.cadence_sec * 1.5) status = "fresh";
    else if (lagSec < r.cadence_sec * 3) status = "stale";
    else status = "down";

    return {
      id: r.id,
      name: r.name,
      homepage: r.homepage,
      license: r.license,
      cadenceSec: r.cadence_sec,
      canBackfill: r.can_backfill,
      coverageNote: r.coverage_note,
      lastSuccess: r.last_success ? r.last_success.toISOString() : null,
      lagSec,
      status,
      lastError: r.last_error,
    };
  });
}

/** Sources whose last success is older than their expected cadence. */
export async function getStaleSources(): Promise<{ id: string; lastSuccess: Date | null }[]> {
  const rows = await sql<{ id: string; last_success: Date | null }>(
    `select s.id,
            max(r.finished_at) filter (where r.ok) as last_success
       from sources s
       left join ingest_runs r on r.source_id = s.id
      group by s.id, s.cadence_sec
     having max(r.finished_at) filter (where r.ok) is null
         or extract(epoch from now() - max(r.finished_at) filter (where r.ok)) > s.cadence_sec`,
  );
  return rows.map((r) => ({ id: r.id, lastSuccess: r.last_success }));
}
