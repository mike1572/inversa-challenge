/**
 * Server-side configuration. Never import this into a client component.
 *
 * REGION_BBOX is deliberately config rather than a constant: narrowing the
 * region is the emergency lever if ingestion or payload size misbehaves, and
 * it should be a one-value change, not a refactor.
 */

export type BBox = [west: number, south: number, east: number, north: number];

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") {
    throw new Error(
      `Missing required environment variable ${name}. See .env.example.`,
    );
  }
  return v;
}

function optional(name: string): string | undefined {
  const v = process.env[name];
  return v === "" ? undefined : v;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${v}"`);
  return n;
}

function parseBBox(raw: string): BBox {
  const parts = raw.split(",").map((s) => Number(s.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`REGION_BBOX must be "west,south,east,north", got "${raw}"`);
  }
  const [w, s, e, n] = parts as BBox;
  if (w >= e || s >= n) {
    throw new Error(`REGION_BBOX is inverted: west<east and south<north required, got "${raw}"`);
  }
  return [w, s, e, n];
}

export const config = {
  databaseUrl: env("DATABASE_URL"),

  firmsMapKey: optional("FIRMS_MAP_KEY"),
  openaqApiKey: optional("OPENAQ_API_KEY"),
  nwsUserAgent: env("NWS_USER_AGENT", "smoke-and-breath/1.0 (contact@example.com)"),

  openaiApiKey: optional("OPENAI_API_KEY"),
  openaiModel: env("OPENAI_MODEL", "gpt-5"),

  ingestSecret: optional("INGEST_SECRET"),

  regionBBox: parseBBox(env("REGION_BBOX", "-130,24,-60,60")),
  historyDays: num("HISTORY_DAYS", 7),
  tierASensors: num("TIER_A_SENSORS", 300),
  lodFireCap: num("LOD_FIRE_CAP", 8000),
} as const;

/** FIRMS wants "west,south,east,north" — the same order we store it in. */
export function bboxParam(b: BBox = config.regionBBox): string {
  return b.join(",");
}

export const PARAMS = {
  pm25: "pm25",
  windSpeed: "wind_speed_10m",
  windDir: "wind_direction_10m",
  humidity: "relative_humidity_2m",
} as const;
