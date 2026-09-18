import { NextResponse } from "next/server";
import { config, type BBox } from "@/lib/config";
import { scheduleRevalidation } from "@/lib/ingest/revalidate";
import { clampBBox } from "@/lib/lod";
import { getWindow } from "@/lib/query/window";

export const dynamic = "force-dynamic";

/**
 * The timeline payload. Serves from the database immediately and schedules any
 * stale-source refresh to run AFTER the response is sent, so the caller never
 * waits on an upstream provider.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);

  const now = new Date();
  const to = url.searchParams.get("to")
    ? new Date(url.searchParams.get("to")!)
    : now;
  const from = url.searchParams.get("from")
    ? new Date(url.searchParams.get("from")!)
    : new Date(to.getTime() - config.historyDays * 86_400_000);

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
    return NextResponse.json({ error: "invalid from/to" }, { status: 400 });
  }

  // Clamp the span so a careless or hostile range can't ask for a year.
  const maxMs = config.historyDays * 86_400_000;
  const clampedFrom =
    to.getTime() - from.getTime() > maxMs ? new Date(to.getTime() - maxMs) : from;

  // Clamped rather than rejected: a zoomed-out viewport legitimately produces
  // out-of-range coordinates, and the caller wants a map, not a 400.
  let bbox: BBox = config.regionBBox;
  const raw = url.searchParams.get("bbox");
  if (raw) {
    const parts = raw.split(",").map(Number);
    if (parts.length === 4 && parts.every(Number.isFinite)) {
      bbox = clampBBox(parts as BBox);
    }
  }

  try {
    const payload = await getWindow(clampedFrom, to, bbox);

    // Costs one cheap staleness query; the ingests it schedules run after the
    // response is sent, so the caller never waits on a provider.
    await scheduleRevalidation();

    return NextResponse.json(payload, {
      headers: { "Cache-Control": "s-maxage=60, stale-while-revalidate=300" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
