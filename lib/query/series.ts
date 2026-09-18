import { sql } from "../db";

export interface SeriesPoint {
  t: string;
  value: number | null;
}

export interface SeriesResult {
  stationId: number;
  stationName: string;
  param: string;
  unit: string | null;
  historyTier: "A" | "B";
  points: SeriesPoint[];
  gaps: number;
  note?: string;
}

/**
 * Hourly series for one or more stations.
 *
 * Gaps are returned as explicit nulls rather than being closed over, and
 * history_tier travels with the result so the agent can say "this station only
 * has live data" instead of presenting a two-hour stub as a complete series.
 */
export async function getSeries(opts: {
  stationIds: number[];
  param: string;
  from: Date;
  to: Date;
}): Promise<SeriesResult[]> {
  if (opts.stationIds.length === 0) return [];

  const rows = await sql<{
    station_id: string; name: string; history_tier: "A" | "B";
    observed_at: Date; value: number | null; unit: string;
  }>(
    `select o.station_id,
            coalesce(s.name, 'Station ' || s.id) as name,
            s.history_tier,
            o.observed_at, o.value, o.unit
       from observations o
       join stations s on s.id = o.station_id
      where o.station_id = any($1::bigint[])
        and o.param = $2
        and o.observed_at >= $3::timestamptz
        and o.observed_at <  $4::timestamptz
      order by o.station_id, o.observed_at`,
    [opts.stationIds, opts.param, opts.from.toISOString(), opts.to.toISOString()],
  );

  // Stations with no rows at all must still come back, so the agent learns the
  // difference between "no data" and "station doesn't exist".
  const meta = await sql<{ id: string; name: string; history_tier: "A" | "B" }>(
    `select id, coalesce(name, 'Station ' || id) as name, history_tier
       from stations where id = any($1::bigint[])`,
    [opts.stationIds],
  );

  const hours = Math.max(1, Math.round((opts.to.getTime() - opts.from.getTime()) / 3600_000));
  const byStation = new Map<number, typeof rows>();
  for (const r of rows) {
    const id = Number(r.station_id);
    if (!byStation.has(id)) byStation.set(id, []);
    byStation.get(id)!.push(r);
  }

  return meta.map((m) => {
    const id = Number(m.id);
    const stationRows = byStation.get(id) ?? [];
    const valueAt = new Map<number, number | null>();
    let unit: string | null = null;

    for (const r of stationRows) {
      const h = Math.floor((r.observed_at.getTime() - opts.from.getTime()) / 3600_000);
      valueAt.set(h, r.value === null ? null : Number(r.value));
      unit ??= r.unit;
    }

    const points: SeriesPoint[] = [];
    let gaps = 0;
    for (let h = 0; h < hours; h++) {
      const v = valueAt.has(h) ? valueAt.get(h)! : null;
      if (v === null) gaps++;
      points.push({ t: new Date(opts.from.getTime() + h * 3600_000).toISOString(), value: v });
    }

    // Judged on the actual points present, not on history_tier. The tier
    // records which stations were SELECTED for backfill, and promotion is
    // sticky, so a station can be tier A without having been backfilled yet.
    // Counting what is really here cannot drift out of step with the data.
    const present = hours - gaps;
    const notes: string[] = [];

    if (gaps === hours) {
      notes.push("No data at all for this station in the requested range.");
    } else if (present < 12) {
      notes.push(
        `Only ${present} of ${hours} hours are present for this station — a short series ` +
          "here means a limited archive, NOT clean air. Do not read it as a trend.",
      );
    } else if (gaps > hours * 0.5) {
      notes.push(`Sparse: ${gaps} of ${hours} hours are missing.`);
    }

    return {
      stationId: id,
      stationName: m.name,
      param: opts.param,
      unit,
      historyTier: m.history_tier,
      points,
      gaps,
      note: notes.length > 0 ? notes.join(" ") : undefined,
    };
  });
}

export interface NormalComparison {
  stationId: number;
  stationName: string;
  param: string;
  value: number | null;
  at: string;
  percentile: number | null;
  median: number | null;
  sampleSize: number;
  verdict: string;
  note?: string;
}

/**
 * Where does the current value sit against this station's own history?
 *
 * The system prompt pushes the agent here rather than letting it call a number
 * "high" on instinct — 35 µg/m³ is routine in one place and alarming in
 * another, and only the station's own distribution knows which.
 */
export async function compareToNormal(opts: {
  stationId: number;
  param: string;
  at: Date;
}): Promise<NormalComparison | null> {
  const meta = await sql<{ id: string; name: string }>(
    `select id, coalesce(name, 'Station ' || id) as name from stations where id = $1`,
    [opts.stationId],
  );
  if (meta.length === 0) return null;

  const rows = await sql<{
    value: number | null; observed_at: Date | null;
    pct: number | null; med: number | null; n: string;
  }>(
    `with hist as (
        select value from observations
         where station_id = $1 and param = $2 and value is not null
     ), cur as (
        select value, observed_at from observations
         where station_id = $1 and param = $2 and value is not null
           and observed_at <= $3::timestamptz
         order by observed_at desc limit 1
     )
     select c.value,
            c.observed_at,
            (select count(*) from hist) as n,
            (select percentile_cont(0.5) within group (order by value) from hist) as med,
            (select count(*) filter (where h.value <= c.value)::float
                    / nullif(count(*), 0)
               from hist h) as pct
       from cur c`,
    [opts.stationId, opts.param, opts.at.toISOString()],
  );

  if (rows.length === 0 || rows[0].value === null) {
    return {
      stationId: opts.stationId,
      stationName: meta[0].name,
      param: opts.param,
      value: null,
      at: opts.at.toISOString(),
      percentile: null,
      median: null,
      sampleSize: 0,
      verdict: "unknown",
      note: "No reading at or before this time for this station.",
    };
  }

  const r = rows[0];
  const n = Number(r.n);
  const pct = r.pct === null ? null : Math.round(Number(r.pct) * 100);
  const value = Number(r.value);

  let verdict: string;
  if (pct === null || n < 24) verdict = "insufficient history to judge";
  else if (pct >= 95) verdict = "extreme for this station";
  else if (pct >= 80) verdict = "high for this station";
  else if (pct >= 40) verdict = "typical for this station";
  else verdict = "low for this station";

  return {
    stationId: opts.stationId,
    stationName: meta[0].name,
    param: opts.param,
    value,
    at: (r.observed_at ?? opts.at).toISOString(),
    percentile: pct,
    median: r.med === null ? null : Math.round(Number(r.med) * 10) / 10,
    sampleSize: n,
    verdict,
    note:
      n < 24
        ? `Only ${n} historical readings for this station — treat the percentile as indicative, not statistical.`
        : undefined,
  };
}
