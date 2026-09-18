"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { AnswerEnvelope } from "@/lib/agent/schema";
import type { BBox } from "@/lib/config";
import { containsBBox, levelForRefetch, padBBox } from "@/lib/lod";
import type { WindowPayload } from "@/lib/query/window";
import { useStore, type LayerKey } from "@/lib/store";
import AgentPanel from "./AgentPanel";
import EvidenceDrawer from "./EvidenceDrawer";
import FreshnessStrip from "./FreshnessStrip";
import Timeline from "./Timeline";

// deck.gl touches window/WebGL at import time.
const MapView = dynamic(() => import("./MapView"), {
  ssr: false,
  loading: () => <div className="h-full w-full bg-base" />,
});

export default function Explorer({ initial }: { initial: WindowPayload | null }) {
  const setData = useStore((s) => s.setData);
  const setLoading = useStore((s) => s.setLoading);
  const setLoadError = useStore((s) => s.setLoadError);
  const setCursorHour = useStore((s) => s.setCursorHour);
  const setFocusStation = useStore((s) => s.setFocusStation);
  const setLayers = useStore((s) => s.setLayers);
  const setPlaying = useStore((s) => s.setPlaying);
  const flyTo = useStore((s) => s.flyTo);
  const data = useStore((s) => s.data);
  const loadError = useStore((s) => s.loadError);
  const [panelOpen, setPanelOpen] = useState(true);
  const animRef = useRef<number>(0);

  const inFlight = useRef<AbortController | null>(null);

  const refetch = useCallback(
    async (bbox?: BBox, from?: string, to?: string) => {
      // Supersede any request still running. Zooming fires these faster than
      // they return, and without this an older response can land last and
      // overwrite the view the user is actually looking at.
      inFlight.current?.abort();
      const ctrl = new AbortController();
      inFlight.current = ctrl;

      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (bbox) params.set("bbox", bbox.join(","));
        if (from) params.set("from", from);
        if (to) params.set("to", to);

        const res = await fetch(`/api/window?${params}`, { signal: ctrl.signal });
        if (!res.ok) throw new Error(`Failed to load data (${res.status})`);
        const payload: WindowPayload = await res.json();
        if (ctrl.signal.aborted) return;
        setData(payload);
        setLoading(false);
      } catch (err) {
        // An abort is us cancelling ourselves, not a failure.
        if (ctrl.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) {
          return;
        }
        // A background refresh that fails must not destroy a working view.
        // Only surface the blocking error when there is nothing on screen to
        // fall back to; otherwise keep the data we have and stop the spinner.
        setLoading(false);
        if (!useStore.getState().data) {
          setLoadError(err instanceof Error ? err.message : String(err));
        } else {
          console.warn("window refresh failed, keeping current data:", err);
        }
      } finally {
        if (inFlight.current === ctrl) inFlight.current = null;
      }
    },
    [setData, setLoading, setLoadError],
  );

  // Seed from the server-rendered payload so first paint has data, not a
  // spinner. Only falls back to a client fetch if the server render failed.
  useEffect(() => {
    if (initial) setData(initial);
    else void refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Ease the time cursor rather than jumping it, so the move is legible. */
  const animateCursorTo = useCallback(
    (targetHour: number) => {
      cancelAnimationFrame(animRef.current);
      const startHour = useStore.getState().cursorHour;
      const startedAt = performance.now();
      const duration = 700;

      const step = (t: number) => {
        const p = Math.min(1, (t - startedAt) / duration);
        const eased = 1 - Math.pow(1 - p, 3);
        setCursorHour(startHour + (targetHour - startHour) * eased);
        if (p < 1) animRef.current = requestAnimationFrame(step);
      };
      animRef.current = requestAnimationFrame(step);
    },
    [setCursorHour],
  );

  /**
   * An answer takes over the view. This is the whole "agent as UI controller"
   * claim: the map flies to what is being described, the layers that matter
   * turn on, and the time cursor moves to the moment in question.
   */
  const onAnswer = useCallback(
    (answer: AnswerEnvelope) => {
      setPlaying(false);

      const { view } = answer;

      if (view.focus_station_id) setFocusStation(view.focus_station_id);

      if (Array.isArray(view.layers) && view.layers.length > 0) {
        setLayers(view.layers as LayerKey[]);
      }

      const bbox =
        Array.isArray(view.bbox) && view.bbox.length === 4 && view.bbox.every(Number.isFinite)
          ? (view.bbox as BBox)
          : null;
      if (bbox) flyTo(bbox);

      const current = useStore.getState().data;
      const target = new Date(view.t_to);
      if (!current || Number.isNaN(target.getTime())) return;

      const windowStart = new Date(current.meta.from).getTime();
      const windowEnd = new Date(current.meta.to).getTime();

      // If the answer points outside the loaded window, load that window
      // instead of clamping to an edge and quietly showing the wrong time.
      const from = new Date(view.t_from);
      const outside =
        target.getTime() > windowEnd + 3600_000 ||
        (!Number.isNaN(from.getTime()) && from.getTime() < windowStart - 3600_000);

      if (outside) {
        void refetch(bbox ?? undefined, view.t_from, view.t_to);
        return;
      }

      const targetHour = Math.round((target.getTime() - windowStart) / 3600_000);
      animateCursorTo(Math.max(0, Math.min(current.meta.hours - 1, targetHour)));
    },
    [animateCursorTo, flyTo, refetch, setFocusStation, setLayers, setPlaying],
  );

  /**
   * Zooming across a detail tier refetches at the finer cap; panning within a
   * tier does not, so ordinary map dragging never hits the network.
   *
   * Debounced, because deck.gl emits a viewport change every frame of a zoom.
   * Firing on each one produced a burst of requests that raced each other, and
   * the browser cancelling the losers surfaced as "Failed to fetch".
   */
  const zoomTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onViewportChange = useCallback(
    (bbox: BBox) => {
      if (zoomTimer.current) clearTimeout(zoomTimer.current);
      zoomTimer.current = setTimeout(() => {
        const current = useStore.getState().data;
        if (!current) return;

        // Two independent reasons to go back to the server. Tier changes alone
        // are not enough: the payload only covers the box it was fetched for,
        // so zooming out or panning past that box would otherwise leave the
        // new area silently empty — points would appear to vanish.
        const tierChanged =
          levelForRefetch(bbox, current.meta.detailLevel) !== current.meta.detailLevel;
        const leftTheFetchedArea = !containsBBox(current.meta.bbox, bbox);

        if (!tierChanged && !leftTheFetchedArea) return;

        // Never request less than the whole region: the archive is North
        // America, so a padded request that already covers it should just ask
        // for it, which also keeps the common case cache-friendly.
        const wanted = padBBox(bbox);
        const region = current.meta.regionBBox;
        void refetch(containsBBox(wanted, region) ? region : wanted);
      }, 400);
    },
    [refetch],
  );

  useEffect(
    () => () => {
      if (zoomTimer.current) clearTimeout(zoomTimer.current);
      inFlight.current?.abort();
    },
    [],
  );

  return (
    <div className="flex h-dvh w-full flex-col overflow-hidden bg-base text-ink">
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <div className="relative min-h-0 flex-1">
          <MapView onViewportChange={onViewportChange} />
          <FreshnessStrip />

          {loadError && (
            <div className="border-line bg-surface pointer-events-none absolute top-20 left-1/2 z-20 w-80 -translate-x-1/2 rounded-md border p-3 text-center shadow-xl">
              <div className="text-[12px] font-medium text-red-300">Could not load data</div>
              <div className="mt-1 text-ink-3 text-[11px] leading-snug">{loadError}</div>
              <button
                onClick={() => refetch()}
                className="border-line bg-raised text-ink hover:bg-hover pointer-events-auto mt-2 rounded-md border px-2 py-1 text-[11px]"
              >
                Retry
              </button>
            </div>
          )}

          {/*
            "Nothing in this view" and "nothing in the database" are different
            claims, and showing the second when the first is true tells the user
            the system is broken when they have simply panned over the ocean.
          */}
          {/*
            pointer-events-none is load-bearing: this card sits over the middle
            of the map, and while it was interactive it swallowed the scroll
            wheel — so zooming into an empty area trapped you there, unable to
            zoom back out. Only the button inside takes pointer events.
          */}
          {data && data.fires.lat.length === 0 && data.stations.id.length === 0 && (
            <div className="chip pointer-events-none absolute top-20 left-1/2 z-10 max-w-[300px] -translate-x-1/2 rounded-md px-3 py-2.5 text-center">
              {data.meta.sources.every((s) => s.status === "never") ? (
                <>
                  <div className="text-ink text-[12px] font-medium">No data ingested yet</div>
                  <div className="text-ink-3 mt-1 text-[11px] leading-snug">
                    Run <span className="tnum">npm run backfill</span>, then reload.
                  </div>
                </>
              ) : (
                <>
                  <div className="text-ink text-[12px] font-medium">Nothing in this view</div>
                  <div className="text-ink-3 mt-1 text-[11px] leading-snug">
                    No monitors or detections here in this window. The archive covers
                    North America.
                  </div>
                  <button
                    onClick={() => flyTo(data.meta.bbox)}
                    className="border-line bg-raised text-ink hover:bg-hover pointer-events-auto mt-2 rounded-md border px-2 py-1 text-[11px] transition-colors"
                  >
                    Reset view
                  </button>
                </>
              )}
            </div>
          )}

          <button
            onClick={() => setPanelOpen((v) => !v)}
            className="absolute bottom-2.5 right-2.5 z-10 chip rounded-md px-2 py-1 text-[10px] text-ink md:hidden"
          >
            {panelOpen ? "Hide ask" : "Ask"}
          </button>
        </div>

        {/* light-panel scopes the palette for everything inside, so the agent
            panel and its evidence drawer both read as paper. */}
        <div
          className={`light-panel relative w-full shrink-0 border-[#0d1117] md:w-[370px] md:border-l ${
            panelOpen ? "h-[45vh] border-t md:h-auto" : "hidden md:block"
          }`}
        >
          <AgentPanel onAnswer={onAnswer} />
          <EvidenceDrawer />
        </div>
      </div>

      <Timeline />
    </div>
  );
}
