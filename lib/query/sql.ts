/**
 * Shared SQL fragments.
 *
 * These encode decisions, not just syntax: what a station is called when it has
 * no name, what an absent FRP means, which jsonb path holds the instrument
 * grade. Each was repeated across five to ten queries, so changing any of them
 * meant finding every copy — and missing one would have produced answers that
 * quietly disagreed with the map.
 *
 * Kept as small named pieces rather than whole query builders: the queries stay
 * readable as SQL, which matters more here than saving a line.
 */

/**
 * Bounding box as a geography, from placeholders $1-$4.
 *
 * Fixed positions rather than a configurable offset: every caller passes the
 * bbox first, and a parameter nothing ever varies is just a way to get it
 * wrong later.
 */
export const bboxEnvelope = () => `st_makeenvelope($1, $2, $3, $4, 4326)::geography`;

export const lat = (t: string) => `st_y(${t}.geom::geometry)`;
export const lon = (t: string) => `st_x(${t}.geom::geometry)`;

/** Stations may arrive unnamed; fall back to something a human can quote. */
export const stationName = (t: string) => `coalesce(${t}.name, 'Station ' || ${t}.id)`;

/** Reference-grade instrument vs low-cost sensor. Absent means low-cost. */
export const isMonitor = (t: string) =>
  `coalesce((${t}.metadata->>'isMonitor')::boolean, false)`;

/** Fire radiative power in MW. Absent is treated as zero, never null. */
export const frp = (t: string) => `coalesce((${t}.attrs->>'frp')::float, 0)`;

/** One decimal place — the precision these instruments actually justify. */
export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** ~11 m, far finer than a 375 m VIIRS pixel; free payload savings. */
export function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}
