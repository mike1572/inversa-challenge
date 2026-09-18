/**
 * The source adapter contract.
 *
 * Adapters are PURE fetch-and-normalize: they never touch the database. All
 * writing happens in lib/ingest/run.ts, so transactions, provenance linking and
 * error logging are written once rather than once per feed. Adding a fifth feed
 * is one file plus a registry line.
 */

/**
 * Parsed JSON from a provider.
 *
 * These are third-party payloads whose shape we do not control and which differ
 * per endpoint. Each adapter validates the handful of fields it actually reads
 * and discards anything malformed, which is where the real safety comes from;
 * full schemas for every response would be a great deal of code guarding
 * fields we never touch. Declaring the escape hatch once, here, keeps that
 * decision visible instead of scattering it across five files.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ProviderJson = any;

export interface RawRequest {
  url: string;
  status: number;
  body: string;
}

export interface StationRow {
  sourceId: string;
  externalId: string;
  name: string | null;
  lat: number;
  lon: number;
  historyTier?: "A" | "B";
  metadata?: Record<string, unknown>;
}

export interface ObsRow {
  /** Identifies the station by its natural key; resolved to an id on write. */
  sourceId: string;
  externalId: string;
  param: string;
  observedAt: Date;
  value: number | null;
  unit: string;
  qualityFlag?: string | null;
  /** Index into the FetchResult.requests array this row came from. */
  requestIndex?: number;
}

export interface EventRow {
  sourceId: string;
  kind: "fire_detection" | "nws_alert";
  externalId: string;
  /** GeoJSON geometry — Point for detections, Polygon/MultiPolygon for alerts. */
  geometry: unknown;
  validFrom: Date;
  validTo: Date | null;
  attrs: Record<string, unknown>;
  requestIndex?: number;
}

/** A resolved NWS zone boundary, cached because zone geometry never changes. */
export interface ZoneRow {
  id: string;
  name: string | null;
  geometry: unknown;
}

export interface FetchResult {
  requests: RawRequest[];
  stations?: StationRow[];
  observations?: ObsRow[];
  events?: EventRow[];
  zones?: ZoneRow[];
  /** Surfaced on the ingest_runs row for anything the operator should know. */
  note?: string;
}

/**
 * Optional capabilities the caller lends to an adapter.
 *
 * Adapters still never import the database — they receive a lookup function, so
 * the dependency points at an abstraction and they stay testable with a stub.
 * Only the NWS adapter needs this; the rest ignore it.
 */
export interface FetchContext {
  /** Zone geometry we already hold, keyed by zone URL. */
  lookupZones?: (ids: string[]) => Promise<Map<string, unknown>>;
}

export interface SourceAdapter {
  id: string;
  /** Expected refresh interval; drives the staleness thresholds. */
  cadenceSec: number;
  /** False for NWS: its endpoint only ever returns what is active right now. */
  canBackfill: boolean;
  /** True if the adapter needs an API key that isn't configured. */
  isConfigured(): boolean;
  fetchWindow(from: Date, to: Date, ctx?: FetchContext): Promise<FetchResult>;
}

/** Shared fetch with a timeout, so one hanging provider can't stall a run. */
export async function fetchText(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<RawRequest> {
  const { timeoutMs = 30_000, ...rest } = init;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...rest, signal: ctrl.signal, cache: "no-store" });
    const body = await res.text();
    return { url, status: res.status, body };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { url, status: 0, body: JSON.stringify({ error: message }) };
  } finally {
    clearTimeout(timer);
  }
}

export function assertOk(req: RawRequest): void {
  if (req.status < 200 || req.status >= 300) {
    const snippet = req.body.slice(0, 300);
    throw new Error(`${req.url} → HTTP ${req.status}: ${snippet}`);
  }
}
