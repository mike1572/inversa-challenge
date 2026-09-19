import type { WindowPayload } from "./query/window";

/** How long a PM2.5 reading stays on screen before the station goes hollow. */
export const CARRY_HOURS = 3;

export interface PmGrid {
  /** Station-major values, NaN where nothing is known. */
  grid: Float32Array | null;
  /** Hours since the reading was actually taken; 255 means no value. */
  age: Uint8Array | null;
}

/**
 * Dense station-by-hour lookup, built once per payload.
 *
 * The payload is sparse triples; scanning them per frame would be O(n) at
 * 60fps. A station-major Float32Array makes the map's colour accessor an O(1)
 * index, which is what keeps scrubbing smooth with thousands of stations.
 *
 * Values are carried FORWARD up to CARRY_HOURS, because stations report hourly
 * and arrive minutes late: requiring an exact hour match leaves most of the map
 * blank at any instant (measured: 0% of stations had a value at the newest
 * hour, 64% one hour back). A reading from an hour ago is still that station's
 * current measurement, so this shows what is known rather than inventing
 * anything — nothing is ever carried BACKWARD to before a station first
 * reported, and `age` travels alongside so the UI can dim a stale value and the
 * tooltip can name the real observation time.
 *
 * Lives here rather than in the map component because it is a pure data
 * transform with rules worth testing on their own.
 */
export function buildPmGrid(data: WindowPayload | null): PmGrid {
  if (!data) return { grid: null, age: null };

  const { hours } = data.meta;
  const n = data.stations.id.length;

  const grid = new Float32Array(n * hours).fill(NaN);
  for (let i = 0; i < data.pm25.station.length; i++) {
    grid[data.pm25.station[i] * hours + data.pm25.hour[i]] = data.pm25.value[i];
  }

  const age = new Uint8Array(n * hours).fill(255);
  for (let s = 0; s < n; s++) {
    const base = s * hours;
    let carried = NaN;
    let carriedAge = 0;

    for (let h = 0; h < hours; h++) {
      const v = grid[base + h];
      if (!Number.isNaN(v)) {
        carried = v;
        carriedAge = 0;
      } else if (!Number.isNaN(carried) && carriedAge < CARRY_HOURS) {
        carriedAge++;
        grid[base + h] = carried;
      } else {
        carried = NaN;
        continue;
      }
      age[base + h] = carriedAge;
    }
  }

  return { grid, age };
}
