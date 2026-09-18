/**
 * Install the real US national boundary as the NWS coverage polygon.
 *
 *   npm run coverage
 *
 * Why this is not a bounding box: a CONUS rectangle reaches 49.5°N, which puts
 * Vancouver BC (49.28°N) inside "US coverage", and no latitude cutoff can
 * separate Michigan from Ontario. The border is the only place this test
 * matters, so an approximation that is wrong exactly at the border is worse
 * than useless — it converts "I have no data there" into a confident "there are
 * no alerts there".
 *
 * Boundary is Natural Earth 1:50m admin-0 (public domain), simplified to ~0.02°
 * (about 2 km) which is far finer than any alert polygon.
 */

import "./env";
import { pool } from "../lib/db";

const SOURCE =
  "https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_50m_admin_0_countries.geojson";

const SIMPLIFY_DEGREES = 0.02;

interface Feature {
  properties?: Record<string, string>;
  geometry: { type: string; coordinates: unknown[] };
}

async function main(): Promise<void> {
  process.stdout.write("fetching Natural Earth admin-0 … ");
  const res = await fetch(SOURCE, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from Natural Earth`);
  const json = (await res.json()) as { features: Feature[] };
  console.log("ok");

  const usa = json.features.find((f) => {
    const p = f.properties ?? {};
    return (
      p.ISO_A3 === "USA" ||
      p.iso_a3 === "USA" ||
      ["United States of America", "United States"].includes(p.ADMIN ?? p.admin ?? "")
    );
  });
  if (!usa) throw new Error("No USA feature found in the boundary dataset");

  console.log(`geometry: ${usa.geometry.type}, ${usa.geometry.coordinates.length} parts`);

  // ST_Simplify keeps the file small without moving the border meaningfully.
  // ST_MakeValid guards against the self-intersections simplification can
  // introduce on complex coastlines.
  const { rows } = await pool.query(
    `update sources
        set coverage_geom = st_makevalid(
              st_simplify(st_geomfromgeojson($1)::geometry, $2)
            )::geography,
            coverage_note = $3
      where id = 'nws'
      returning st_npoints(coverage_geom::geometry) as points`,
    [
      JSON.stringify(usa.geometry),
      SIMPLIFY_DEGREES,
      "NWS issues alerts for US territory only. Areas outside it have no alert coverage — " +
        "this is not the same as having no alerts.",
    ],
  );

  console.log(`stored boundary with ${rows[0].points} vertices`);

  // Prove it separates the border, which a bounding box cannot.
  const checks: [string, number, number, boolean][] = [
    ["Seattle, WA", 47.61, -122.33, true],
    ["Bellingham, WA", 48.75, -122.48, true],
    ["Vancouver, BC", 49.28, -123.12, false],
    ["Detroit, MI", 42.33, -83.05, true],
    ["Windsor, ON", 42.31, -83.04, false],
    ["Toronto, ON", 43.65, -79.38, false],
    ["Montreal, QC", 45.50, -73.57, false],
    ["Anchorage, AK", 61.22, -149.90, true],
  ];

  console.log("\nborder test:");
  let failed = 0;
  for (const [name, lat, lon, expected] of checks) {
    const r = await pool.query<{ covered: boolean }>(
      `select st_intersects(coverage_geom, st_makepoint($1, $2)::geography) as covered
         from sources where id = 'nws'`,
      [lon, lat],
    );
    const covered = r.rows[0].covered;
    const ok = covered === expected;
    if (!ok) failed++;
    console.log(
      `  ${ok ? "✓" : "✗"} ${name.padEnd(16)} covered=${String(covered).padEnd(5)} expected=${expected}`,
    );
  }

  console.log(failed === 0 ? "\nall border checks passed\n" : `\n${failed} CHECKS FAILED\n`);
  if (failed > 0) process.exitCode = 1;
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
