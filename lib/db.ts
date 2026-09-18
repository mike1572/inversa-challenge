import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { config } from "./config";

/**
 * Single pg pool, cached on globalThis so Next's dev hot-reload doesn't leak
 * pools on every edit.
 *
 * max is deliberately small: we connect through Supabase's PgBouncer in
 * transaction mode, so each serverless invocation wants a couple of slots at
 * most. Opening more here just queues behind the pooler.
 */

declare global {
  var __pgPool: Pool | undefined;
}

export const pool =
  globalThis.__pgPool ??
  new Pool({
    connectionString: config.databaseUrl,
    max: 4,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    // Supabase's pooler terminates TLS with its own cert chain.
    ssl: config.databaseUrl.includes("localhost") ? undefined : { rejectUnauthorized: false },
  });

if (process.env.NODE_ENV !== "production") globalThis.__pgPool = pool;

export async function sql<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await pool.query<T>(text, params as never[]);
  return res.rows;
}

export async function withClient<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/** Anything that can run a parameterised query — the Pool or a checked-out client. */
export interface Querier {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

/**
 * A column in a bulk insert. `expr` wraps the placeholder for columns that need
 * a cast or a constructor — `$4::jsonb`, `st_geomfromgeojson($5)::geography`.
 */
export interface ColumnSpec {
  name: string;
  expr?: (placeholder: string) => string;
}

export const asJsonb = (p: string) => `${p}::jsonb`;
export const asTimestamp = (p: string) => `${p}::timestamptz`;
export const asGeography = (p: string) => `${p}::geography`;
export const asGeoJson = (p: string) => `st_geomfromgeojson(${p})::geography`;

/**
 * Multi-row INSERT, chunked to stay under Postgres' parameter limit.
 *
 * Exists because the four ingest upserts were the same twenty lines of
 * placeholder arithmetic with different column names, and that arithmetic is
 * exactly the kind of code that silently breaks when someone adds a column.
 */
export async function bulkInsert<T extends QueryResultRow = QueryResultRow>(
  client: Querier,
  table: string,
  columns: ColumnSpec[],
  rows: unknown[][],
  opts: { onConflict?: string; returning?: string; chunkSize?: number } = {},
): Promise<{ rows: T[]; count: number }> {
  if (rows.length === 0) return { rows: [], count: 0 };

  // Postgres caps a statement at 65535 parameters.
  const maxByParams = Math.floor(65000 / columns.length);
  const chunkSize = Math.min(opts.chunkSize ?? 1000, maxByParams);

  const names = columns.map((c) => c.name).join(", ");
  const collected: T[] = [];
  let count = 0;

  for (let start = 0; start < rows.length; start += chunkSize) {
    const chunk = rows.slice(start, start + chunkSize);
    const params: unknown[] = [];
    const tuples = chunk.map((row) => {
      const cells = columns.map((col, i) => {
        params.push(row[i]);
        const placeholder = `$${params.length}`;
        return col.expr ? col.expr(placeholder) : placeholder;
      });
      return `(${cells.join(", ")})`;
    });

    const res = await client.query<T>(
      `insert into ${table} (${names}) values ${tuples.join(", ")}` +
        (opts.onConflict ? ` ${opts.onConflict}` : "") +
        (opts.returning ? ` returning ${opts.returning}` : ""),
      params,
    );

    collected.push(...res.rows);
    count += res.rowCount ?? 0;
  }

  return { rows: collected, count };
}
