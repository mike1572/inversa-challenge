/**
 * EPA PM2.5 AQI breakpoints.
 *
 * Using the standard scale rather than inventing a palette: this is the colour
 * language the audience already reads, so the map is legible without a legend
 * lookup. (24-hour breakpoints applied to hourly values — the usual dashboard
 * simplification, and what matters here is the category boundary, not a legally
 * exact AQI.)
 */

export interface AqiBand {
  max: number;
  label: string;
  /** RGB, for deck.gl accessors. */
  rgb: [number, number, number];
  css: string;
}

/**
 * Tuned for a LIGHT basemap.
 *
 * The EPA's published swatches assume white paper, but their "Good" green and
 * "Moderate" yellow are near-invisible against a pale grey map, so each band is
 * darkened and desaturated just enough to hold its edge while staying
 * recognisably the standard scale.
 */
export const AQI_BANDS: AqiBand[] = [
  { max: 12.0, label: "Good", rgb: [22, 146, 91], css: "#16925b" },
  { max: 35.4, label: "Moderate", rgb: [201, 153, 0], css: "#c99900" },
  { max: 55.4, label: "Unhealthy for sensitive groups", rgb: [214, 100, 14], css: "#d6640e" },
  { max: 150.4, label: "Unhealthy", rgb: [201, 42, 42], css: "#c92a2a" },
  { max: 250.4, label: "Very unhealthy", rgb: [133, 58, 168], css: "#853aa8" },
  { max: Infinity, label: "Hazardous", rgb: [124, 29, 46], css: "#7c1d2e" },
];

export function aqiBand(pm25: number | null | undefined): AqiBand {
  if (pm25 === null || pm25 === undefined || !Number.isFinite(pm25)) {
    return { max: 0, label: "No data", rgb: [142, 150, 162], css: "#8e96a2" };
  }
  return AQI_BANDS.find((b) => pm25 <= b.max) ?? AQI_BANDS[AQI_BANDS.length - 1];
}

/**
 * Fire colour ramp: orange at low intensity deepening to dark red.
 *
 * Inverted from the dark-map version, which ran toward white — on a light
 * basemap the most intense fires must be the DARKEST marks, or the biggest
 * fires would be the hardest ones to see.
 */
export function fireColor(frp: number): [number, number, number] {
  const t = Math.min(1, Math.log10(Math.max(frp, 1) + 1) / 2.2);
  return [
    Math.round(240 - t * 90),
    Math.round(120 - t * 92),
    Math.round(30 - t * 12),
  ];
}

export function fireRadius(frp: number): number {
  return 600 + Math.sqrt(Math.max(frp, 0)) * 900;
}
