import { config, type BBox } from "../config";
import { sql } from "../db";

export interface AlertHit {
  id: number;
  event: string;
  severity: string | null;
  headline: string | null;
  area: string | null;
  from: string;
  to: string | null;
}

export interface AlertsResult {
  alerts: AlertHit[];
  outOfCoverage: boolean;
  coverageNote: string | null;
  note?: string;
}

/**
 * Active weather alerts in an area.
 *
 * The important part is `outOfCoverage`. NWS issues alerts for US territory
 * only, so "no alerts in Vancouver" and "no alert COVERAGE in Vancouver" are
 * completely different claims, and conflating them is exactly the failure mode
 * the data-quality requirement is probing for. The coverage polygon lives in
 * sources.coverage_geom, so this is answered from data rather than a hardcoded
 * assumption.
 */
export async function getAlerts(opts: {
  bbox?: BBox;
  at?: Date;
}): Promise<AlertsResult> {
  const bbox = opts.bbox ?? config.regionBBox;
  const at = opts.at ?? new Date();

  // A null coverage_geom means global coverage, tested with `is null` rather
  // than a world-sized envelope: as a geography, an edge spanning -180..180 is
  // antipodal and PostGIS rejects it — and because the expression is constant,
  // it fails at plan time even when coalesce would never have reached it.
  const coverage = await sql<{ covered: boolean; note: string | null }>(
    `select (s.coverage_geom is null
             or st_intersects(s.coverage_geom,
                              st_makeenvelope($1, $2, $3, $4, 4326)::geography)) as covered,
            s.coverage_note as note
       from sources s where s.id = 'nws'`,
    bbox as unknown[],
  );

  const covered = coverage[0]?.covered ?? false;
  const coverageNote = coverage[0]?.note ?? null;

  if (!covered) {
    return {
      alerts: [],
      outOfCoverage: true,
      coverageNote,
      note:
        "This area is outside NWS coverage. There is NO ALERT DATA here — " +
        "that is not the same as there being no alerts.",
    };
  }

  const rows = await sql<{
    id: string; attrs: Record<string, string>;
    valid_from: Date; valid_to: Date | null;
  }>(
    `select e.id, e.attrs, e.valid_from, e.valid_to
       from events e
      where e.kind = 'nws_alert'
        and e.valid_from <= $5::timestamptz
        and (e.valid_to is null or e.valid_to >= $5::timestamptz)
        and st_intersects(e.geom, st_makeenvelope($1, $2, $3, $4, 4326)::geography)
      order by e.valid_from desc
      limit 100`,
    [...bbox, at.toISOString()],
  );

  return {
    alerts: rows.map((r) => ({
      id: Number(r.id),
      event: r.attrs?.event ?? "Alert",
      severity: r.attrs?.severity ?? null,
      headline: r.attrs?.headline ?? null,
      area: r.attrs?.areaDesc ?? null,
      from: r.valid_from.toISOString(),
      to: r.valid_to ? r.valid_to.toISOString() : null,
    })),
    outOfCoverage: false,
    coverageNote,
    note:
      rows.length === 0
        ? "No active alerts in this area at this time. (This area IS within NWS coverage, " +
          "so this is a real absence.) Note that alert history is only captured while the " +
          "app is in use — NWS has no historical endpoint."
        : undefined,
  };
}
