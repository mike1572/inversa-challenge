"use client";

import { useEffect, useMemo, useRef } from "react";
import { AQI_BANDS, aqiBand } from "@/lib/aqi";
import { hourToDate, useStore } from "@/lib/store";

/**
 * 168 hourly buckets over 7 days.
 *
 * The activity strip behind the scrubber is not decoration: without it a
 * reviewer drags the handle once, lands on a quiet stretch, sees nothing move
 * and concludes the feature is thin. Showing where the interesting hours are
 * turns a blind hunt into a directed one.
 */
export default function Timeline() {
  const data = useStore((s) => s.data);
  const cursorHour = useStore((s) => s.cursorHour);
  const setCursorHour = useStore((s) => s.setCursorHour);
  const playing = useStore((s) => s.playing);
  const togglePlay = useStore((s) => s.togglePlay);
  const startPlayback = useStore((s) => s.startPlayback);
  const setPlaying = useStore((s) => s.setPlaying);
  const speed = useStore((s) => s.speed);
  const setSpeed = useStore((s) => s.setSpeed);
  const stepCursor = useStore((s) => s.stepCursor);
  const viewBBox = useStore((s) => s.viewBBox);

  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const hours = data?.meta.hours ?? 1;

  /** Playback: advance a float accumulator, commit an integer at most once per frame. */
  useEffect(() => {
    if (!playing || !data) return;
    let raf = 0;
    let last = performance.now();
    let acc = cursorHour;

    const tick = (t: number) => {
      const dt = (t - last) / 1000;
      last = t;
      acc += dt * speed;
      if (acc >= hours - 1) {
        setCursorHour(hours - 1);
        setPlaying(false);
        return;
      }
      setCursorHour(acc);
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // cursorHour is intentionally excluded: including it would restart the
    // loop on every frame it sets.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, speed, hours, data, setCursorHour, setPlaying]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "ArrowLeft") { stepCursor(-1); e.preventDefault(); }
      if (e.key === "ArrowRight") { stepCursor(1); e.preventDefault(); }
      if (e.key === " ") { togglePlay(); e.preventDefault(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stepCursor, togglePlay]);

  const seek = (clientX: number) => {
    const el = trackRef.current;
    if (!el || !data) return;
    const rect = el.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    setCursorHour(frac * (hours - 1));
  };

  /**
   * Recompute the strip for what is actually on screen.
   *
   * The server scopes `activity` to the bbox it was ASKED for, which is padded
   * and often much larger than the viewport — and only refreshes when a zoom
   * crosses a detail tier. So panning or zooming within a tier left the strip
   * describing an area you were no longer looking at, while the legend claimed
   * "in view".
   *
   * Every station and fire coordinate is already in the payload, so this is a
   * single pass over data in memory: no request, and the strip tracks the map
   * continuously instead of in jumps.
   */
  const activity = useMemo(() => {
    if (!data) return { fires: [] as number[], maxPm25: [] as (number | null)[] };
    if (!viewBBox) return data.activity;

    const [w, s, e, n] = viewBBox;
    const { hours } = data.meta;

    const inView = (lon: number, lat: number) =>
      lon >= w && lon <= e && lat >= s && lat <= n;

    const fires = new Array<number>(hours).fill(0);
    for (let i = 0; i < data.fires.lat.length; i++) {
      if (!inView(data.fires.lon[i], data.fires.lat[i])) continue;
      const h = data.fires.hour[i];
      if (h >= 0 && h < hours) fires[h]++;
    }

    // Flag stations once, then walk the sparse readings.
    const visible = new Uint8Array(data.stations.id.length);
    for (let i = 0; i < visible.length; i++) {
      visible[i] = inView(data.stations.lon[i], data.stations.lat[i]) ? 1 : 0;
    }

    const maxPm25 = new Array<number | null>(hours).fill(null);
    for (let i = 0; i < data.pm25.value.length; i++) {
      if (!visible[data.pm25.station[i]]) continue;
      const h = data.pm25.hour[i];
      const v = data.pm25.value[i];
      if (h < 0 || h >= hours) continue;
      if (maxPm25[h] === null || v > (maxPm25[h] as number)) maxPm25[h] = v;
    }

    return { fires, maxPm25 };
  }, [data, viewBBox]);

  const maxFires = useMemo(
    () => Math.max(1, ...(activity.fires.length ? activity.fires : [0])),
    [activity],
  );

  const cursorDate = hourToDate(data, Math.round(cursorHour));
  const pct = hours > 1 ? (cursorHour / (hours - 1)) * 100 : 0;

  return (
    <div className="border-line-soft panel border-t px-3 py-2.5 select-none">
      <div className="flex items-center gap-3">
        <button
          onClick={togglePlay}
          className="bg-raised border-line text-ink hover:bg-hover grid h-8 w-8 shrink-0 place-items-center rounded-md border text-[11px] transition-colors"
          aria-label={playing ? "Pause" : "Play"}
        >
          {playing ? "❚❚" : "▶"}
        </button>

        <div className="tnum w-[122px] shrink-0 leading-tight">
          {cursorDate ? (
            <>
              <div className="text-ink text-[12.5px]">
                {cursorDate.toISOString().slice(0, 10)}
              </div>
              <div className="text-ink-3 text-[11px]">
                {cursorDate.toISOString().slice(11, 16)} UTC
              </div>
            </>
          ) : (
            <span className="text-ink-3">—</span>
          )}
        </div>

        {/* Track: activity strip, then the scrubber over it */}
        <div
          ref={trackRef}
          className="bg-raised border-line-soft relative h-12 flex-1 cursor-pointer overflow-hidden rounded-md border"
          onPointerDown={(e) => {
            dragging.current = true;
            e.currentTarget.setPointerCapture(e.pointerId);
            setPlaying(false);
            seek(e.clientX);
          }}
          onPointerMove={(e) => dragging.current && seek(e.clientX)}
          onPointerUp={(e) => {
            dragging.current = false;
            e.currentTarget.releasePointerCapture(e.pointerId);
          }}
        >
          {/*
            Two measures, two visual languages. They used to be stacked bars in
            the same column, which made it impossible to tell which height meant
            what. Now fires are bars in the upper band and air quality is a
            continuous colour ribbon along the bottom — one is read by height,
            the other by colour, so neither is mistaken for the other.
          */}
          <div className="absolute inset-x-0 top-0 bottom-[11px] flex items-end gap-px px-px">
            {activity.fires.map((count, h) => (
              <div
                key={h}
                className="flex-1"
                style={{
                  height: `${(count / maxFires) * 100}%`,
                  backgroundColor: "rgba(217,95,14,.92)",
                }}
              />
            ))}
          </div>

          {/*
            The ribbon shows the WORST reading each hour, not the mean.
            Averaged across a continent the mean sits between 3.8 and 7.7 µg/m³
            all week — a flat green line that hides the very events this tool
            exists to find. The per-hour maximum ranges from 11 to 412.
          */}
          <div className="border-line-soft absolute inset-x-0 bottom-0 flex h-[11px] border-t px-px">
            {activity.maxPm25.map((pm, h) => (
              <div
                key={h}
                className="flex-1"
                style={{
                  backgroundColor: pm === null ? "rgba(150,158,170,.20)" : aqiBand(pm).css,
                }}
                title={pm === null ? "no readings this hour" : `worst PM2.5 ${pm} µg/m³`}
              />
            ))}
          </div>

          <div
            className="pointer-events-none absolute top-0 h-full w-[2px] bg-ink shadow-[0_0_6px_rgba(18,23,31,.45)]"
            style={{ left: `${pct}%` }}
          />
        </div>

        {/*
          The selected speed is a filled dark pill, not a faint tint. It was
          bg-hover on bg-raised — about a 5% luminance step, which is invisible
          at this size, so clicking appeared to do nothing even though the
          playback rate was changing correctly.
        */}
        <div
          className="bg-raised border-line flex shrink-0 items-center gap-0.5 rounded-md border p-0.5"
          title="Playback speed — simulated hours per second"
        >
          {[3, 6, 18].map((s) => (
            <button
              key={s}
              onClick={() => {
                setSpeed(s);
                // Picking a speed starts the replay. Otherwise the control does
                // nothing at all unless playback happens to be running already,
                // which is exactly how it read: dead.
                if (!playing) startPlayback();
              }}
              aria-pressed={speed === s}
              title={`Replay at ${s} hours per second`}
              className={`tnum rounded px-2 py-1 text-[10px] transition-colors ${
                speed === s
                  ? "bg-ink font-semibold text-white shadow-sm"
                  : "text-ink-3 hover:bg-hover hover:text-ink"
              }`}
            >
              {s}×
            </button>
          ))}
        </div>
      </div>

      <div className="text-ink-3 mt-1.5 flex items-center justify-between px-1 text-[10px]">
        <span className="tnum">
          {data ? new Date(data.meta.from).toISOString().slice(0, 10) : ""}
        </span>
        <span className="flex items-center gap-3.5">
          <span>Each column is one hour.</span>
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-1.5 rounded-[1px] bg-[rgba(217,95,14,.92)]" />
            bar height = fire detections
          </span>
          <span className="flex items-center gap-1.5">
            <span className="flex h-1.5 w-6 overflow-hidden rounded-[1px]">
              {AQI_BANDS.slice(0, 4).map((b) => (
                <span key={b.css} className="h-full flex-1" style={{ backgroundColor: b.css }} />
              ))}
            </span>
            strip colour = worst air in view
          </span>
          <span className="text-ink-3/70">← → step · space play</span>
        </span>
        <span className="tnum">now</span>
      </div>
    </div>
  );
}
