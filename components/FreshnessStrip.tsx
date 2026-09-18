"use client";

import { useState } from "react";
import { AQI_BANDS } from "@/lib/aqi";
import { useStore, type LayerKey } from "@/lib/store";

/**
 * Legend and controls, as one thing.
 *
 * These used to be two adjacent clusters that looked alike and did different
 * jobs: raw source ids (firms, nws, open_meteo, openaq) showing feed health,
 * beside layer toggles (Fires, PM2.5, Wind, Alerts). Nobody could tell which
 * was which, the ids meant nothing to a reader, and the colours on the map had
 * no key at all.
 *
 * Each layer happens to be fed by exactly one source, so a single row now
 * carries all of it: what the colour means, what the layer is, where it comes
 * from and how stale it is. Clicking the row toggles the layer.
 */

interface LayerSpec {
  key: LayerKey;
  label: string;
  what: string;
  sourceId: string;
  /** null for PM2.5, which the scale underneath explains instead. */
  swatch: string | null;
  caveat?: string;
}

const LAYERS: LayerSpec[] = [
  {
    key: "fires",
    label: "Fires",
    what: "satellite heat detections",
    sourceId: "firms",
    swatch: "#b8420f",
    caveat: "~3h satellite lag",
  },
  { key: "pm25", label: "PM2.5", what: "ground air monitors", sourceId: "openaq", swatch: null },
  {
    key: "wind",
    label: "Wind",
    what: "where smoke is heading",
    sourceId: "open_meteo",
    swatch: "#2563eb",
  },
  {
    key: "alerts",
    label: "Alerts",
    what: "official warnings",
    sourceId: "nws",
    swatch: "#d97706",
    caveat: "US only",
  },
];

const SOURCE_NAMES: Record<string, string> = {
  firms: "NASA FIRMS",
  openaq: "OpenAQ",
  open_meteo: "Open-Meteo",
  nws: "NOAA / NWS",
};

const DOT: Record<string, string> = {
  fresh: "bg-emerald-600",
  stale: "bg-amber-500",
  down: "bg-red-600",
  never: "bg-ink-3",
};

function ago(lagSec: number | null): string {
  if (lagSec === null) return "never";
  if (lagSec < 90) return "just now";
  if (lagSec < 5400) return `${Math.round(lagSec / 60)}m ago`;
  if (lagSec < 172_800) return `${Math.round(lagSec / 3600)}h ago`;
  return `${Math.round(lagSec / 86_400)}d ago`;
}

