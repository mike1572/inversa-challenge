# Smoke & Breath

**Which fires are driving the air people are breathing, and where is the smoke headed?**

A natural-language interface over four live feeds, covering North America with a
rolling 7-day hourly archive. Ask a question, get a grounded answer, and click any
number in it to see the exact provider response it came from.

> **Live demo:** _not yet deployed — see [Running it](#running-it) to bring it up locally._

---

## Why this question

Smoke is the clearest everyday case where an invisible physical process crosses
hundreds of kilometres and lands in someone's lungs. The three primary feeds are three
links of one causal chain:

| Link | Feed | What it gives | Key | Coverage |
|---|---|---|---|---|
| **Ignition** | NASA FIRMS (VIIRS) | satellite heat detections | free, email only | Global · ~3h latency |
| **Transport** | Open-Meteo | wind direction + speed, 3° grid | none | Global |
| **Exposure** | OpenAQ v3 | ground PM2.5 monitors | free registration | Global · density varies |
| *Official signal* | NOAA / NWS | air-quality + red-flag alerts | none | **US territory only** |

That coupling is what gives the agent something to reason about and the timeline
something real to replay: a detection at T produces a PM2.5 spike downwind at T+hours.

**The causal claim is measured, not assumed.** `npm run verify:upwind` compares fire
radiative power in the upwind vs. downwind sector at the 300 most polluted
station-hours in the archive:

```
upwind   : 4003 detections,     55948 MW total FRP
downwind : 2235 detections,     12067 MW total FRP
ratio    : 4.64x
```

Wind direction is the direction wind blows *from*, so fires affecting a station lie
along the reported bearing with no 180° flip. Inverting that would make every answer
confidently wrong with nothing visibly amiss — hence a test rather than a comment.

---

## What to try

1. **Scrub the timeline.** Press space, or drag. Detections arrive in bursts because
   VIIRS is polar-orbiting and passes roughly twice daily — real, not a gap.
2. **"Why is the air bad in Bend, Oregon right now?"** It will tell you the air *isn't*
   bad. It checks before agreeing with you.
3. **"Show me the worst air in North America this week."** It finds 412 µg/m³ and then
   refuses to call it hazardous air, because that reading is one low-cost sensor with
   no other monitor inside 20 km to corroborate it.
4. **"Are there any alerts in Vancouver?"** Answers *"no coverage there"*, not *"no
   alerts"* — and separately notes the US side just south genuinely has none.
5. **Click any `[E1]` citation.** The tool call, its arguments, the rows returned, the
   provider URL and the fetch timestamp. API keys are redacted server-side.
6. **Watch the map when an answer lands.** It flies to the answer's bounding box,
   enables the layers the agent declared, and eases the time cursor to the moment in
   question. The agent is a UI controller, not a chat box beside a map.

---

## Architecture

```
  ┌─ FIRMS ──┐
  ├─ OpenAQ ─┤   source adapters      ┌───────────────────────────┐
  ├─ O-Meteo ┼──► lib/sources/* ──────► Supabase Postgres + PostGIS│
  └─ NWS ────┘         ▲              │  observations / events     │
                       │              │  raw_payloads / evidence   │
              lazy revalidation       └────────────┬──────────────-┘
              (waitUntil, on read)                 │
                                        lib/query/* (typed readers)
                                                   │
                  ┌────────────────────────────────┼──────────────────┐
            /api/window                   /api/ask (SSE)      /api/evidence/:id
                  │                               │                   │
                  │                      OpenAI Responses API         │
                  ▼                               ▼                   ▼
         ┌──────────────────────────────────────────────────────────────┐
         │  Next.js client — Zustand store                              │
         │  deck.gl map · timeline scrubber · agent panel + evidence    │
         └──────────────────────────────────────────────────────────────┘
```

**Adapters are pure fetch-and-normalize.** They never touch the database. Every write
goes through one path (`lib/ingest/run.ts`), so provenance linking, upsert semantics,
deduplication and error logging are written once rather than once per feed. Adding a
fifth feed is one file plus a registry line.

**`lib/query/*` owns all SQL.** Agent tools call the same readers the map does, so the
number the agent quotes and the dot you see on the map come from one code path and
cannot disagree.

**No cron.** Reads check each source's last success and schedule the missing window via
`waitUntil`, so the caller is served from the database immediately and never waits on a
provider. Gaps self-heal because the providers expose historical endpoints. An
`ingest_locks` lease table guards against stampedes — deliberately *not*
`pg_try_advisory_lock`, which belongs to a connection and would be orphaned by
Supabase's transaction pooler between statements.

**The agent gets narrow typed tools, never free-form SQL.** Nine of them. This bounds
the failure surface: a hallucinated argument yields an empty result, not a wrong
number. Every tool call is persisted as evidence *before* the model sees the result,
and its label is handed back inside the payload — that is what makes `[E1]` in the
prose resolve to a real row rather than an invented citation.

**The timeline never touches the network while scrubbing.** `/api/window` returns the
whole visible window once; deck.gl then filters by time inside a layer accessor,
against buffers already uploaded to the GPU, rather than re-slicing arrays and
rebuilding layers. That one choice is what keeps scrubbing smooth across thousands of
stations.

---

## Data quality is a feature here, not an afterthought

- **`observed_at` vs `ingested_at`** on every row — the split that makes honest
  staleness reporting possible at all.
- **Coverage is not absence.** NWS stops at the border. A CONUS *rectangle* puts
  Vancouver (49.28°N) and Windsor inside "US coverage", so the boundary is the real
  national polygon; `npm run coverage` installs it and asserts 8 border cases including
  Detroit vs. Windsor, about 2 km apart. "I have no coverage there" and "there are no
  alerts" are different claims, and both the map mask and the agent keep them apart.
- **Conflicting sensors.** Reference monitors and low-cost sensors within 2 km
  regularly disagree; both values are surfaced rather than averaged or silently picked.
  363 such pairs in the current window.
- **Uncorroborated extremes.** Distinct from a conflict, and more dangerous: one sensor
  claiming something alarming with nothing nearby to check it against. The highest
  reading in this archive — 412 µg/m³, "Hazardous" — is exactly that, with no neighbour
  inside 20 km. Reported naively it reads as a public-health emergency.
- **Silence is counted, not hidden.** Monitors that reported nothing all week are
  dropped from the payload and reported as a number, rather than drawn as thousands of
  meaningless grey rings.

---

## Running it

Needs Node 20+, a Supabase project, and a few free keys.

```bash
cp .env.example .env.local        # then fill it in; the comments explain each value
npm install
npm run migrate                   # schema, PostGIS, seeds
npm run coverage                  # install the US boundary, asserts border cases
npm run backfill                  # FIRMS, NWS, Open-Meteo, OpenAQ discovery
npm run backfill openaq-history   # tier-A PM2.5 history, ~6 min
npm run health                    # feed freshness, row counts, conflicts found
npm run dev
```

Keys: [FIRMS](https://firms.modaps.eosdis.nasa.gov/api/map_key/) (email only),
[OpenAQ](https://explore.openaq.org/register), an OpenAI key, and a Supabase project.
Open-Meteo and NWS need none. Everything except OpenAI is free.

**`DATABASE_URL` must be the pooled Transaction URI on port 6543.** The direct
`db.<ref>.supabase.co:5432` host is IPv6-only on current projects and will not resolve
from most machines, or from Vercel's builders.

### Why the OpenAQ backfill is tiered

OpenAQ's historical API is *sensor-scoped* — there is no "everything in this bbox last
week" endpoint — so 7 days of history costs one request per sensor against a 60/min
limit. Backfilling all ~6,300 regional sensors would take ~40 minutes. Instead ~300 get
full history and the rest get the live edge from a single bulk call, bringing it under
10 minutes. `history_tier` records which is which, but series length is judged from the
points actually present, since the tier records *selection* for backfill, not
completion.

---

## If this needed to scale

- Partition `observations` by day; move to ClickHouse or Timescale once wide
  time-range scans dominate.
- Lazy revalidation stops paying off once traffic is continuous or the region goes
  global — ingestion then becomes a queue with durable workflows (Inngest, Temporal)
  for retries and backfills.
- Precompute window payloads to object storage behind a CDN; cache agent tool results
  by `(tool, args, time-bucket)`.
- H3 spatial indexing when the upwind join gets expensive; multi-region when the bbox
  does.

## Known limitations

- **NWS alert history cannot be backfilled.** `/alerts/active` returns only what is
  active now, so alert history accumulates only while the app is in use. Disclosed in
  the UI rather than papered over.
- Only about 10% of NWS alerts carry an inline polygon; the rest are resolved from
  cached zone geometry, and an alert whose zones fail to resolve is counted as unplaced
  rather than silently dropped.
- FIRMS uses VIIRS S-NPP only. Adding NOAA-20/21 would roughly triple detection density.
- The agent has a bounded research budget. A question too broad to answer within it
  returns a partial answer with the gap stated in caveats, not an error.
- Payload is ~1.5 MB uncompressed for a continental 7-day window; `next start` does not
  compress it, though Vercel's edge does.

---

`AGENTS.md` is generated by `next dev` and committed deliberately — see the note inside
it. `npm run typecheck` and `npm run lint` are both clean.
