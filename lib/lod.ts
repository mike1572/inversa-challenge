import type { BBox } from "./config";

/**
 * Level of detail.
 *
 * Pure — no database import — so the client can decide whether a zoom change
 * warrants a refetch without dragging `pg` into the browser bundle. The server
 * uses the same function to pick the caps, so the two can never drift.
 */

export type DetailLevel = "continental" | "regional" | "local";

const CONTINENTAL_AT = 15;
const REGIONAL_AT = 3;
/** Crossing back costs 15% more travel than crossing forward. */
const HYSTERESIS = 0.15;

export function spanOf(b: BBox): number {
  return Math.max(Math.abs(b[2] - b[0]), Math.abs(b[3] - b[1]));
}

/** Value equality for bounding boxes. */
export function sameBBox(a: BBox | null | undefined, b: BBox | null | undefined): boolean {
  if (!a || !b) return false;
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

/** True if `inner` lies entirely within `outer`. */
export function containsBBox(outer: BBox, inner: BBox): boolean {
  return (
    outer[0] <= inner[0] &&
    outer[1] <= inner[1] &&
    outer[2] >= inner[2] &&
    outer[3] >= inner[3]
  );
}

/**
 * Grow a bbox by a fraction of its own size.
 *
 * Requests are padded so that small pans and zooms stay inside what we already
 * hold. Without the margin, the viewport leaves the fetched box almost
 * immediately and every nudge becomes a round trip.
 */
export function padBBox(b: BBox, fraction = 0.4): BBox {
  const dx = (b[2] - b[0]) * fraction;
  const dy = (b[3] - b[1]) * fraction;
  return clampBBox([b[0] - dx, b[1] - dy, b[2] + dx, b[3] + dy]);
}

/**
 * Force a bbox into coordinates PostGIS will accept.
 *
 * Zoomed fully out, the viewport maths produces latitudes past ±90 and a
 * longitude span approaching 360°. Postgres rejects the first outright and
 * treats the second as an antipodal edge, so an unclamped box turns a harmless
 * zoom-out into a 500. Clamped slightly inside the limits because a geography
 * edge sitting exactly on the antimeridian is itself ambiguous.
 */
export function clampBBox(b: BBox): BBox {
  const lon = (v: number) => Math.max(-179.9, Math.min(179.9, v));
  const lat = (v: number) => Math.max(-85, Math.min(85, v));

  let [w, s, e, n] = [lon(b[0]), lat(b[1]), lon(b[2]), lat(b[3])];
  if (w > e) [w, e] = [e, w];
  if (s > n) [s, n] = [n, s];

  // A degenerate box matches nothing and reads as "no data" rather than as the
  // zoom artefact it is; give it a minimum extent instead.
  if (e - w < 0.01) e = w + 0.01;
  if (n - s < 0.01) n = s + 0.01;

  return [w, s, e, n];
}

export function detailLevelFor(b: BBox): DetailLevel {
  const span = spanOf(b);
  if (span > CONTINENTAL_AT) return "continental";
  if (span > REGIONAL_AT) return "regional";
  return "local";
}

/**
 * Detail level with hysteresis, for deciding whether a zoom warrants a refetch.
 *
 * A bare threshold thrashes: nudging the wheel around a boundary flips
 * local↔regional on every frame, and each flip was firing a full window
 * request. Widening the band in whichever direction we came from means the user
 * has to genuinely commit to a zoom level before we go back to the server.
 */
export function levelForRefetch(b: BBox, current: DetailLevel): DetailLevel {
  const span = spanOf(b);

  const upper = current === "continental" ? CONTINENTAL_AT * (1 - HYSTERESIS) : CONTINENTAL_AT * (1 + HYSTERESIS);
  const lower = current === "local" ? REGIONAL_AT * (1 + HYSTERESIS) : REGIONAL_AT * (1 - HYSTERESIS);

  if (span > upper) return "continental";
  if (span > lower) return "regional";
  return "local";
}

/** Fire caps per tier. `continentalCap` comes from config so it stays tunable. */
export function fireLimitsFor(
  level: DetailLevel,
  continentalCap: number,
): { cap: number; minFrp: number } {
  if (level === "continental") return { cap: continentalCap, minFrp: 1 };
  if (level === "regional") return { cap: 20_000, minFrp: 0 };
  return { cap: 50_000, minFrp: 0 };
}