export default function FreshnessStrip() {
  const data = useStore((s) => s.data);
  const loading = useStore((s) => s.loading);
  const layers = useStore((s) => s.layers);
  const toggleLayer = useStore((s) => s.toggleLayer);
  const [open, setOpen] = useState(true);
  const [hovered, setHovered] = useState<LayerKey | null>(null);

  const sources = data?.meta.sources ?? [];
  const byId = new Map(sources.map((s) => [s.id, s]));
  const degraded = sources.filter((s) => s.status === "down" || s.status === "never");

  const hint = (() => {
    const l = LAYERS.find((x) => x.key === hovered);
    if (!l) return "The dot shows how recently each feed updated.";
    const src = byId.get(l.sourceId);
    return (
      `${SOURCE_NAMES[l.sourceId] ?? l.sourceId} · updated ${ago(src?.lagSec ?? null)}` +
      (l.caveat ? ` · ${l.caveat}` : "")
    );
  })();

  return (
    <div className="pointer-events-none absolute top-0 left-0 z-10 p-2.5">
      <div className="chip pointer-events-auto w-[272px] overflow-hidden rounded-lg shadow-sm">
        <button
          onClick={() => setOpen((v) => !v)}
          className="hover:bg-hover flex w-full items-start justify-between gap-2 px-2.5 py-2 text-left transition-colors"
        >
          <span>
            <span className="text-ink block text-[12.5px] leading-tight font-semibold tracking-tight">
              Smoke &amp; Breath
            </span>
            <span className="text-ink-3 block text-[10px] leading-tight">
              fires → wind → the air you breathe
            </span>
          </span>
          <span className="flex items-center gap-1.5 pt-0.5">
            {loading && (
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-sky-600" />
            )}
            <span className="text-ink-3 text-[10px]">{open ? "▾" : "▸"}</span>
          </span>
        </button>

        {open && (
          <>
            <div className="border-line-soft border-t px-2.5 pt-2 pb-1.5">
              <div className="mb-1.5 flex items-baseline gap-1.5">
                <span className="label">Layers</span>
                <span className="text-ink-3 text-[9.5px]">click to show or hide</span>
              </div>

              <div className="space-y-0.5">
                {LAYERS.map((l) => {
                  const src = byId.get(l.sourceId);
                  const on = layers[l.key];
                  return (
                    <button
                      key={l.key}
                      onClick={() => toggleLayer(l.key)}
                      onMouseEnter={() => setHovered(l.key)}
                      onMouseLeave={() => setHovered(null)}
                      className={`hover:bg-hover flex w-full items-center gap-2 rounded px-1 py-1 text-left transition-colors ${
                        on ? "" : "opacity-40"
                      }`}
                    >
                      {/* The swatch IS the colour used on the map, so the row
                          doubles as the key rather than needing a separate one. */}
                      {l.swatch ? (
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: l.swatch }}
                        />
                      ) : (
                        <span className="flex h-2.5 w-2.5 shrink-0 overflow-hidden rounded-full">
                          {AQI_BANDS.slice(0, 4).map((b) => (
                            <span
                              key={b.css}
                              className="h-full flex-1"
                              style={{ backgroundColor: b.css }}
                            />
                          ))}
                        </span>
                      )}

                      <span className="min-w-0 flex-1">
                        <span className="text-ink text-[11.5px] font-medium">{l.label}</span>
                        <span className="text-ink-3 ml-1.5 text-[10px]">{l.what}</span>
                      </span>

                      <span
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[src?.status ?? "never"]}`}
                      />
                    </button>
                  );
                })}
              </div>

              {/* One fixed-height line, so the panel does not jump as the
                  cursor moves down the list. */}
              <div className="text-ink-3 mt-1 min-h-[14px] px-1 text-[10px] leading-tight">
                {hint}
              </div>
            </div>

            <div className="border-line-soft border-t px-2.5 py-2">
              {/* The unit stays outside .label: that class uppercases, and
                  uppercasing µ yields Μ (capital Mu), a different symbol. */}
              <div className="mb-1.5 flex items-baseline gap-1.5">
                <span className="label">Air quality</span>
                <span className="tnum text-ink-3 text-[9.5px]">PM2.5 µg/m³</span>
              </div>
              <div className="flex h-2.5 overflow-hidden rounded-sm">
                {AQI_BANDS.map((b) => (
                  <div
                    key={b.css}
                    className="flex-1"
                    style={{ backgroundColor: b.css }}
                    title={b.label}
                  />
                ))}
              </div>
              <div className="tnum text-ink-3 mt-1 flex justify-between text-[9px]">
                <span>0</span>
                <span>12</span>
                <span>35</span>
                <span>55</span>
                <span>150</span>
                <span>250+</span>
              </div>
              <div className="text-ink-3 flex justify-between text-[9.5px]">
                <span>good</span>
                <span>hazardous</span>
              </div>
              <div className="text-ink-3 mt-1.5 text-[9.5px] leading-snug">
                Hollow ring = monitor with no reading this hour.
              </div>
            </div>
          </>
        )}
      </div>

      {(data?.meta.firesTruncated || (data?.meta.silentStations ?? 0) > 0) && (
        <div className="pointer-events-auto mt-2 w-[272px] rounded-lg border border-amber-300 bg-amber-50/95 px-2.5 py-1.5 text-[10px] leading-snug text-amber-900 backdrop-blur">
          {data?.meta.firesTruncated && (
            <div>Showing the most intense detections — zoom in for all.</div>
          )}
          {(data?.meta.silentStations ?? 0) > 0 && (
            <div>
              {data!.meta.silentStations.toLocaleString()} monitors here reported nothing this
              week and are not drawn.
            </div>
          )}
        </div>
      )}

      {degraded.length > 0 && (
        <div className="pointer-events-auto mt-2 w-[272px] rounded-lg border border-red-300 bg-red-50/95 px-2.5 py-1.5 text-[10.5px] leading-snug text-red-800 backdrop-blur">
          {degraded.map((s) => s.name).join(", ")} {degraded.length === 1 ? "is" : "are"} not
          reporting. Everything else still works; that layer is incomplete.
        </div>
      )}
    </div>
  );
}
