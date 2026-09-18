import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { historyWindow } from "@/lib/ingest/revalidate";
import { runIngest } from "@/lib/ingest/run";
import { SOURCE_IDS } from "@/lib/sources";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Manual / backfill ingestion trigger. Guarded by a shared secret — this is
 * the only write endpoint in the system.
 *
 * POST /api/ingest/firms?hours=168
 * POST /api/ingest/all
 */

function authorized(req: Request): boolean {
  if (!config.ingestSecret) return false;
  return req.headers.get("x-ingest-secret") === config.ingestSecret;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ source: string }> },
) {
  if (!authorized(req)) {
    return NextResponse.json(
      { error: "unauthorized — set INGEST_SECRET and send it as x-ingest-secret" },
      { status: 401 },
    );
  }

  const { source } = await params;
  const url = new URL(req.url);
  const hours = Number(url.searchParams.get("hours") ?? 0);

  const now = new Date();
  const window = hours > 0
    ? { from: new Date(now.getTime() - hours * 3600_000), to: now }
    : historyWindow(now);

  const targets = source === "all" ? SOURCE_IDS : [source];
  if (source !== "all" && !SOURCE_IDS.includes(source)) {
    return NextResponse.json(
      { error: `unknown source "${source}"`, known: SOURCE_IDS },
      { status: 404 },
    );
  }

  // Sequential rather than parallel: each adapter is already internally
  // throttled, and running them together would stack four concurrent
  // provider budgets against the same serverless time limit.
  const results = [];
  for (const id of targets) {
    results.push(await runIngest(id, window.from, window.to));
  }

  const ok = results.every((r) => r.ok);
  return NextResponse.json(
    {
      ok,
      window: { from: window.from.toISOString(), to: window.to.toISOString() },
      results,
    },
    { status: ok ? 200 : 207 },
  );
}
