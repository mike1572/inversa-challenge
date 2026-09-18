"use client";

import { useCallback, useEffect, useRef } from "react";
import type { BBox } from "../config";
import { containsBBox, levelForRefetch, padBBox, sameBBox } from "../lod";
import type { WindowPayload } from "../query/window";
import { useStore } from "../store";

/**
 * Keeps the loaded window covering wherever the map is looking.
 *
 * This lived inside Explorer, which meant a layout component also owned six
 * refs and a request state machine. Separating it leaves Explorer to arrange
 * panels and lets the fetching rules — supersede, reconcile, cache — be read in
 * one place, which matters because they only make sense together.
 *
 * The rules:
 *  - one request at a time; a newer one aborts the older, so a slow response
 *    can never land last and overwrite the view you are actually on;
 *  - coverage is re-checked after every payload, not only on movement, because
 *    a decision taken while a request was in flight was taken against the old
 *    data;
 *  - the whole-region payload is kept, so zooming out redraws immediately
 *    instead of going sparse until the network answers.
 */

/** Stops reconciliation from chasing a moving viewport indefinitely. */
const MAX_RECONCILE_STEPS = 3;
/** Wait for the gesture to settle; deck.gl reports a viewport every frame. */
const SETTLE_MS = 400;

export interface WindowData {
  /** Explicit load, used when an answer asks for a different time range. */
  load: (bbox?: BBox, from?: string, to?: string) => Promise<void>;
  onViewportChange: (bbox: BBox) => void;
}

export function useWindowData(initial: WindowPayload | null): WindowData {
  const setData = useStore((s) => s.setData);
  const setLoading = useStore((s) => s.setLoading);
  const setLoadError = useStore((s) => s.setLoadError);

  const inFlight = useRef<AbortController | null>(null);
  /** Area the in-flight request covers, so we can tell when it has gone stale. */
  const inFlightArea = useRef<BBox | null>(null);
  /** Live viewport, updated every move rather than on the settle timer. */
  const viewport = useRef<BBox | null>(null);
  /** Last area asked for; the guard that terminates reconciliation. */
  const requested = useRef<BBox | null>(null);
  /** Whole-region payload, so zooming out is instant. */
  const wholeRegion = useRef<WindowPayload | null>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const remember = useCallback((p: WindowPayload) => {
    if (sameBBox(p.meta.bbox, p.meta.regionBBox)) wholeRegion.current = p;
  }, []);

  const fetchWindow = useCallback(
    async (bbox?: BBox, from?: string, to?: string): Promise<void> => {
      inFlight.current?.abort();
      const ctrl = new AbortController();
      inFlight.current = ctrl;
      inFlightArea.current = bbox ?? null;
      requested.current = bbox ?? null;

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

        remember(payload);
        setData(payload);
        setLoading(false);
      } catch (err) {
        // Aborting is us superseding ourselves, not a failure.
        if (ctrl.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) {
          return;
        }
        // A failed background refresh must not destroy a working view: only
        // surface the blocking error when there is nothing to fall back to.
        setLoading(false);
        if (!useStore.getState().data) {
          setLoadError(err instanceof Error ? err.message : String(err));
        } else {
          console.warn("window refresh failed, keeping current data:", err);
        }
      } finally {
        if (inFlight.current === ctrl) {
          inFlight.current = null;
          inFlightArea.current = null;
        }
      }
    },
    [remember, setData, setLoading, setLoadError],
  );

  /**
   * Swap in the wider cached payload the moment the view outgrows what we hold.
   * Costs nothing and is the difference between "the points come back after a
   * second" and "the points never left".
   */
  const restoreWiderIfHeld = useCallback(
    (vp: BBox): boolean => {
      const held = useStore.getState().data;
      const cached = wholeRegion.current;
      if (!held || !cached) return false;
      if (sameBBox(held.meta.bbox, cached.meta.bbox)) return false;
      if (containsBBox(held.meta.bbox, vp)) return false;
      if (!containsBBox(cached.meta.bbox, vp)) return false;
      setData(cached);
      return true;
    },
    [setData],
  );

  /**
   * Loop rather than recursion: re-check after each load, because the viewport
   * may have moved while it was in flight. `requested` terminates it — we never
   * ask twice for the same area, which also stops a viewport wider than the
   * whole archive from spinning.
   */
  const reconcile = useCallback(async () => {
    for (let step = 0; step < MAX_RECONCILE_STEPS; step++) {
      const held = useStore.getState().data;
      const vp = viewport.current;
      if (!held || !vp) return;

      const tierMatches =
        levelForRefetch(vp, held.meta.detailLevel) === held.meta.detailLevel;
      if (tierMatches && containsBBox(held.meta.bbox, vp)) return;

      restoreWiderIfHeld(vp);

      const wanted = padBBox(vp);
      const region = held.meta.regionBBox;
      const target = containsBBox(wanted, region) ? region : wanted;

      if (sameBBox(target, requested.current)) return;
      await fetchWindow(target);
    }
  }, [fetchWindow, restoreWiderIfHeld]);

  const onViewportChange = useCallback(
    (bbox: BBox) => {
      viewport.current = bbox;
      restoreWiderIfHeld(bbox);

      // A request for somewhere we have already left would, on arrival, put the
      // wrong extent on screen. Drop it now rather than undo it later.
      if (inFlightArea.current && !containsBBox(inFlightArea.current, bbox)) {
        inFlight.current?.abort();
        inFlightArea.current = null;
        requested.current = null;
      }

      if (settleTimer.current) clearTimeout(settleTimer.current);
      settleTimer.current = setTimeout(() => void reconcile(), SETTLE_MS);
    },
    [reconcile, restoreWiderIfHeld],
  );

  // First paint comes from the server render; only fetch if that failed.
  useEffect(() => {
    if (initial) {
      remember(initial);
      setData(initial);
    } else {
      void fetchWindow();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(
    () => () => {
      if (settleTimer.current) clearTimeout(settleTimer.current);
      inFlight.current?.abort();
    },
    [],
  );

  const load = useCallback(
    async (bbox?: BBox, from?: string, to?: string) => {
      await fetchWindow(bbox, from, to);
      await reconcile();
    },
    [fetchWindow, reconcile],
  );

  return { load, onViewportChange };
}
