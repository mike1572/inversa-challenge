/**
 * Apply SQL migrations in order. Idempotent — every statement in the
 * migrations uses "if not exists" or an upsert, so re-running is safe.
 *
 *   npm run migrate
 */

import "./env";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pool } from "../lib/db";

const DIR = join(process.cwd(), "supabase", "migrations");

async function main(): Promise<void> {
  const files = (await readdir(DIR)).filter((f) => f.endsWith(".sql")).sort();

  for (const file of files) {
    const sqlText = await readFile(join(DIR, file), "utf8");
    process.stdout.write(`→ ${file} … `);
    const client = await pool.connect();
    try {
      await client.query(sqlText);
      console.log("ok");
    } catch (err) {
      console.log("FAILED");
      throw err;
    } finally {
      client.release();
    }
  }

  const { rows } = await pool.query(
    `select table_name from information_schema.tables
      where table_schema = 'public' order by table_name`,
  );
  console.log(`\ntables: ${rows.map((r) => r.table_name).join(", ")}`);
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
