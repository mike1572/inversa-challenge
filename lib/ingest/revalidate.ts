import { waitUntil } from "@vercel/functions";
import { config } from "../config";
import { getStaleSources } from "../query/freshness";
import { getAdapter } from "../sources";
import { runIngest } from "./run";

/**
 * Lazy revalidation — the reason this system needs no cron.
 *
 * Cron exists to make things happen when nobody is watching. At this scale
 * nothing needs to, and FIRMS / OpenAQ / Open-Meteo all expose historical
 * endpoints, so a gap of any length can be filled retroactively on the next
 * request.
 *
 * On every read: check each source's last success, and for anything staler
 * than its cadence, schedule ingestion of the missing window via waitUntil so
 * it runs AFTER the response is sent. The caller is served from the database
 * immediately and never waits on an upstream provider; the refresh lands in
 * time for the next request.
 *
 * The exception is NWS, whose active-alerts endpoint cannot be backfilled — so
 * its history only accumulates while the app is in use. Disclosed, not hidden.
 */

/** Cap the catch-up window: a long-idle deployment shouldn't try to refetch a month. */
const MAX_CATCHUP_HOURS = 24;

export async function scheduleRevalidation(): Promise<string[]> {
  let stale: { id: string; lastSuccess: Date | null }[];
  try {
    stale = await getStaleSources();
  } catch {
    return []; // never let revalidation break a read
  }

  const now = new Date();
  const scheduled: string[] = [];

  for (const { id, lastSuccess } of stale) {
    let adapter;
    try {
      adapter = getAdapter(id);
    } catch {
      continue;
    }
    if (!adapter.isConfigured()) continue;

    const earliest = new Date(now.getTime() - MAX_CATCHUP_HOURS * 3600_000);
    const from = lastSuccess && lastSuccess > earliest ? lastSuccess : earliest;

    scheduled.push(id);
    // Fire and forget. runIngest never throws and takes the lease itself, so
    // ten concurrent visitors trigger one ingest, not ten.
    waitUntil(runIngest(id, from, now).catch(() => undefined));
  }

  return scheduled;
}

/** Full-history window, used by the backfill script and the first cold start. */
export function historyWindow(now = new Date()): { from: Date; to: Date } {
  return {
    from: new Date(now.getTime() - config.historyDays * 86_400_000),
    to: now,
  };
}
