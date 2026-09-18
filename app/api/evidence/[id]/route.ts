import { NextResponse } from "next/server";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Provider URLs carry credentials — FIRMS puts the MAP_KEY directly in the
 * path. Evidence drill-down is a public surface, so the key never leaves the
 * server. Redacted here rather than only in the UI, since the API is reachable
 * on its own.
 */
function redactUrl(url: string): string {
  return url
    .replace(/(api\/area\/csv\/)[^/]+/, "$1«MAP_KEY»")
    .replace(/([?&](api_?key|key|token)=)[^&]+/gi, "$1«redacted»");
}

/**
 * One evidence row, expanded with the provider metadata and the raw request
 * that produced it. This is the literal implementation of "follow evidence to
 * its source" — one click from any number in any answer.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const evidenceId = Number(id);
  if (!Number.isFinite(evidenceId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const rows = await sql<{
    id: string; label: string; tool: string;
    args: unknown; result: unknown; source_ids: string[];
    created_at: Date; question: string;
  }>(
    `select e.id, e.label, e.tool, e.args, e.result, e.source_ids, e.created_at,
            q.question
       from evidence e
       left join queries q on q.id = e.query_id
      where e.id = $1`,
    [evidenceId],
  );

  if (rows.length === 0) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const e = rows[0];

  const sources = await sql<{
    id: string; name: string; homepage: string;
    license: string | null; coverage_note: string | null;
  }>(
    `select id, name, homepage, license, coverage_note
       from sources where id = any($1::text[])`,
    [e.source_ids],
  );

  // The most recent raw request per source backing this evidence: the exact
  // URL we called and when.
  const raw = await sql<{
    source_id: string; request_url: string; status: number; fetched_at: Date;
  }>(
    `select distinct on (source_id) source_id, request_url, status, fetched_at
       from raw_payloads
      where source_id = any($1::text[]) and fetched_at <= $2::timestamptz
      order by source_id, fetched_at desc`,
    [e.source_ids, e.created_at.toISOString()],
  );

  return NextResponse.json({
    id: Number(e.id),
    label: e.label,
    tool: e.tool,
    question: e.question,
    args: e.args,
    result: e.result,
    createdAt: e.created_at.toISOString(),
    sources: sources.map((s) => ({
      id: s.id,
      name: s.name,
      homepage: s.homepage,
      license: s.license,
      coverageNote: s.coverage_note,
      lastRequest: raw
        .filter((r) => r.source_id === s.id)
        .map((r) => ({
          url: redactUrl(r.request_url),
          status: r.status,
          fetchedAt: r.fetched_at.toISOString(),
        }))[0] ?? null,
    })),
  });
}
