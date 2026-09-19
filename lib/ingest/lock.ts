import { sql } from "../db";

/**
 * The stampede guard for ingestion.
 *
 * Lives apart from the write path because it is a distributed-locking concern,
 * not a data one, and the reasoning behind the table below is the part worth
 * keeping together.
 */

const LOCK_TTL_MINUTES = 5;

/**
 * Acquire the ingest lease.
 *
 * Deliberately a table rather than pg_try_advisory_lock: session-level advisory
 * locks belong to a CONNECTION, and Supabase's transaction pooler hands our
 * connection to another caller between statements, so the lock would be
 * orphaned and never released. The transaction-scoped variant is pooler-safe
 * but releases at commit, which is useless when the lock must be held across
 * several seconds of outbound HTTP.
 *
 * expires_at means a crashed invocation's lease lapses rather than wedging the
 * source forever.
 */
export async function acquireLock(sourceId: string): Promise<boolean> {
  const rows = await sql(
    `insert into ingest_locks (source_id, acquired_at, expires_at)
     values ($1, now(), now() + ($2 || ' minutes')::interval)
     on conflict (source_id) do update
       set acquired_at = now(),
           expires_at  = now() + ($2 || ' minutes')::interval
       where ingest_locks.expires_at < now()
     returning source_id`,
    [sourceId, String(LOCK_TTL_MINUTES)],
  );
  return rows.length > 0;
}

export async function releaseLock(sourceId: string): Promise<void> {
  await sql(`delete from ingest_locks where source_id = $1`, [sourceId]);
}
