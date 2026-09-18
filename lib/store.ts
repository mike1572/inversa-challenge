"use client";

import { create } from "zustand";
import type { BBox } from "./config";
import type { WindowPayload } from "./query/window";
import type { AnswerEnvelope } from "./agent/schema";
import type { EvidenceRecord } from "./agent/run";

/**
 * One store, selector-subscribed.
 *
 * cursorHour changes up to 60x/second while scrubbing or playing. Holding it in
 * a root useState would re-render the agent panel, the evidence drawer and the
 * freshness strip on every frame for no reason. With a store, each component
 * subscribes to exactly the slice it needs, so only the map and timeline wake
 * up during a scrub.
 */

export interface AgentMessage {
  id: string;
  question: string;
  prose: string;
  evidence: EvidenceRecord[];
  answer: AnswerEnvelope | null;
  status: string | null;
  error: string | null;
  streaming: boolean;
}

export type LayerKey = "fires" | "pm25" | "wind" | "alerts";

interface State {
  data: WindowPayload | null;
  loading: boolean;
  loadError: string | null;

  cursorHour: number;
  playing: boolean;
  speed: number;

  layers: Record<LayerKey, boolean>;
  focusStationId: number | null;

  /**
   * A camera request, not camera state. The store holds the intent; MapView
   * owns the deck.gl transition that carries it out. The nonce makes repeat
   * requests for the same box distinguishable.
   */
  flyToTarget: { bbox: BBox; nonce: number } | null;

  messages: AgentMessage[];
  activeEvidenceId: number | null;

  setData: (d: WindowPayload) => void;
  setLoading: (v: boolean) => void;
  setLoadError: (m: string | null) => void;
  setCursorHour: (h: number) => void;
  stepCursor: (delta: number) => void;
  setPlaying: (v: boolean) => void;
  togglePlay: () => void;
  setSpeed: (s: number) => void;
  toggleLayer: (k: LayerKey) => void;
  setLayers: (keys: LayerKey[]) => void;
  setFocusStation: (id: number | null) => void;
  flyTo: (bbox: BBox) => void;

  startMessage: (id: string, question: string) => void;
  patchMessage: (id: string, patch: Partial<AgentMessage>) => void;
  appendProse: (id: string, text: string) => void;
  addEvidence: (id: string, e: EvidenceRecord) => void;
  setActiveEvidence: (id: number | null) => void;
}

export const useStore = create<State>((set, get) => ({
  data: null,
  loading: false,
  loadError: null,

  cursorHour: 0,
  playing: false,
  speed: 6, // hours per second

  layers: { fires: true, pm25: true, wind: false, alerts: true },
  focusStationId: null,
  flyToTarget: null,

  messages: [],
  activeEvidenceId: null,

  setData: (d) =>
    set((s) => ({
      data: d,
      loadError: null,
      // Park the cursor at the newest hour that actually HAS data, not at the
      // literal last hour. The current hour is nearly always still empty —
      // stations report on the hour and arrive minutes later — so defaulting to
      // it opens the app on a map where every station is blank.
      cursorHour:
        s.data === null
          ? lastPopulatedHour(d)
          : Math.min(s.cursorHour, d.meta.hours - 1),
    })),
  setLoading: (v) => set({ loading: v }),
  setLoadError: (m) => set({ loadError: m, loading: false }),

  setCursorHour: (h) => {
    const max = (get().data?.meta.hours ?? 1) - 1;
    set({ cursorHour: Math.max(0, Math.min(max, Math.round(h))) });
  },
  stepCursor: (delta) => get().setCursorHour(get().cursorHour + delta),
  setPlaying: (v) => set({ playing: v }),
  togglePlay: () => set((s) => ({ playing: !s.playing })),
  setSpeed: (speed) => set({ speed }),

  toggleLayer: (k) => set((s) => ({ layers: { ...s.layers, [k]: !s.layers[k] } })),
  /** Used when an answer declares which layers matter. */
  setLayers: (keys) =>
    set({
      layers: {
        fires: keys.includes("fires"),
        pm25: keys.includes("pm25"),
        wind: keys.includes("wind"),
        alerts: keys.includes("alerts"),
      },
    }),
  setFocusStation: (id) => set({ focusStationId: id }),
  flyTo: (bbox) =>
    set((s) => ({ flyToTarget: { bbox, nonce: (s.flyToTarget?.nonce ?? 0) + 1 } })),

  startMessage: (id, question) =>
    set((s) => ({
      messages: [
        ...s.messages,
        {
          id,
          question,
          prose: "",
          evidence: [],
          answer: null,
          status: null,
          error: null,
          streaming: true,
        },
      ],
    })),

  patchMessage: (id, patch) =>
    set((s) => ({
      messages: s.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    })),

  appendProse: (id, text) =>
    set((s) => ({
      messages: s.messages.map((m) => (m.id === id ? { ...m, prose: m.prose + text } : m)),
    })),

  addEvidence: (id, e) =>
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === id ? { ...m, evidence: [...m.evidence, e] } : m,
      ),
    })),

  setActiveEvidence: (activeEvidenceId) => set({ activeEvidenceId }),
}));

/** Newest hour with any reading or detection; falls back to the last hour. */
function lastPopulatedHour(d: WindowPayload): number {
  const { maxPm25, fires } = d.activity;
  for (let h = d.meta.hours - 1; h >= 0; h--) {
    if (maxPm25[h] !== null || fires[h] > 0) return h;
  }
  return d.meta.hours - 1;
}

/** Timestamp for a given hour index in the loaded window. */
export function hourToDate(data: WindowPayload | null, hour: number): Date | null {
  if (!data) return null;
  return new Date(new Date(data.meta.from).getTime() + hour * 3600_000);
}
