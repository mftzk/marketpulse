import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { config } from "@/lib/config";

import * as schema from "./schema";

export type Db = PostgresJsDatabase<typeof schema>;

type Sql = ReturnType<typeof postgres>;

/**
 * Timestamps are sent to PostgreSQL as ISO-8601 STRINGS, never as `Date` objects.
 *
 * Why (verified by bisection against a live database, 2026-09-28):
 *   - `client.unsafe("select $1::timestamptz", [new Date()])`  -> ok
 *   - drizzle `db.execute(sql`… where ts >= ${new Date()}`)`   -> throws
 *       TypeError: The "string" argument must be of type string or an instance of Buffer
 *       or ArrayBuffer. Received an instance of Date
 *     from `postgres/src/bytes.js` -> `Buffer.byteLength` (inside Bind).
 *   - the same statement with `${isoString}`                   -> ok
 * The driver's per-oid parameter serialiser is not reached for Drizzle-issued
 * statements in the production server bundle, so the raw `Date` survives to the binary
 * protocol encoder. Normalising every parameter at the single boundary where Drizzle calls
 * the driver removes the whole class of failure and is exercised by
 * `tests/db-params.test.ts`.
 */
function normalizeParam(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

function normalizeParams(params: unknown): unknown[] {
  if (!Array.isArray(params)) {
    return [];
  }
  return params.map(normalizeParam);
}

/** Wraps a driver client so no `Date` ever reaches the wire. */
function withTimestampSafety(client: Sql): Sql {
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === "unsafe") {
        return (query: string, params: unknown = [], options?: unknown) =>
          target.unsafe(query, normalizeParams(params) as never[], options as never);
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
    apply(target, thisArg, args: unknown[]) {
      const [strings, ...rest] = args;
      const mapped = rest.map((arg) => (Array.isArray(arg) ? arg.map(normalizeParam) : arg));
      return Reflect.apply(target as unknown as (...a: unknown[]) => unknown, thisArg, [strings, ...mapped]);
    },
  });
}

function createDb(): Db {
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is not configured");
  }
  const client = postgres(config.databaseUrl, { max: 3, prepare: false });
  return drizzle(withTimestampSafety(client), { schema });
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

export { normalizeParam, normalizeParams };
