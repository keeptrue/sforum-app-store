import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;

let pool: Pool | null = null;
let database: Db | null = null;

export function getDb(): Db {
  if (database) return database;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }

  pool = new Pool({ connectionString, max: 10 });
  database = drizzle(pool, { schema });
  return database;
}

export function getPool(): Pool {
  getDb();
  if (!pool) throw new Error("database pool is not initialised");
  return pool;
}

export async function closeDb(): Promise<void> {
  if (pool) await pool.end();
  pool = null;
  database = null;
}
