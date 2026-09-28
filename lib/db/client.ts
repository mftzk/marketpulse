import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { config } from "@/lib/config";

import * as schema from "./schema";

export type Db = PostgresJsDatabase<typeof schema>;

function createDb(): Db {
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is not configured");
  }
  const client = postgres(config.databaseUrl, { max: 3, prepare: false });
  return drizzle(client, { schema });
}

const globalForDb = globalThis as unknown as { __marketpulseDb?: Db };

/**
 * Singleton database handle, cached on `globalThis` so hot-reloads and multiple
 * modules share one connection pool.
 */
export function getDb(): Db {
  if (!globalForDb.__marketpulseDb) {
    globalForDb.__marketpulseDb = createDb();
  }
  return globalForDb.__marketpulseDb;
}
