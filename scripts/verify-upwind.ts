/**
 * Validate the upwind bearing semantics against real data.
 *
 *   npm run verify:upwind
 *
 * Why this exists: wind_direction_10m is the direction wind blows FROM, so
 * fires affecting a station lie ALONG that bearing with no 180° flip. Invert it
 * and every answer is confidently, invisibly wrong — the query still returns
 * fires, the map still renders, nothing looks broken.
 *
 * The test: for the most polluted station-hours in the archive, compare total
 * fire radiative power in the upwind sector against the downwind sector. If the
 * semantics are right, smoke-affected stations should have materially more fire
 * upwind than downwind. If the two are equal, the wind carries no signal; if
 * downwind dominates, the sign is flipped.
 */

import "./env";
import { pool, sql } from "../lib/db";

const SECTOR_DEG = 60;
const MAX_KM = 400;
const SAMPLE = 300;
const PM25_THRESHOLD = 35; // above "Moderate" on the EPA scale

interface Row {
  n: string;
  upwind_frp: string | null;
  downwind_frp: string | null;
  upwind_hits: string;
  downwind_hits: string;
}

async function main(): Promise<void> {
  const rows = await sql<Row>(
    `with hot as (
       select o.station_id, o.observed_at, o.value
         from observations o
        where o.param = 'pm25' and o.value > $1
        order by o.value desc
        limit $2
     ),
     with_wind as (
       select h.station_id, h.observed_at, s.geom as sgeom, w.from_dir
         from hot h
         join stations s on s.id = h.station_id
         cross join lateral (
            select d.value as from_dir
              from observations d
              join stations g on g.id = d.station_id and g.source_id = 'open_meteo'
             where d.param = 'wind_direction_10m'
               and d.observed_at = date_trunc('hour', h.observed_at)
             order by g.geom <-> s.geom
             limit 1
         ) w
     ),
     paired as (
       select ww.from_dir,
              coalesce((e.attrs->>'frp')::float, 0) as frp,
              degrees(st_azimuth(ww.sgeom::geometry, e.geom::geometry)) as bearing
         from with_wind ww
         join events e
           on e.kind = 'fire_detection'
          and st_dwithin(e.geom, ww.sgeom, $3)
     )
     select count(*)::text as n,
            sum(case when abs(((bearing - from_dir + 540)::numeric % 360) - 180) < $4
                     then frp else 0 end)::text as upwind_frp,
            sum(case when abs(((bearing - from_dir + 360)::numeric % 360) - 180) < $4
                     then frp else 0 end)::text as downwind_frp,
            count(*) filter (where abs(((bearing - from_dir + 540)::numeric % 360) - 180) < $4)::text
              as upwind_hits,
            count(*) filter (where abs(((bearing - from_dir + 360)::numeric % 360) - 180) < $4)::text
              as downwind_hits
       from paired`,
    [PM25_THRESHOLD, SAMPLE, MAX_KM * 1000, SECTOR_DEG / 2],
  );

  const r = rows[0];
  const up = Number(r.upwind_frp ?? 0);
  const down = Number(r.downwind_frp ?? 0);
  const upHits = Number(r.upwind_hits);
  const downHits = Number(r.downwind_hits);

  console.log(`\nSample: worst ${SAMPLE} station-hours above ${PM25_THRESHOLD} µg/m³`);
  console.log(`Fires within ${MAX_KM} km considered: ${r.n}`);
  console.log(`Sector: ${SECTOR_DEG}°\n`);
  console.log(`  upwind   : ${upHits.toString().padStart(6)} detections, ${up.toFixed(0).padStart(9)} MW total FRP`);
  console.log(`  downwind : ${downHits.toString().padStart(6)} detections, ${down.toFixed(0).padStart(9)} MW total FRP`);

  if (up === 0 && down === 0) {
    console.log("\n? INCONCLUSIVE — no fires near the polluted stations in this window.");
  } else {
    const ratio = down === 0 ? Infinity : up / down;
    console.log(`\n  upwind / downwind FRP ratio: ${ratio.toFixed(2)}`);
    if (ratio > 1.15) {
      console.log("\n✓ PASS — more fire upwind than downwind, as physics requires.");
      console.log("  The bearing convention in lib/query/fires.ts is correct.");
    } else if (ratio < 0.87) {
      console.log("\n✗ FAIL — MORE FIRE DOWNWIND. The bearing is very likely inverted.");
      console.log("  Check the sector test in upwindFires().");
      process.exitCode = 1;
    } else {
      console.log("\n~ WEAK — the two sectors are close, so this window carries little signal.");
      console.log("  Not evidence of a bug, but not confirmation either.");
    }
  }

  console.log("");
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
