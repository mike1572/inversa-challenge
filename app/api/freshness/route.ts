import { NextResponse } from "next/server";
import { getSourceHealth } from "@/lib/query/freshness";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const sources = await getSourceHealth();
    return NextResponse.json({ sources, checkedAt: new Date().toISOString() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
