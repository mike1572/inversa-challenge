/**
 * Assertions for the pure helpers whose rules are easy to break silently.
 *
 *   npm run check
 *
 * Deliberately tiny and dependency-free: these two functions carry real logic
 * that no type checks — a JSON escape split across network chunks, and how long
 * a stale reading may keep showing — and both would fail quietly rather than
 * loudly if they regressed.
 */

import assert from "node:assert/strict";
import { partialProse } from "../lib/partial-json";
import { buildPmGrid, CARRY_HOURS } from "../lib/pm-grid";
import type { WindowPayload } from "../lib/query/window";

let checks = 0;
function check(name: string, fn: () => void): void {
  fn();
  checks++;
  console.log("  ok  " + name);
}

// ── partialProse: reads a JSON envelope that is not valid JSON yet ──────────
const envelope = (prose: string) => JSON.stringify({ prose, claims: [] });

check("returns nothing before the key arrives", () => {
  assert.equal(partialProse('{"pro'), "");
  assert.equal(partialProse('{"prose":"'), "");
});

check("reads prose while the envelope is still open", () => {
  const full = envelope("Bend is fine");
  assert.equal(partialProse(full.slice(0, 20)), "Bend is fi");
  assert.equal(partialProse(full), "Bend is fine");
});

check("decodes escapes, including multi-byte units", () => {
  assert.equal(partialProse(envelope("3.8 µg/m³")), "3.8 µg/m³");
  assert.equal(partialProse(envelope("a\nb")), "a\nb");
  assert.equal(partialProse(envelope('say "hi"')), 'say "hi"');
});

check("emits no garbage at any truncation point", () => {
  const full = envelope("µ here\nand \"there\"");
  for (let n = 1; n <= full.length; n++) {
    const out = partialProse(full.slice(0, n));
    assert.ok(!/\\u|\\n|�/.test(out), `garbage at ${n}: ${JSON.stringify(out)}`);
  }
});

// ── buildPmGrid: how long a reading keeps showing, and in which direction ───
function payload(hours: number, readings: [number, number][]): WindowPayload {
  return {
    meta: { hours },
    stations: { id: [1] },
    pm25: {
      station: readings.map(() => 0),
      hour: readings.map((r) => r[0]),
      value: readings.map((r) => r[1]),
    },
  } as unknown as WindowPayload;
}

const values = (g: Float32Array | null) =>
  [...(g ?? [])].map((v) => (Number.isNaN(v) ? null : v));

check(`carries a reading forward exactly ${CARRY_HOURS} hours`, () => {
  const { grid, age } = buildPmGrid(payload(8, [[2, 10]]));
  assert.deepEqual(values(grid), [null, null, 10, 10, 10, 10, null, null]);
  assert.deepEqual([...(age ?? [])], [255, 255, 0, 1, 2, 3, 255, 255]);
});

check("never carries backward, before the station first reported", () => {
  const { grid } = buildPmGrid(payload(4, [[3, 7]]));
  assert.deepEqual(values(grid), [null, null, null, 7]);
});

check("a fresh reading resets the carry window and the age", () => {
  const { grid, age } = buildPmGrid(payload(7, [[0, 1], [2, 5]]));
  assert.deepEqual(values(grid), [1, 1, 5, 5, 5, 5, null]);
  assert.deepEqual([...(age ?? [])], [0, 1, 0, 1, 2, 3, 255]);
});

check("an absent payload is safe", () => {
  assert.deepEqual(buildPmGrid(null), { grid: null, age: null });
});

console.log(`\n${checks} checks passed\n`);
