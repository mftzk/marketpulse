import postgres from "postgres";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function describe(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (current instanceof Error) {
      parts.push(`${current.constructor.name}: ${current.message.split("\n")[0].slice(0, 160)}`);
      const frames = (current.stack ?? "")
        .split("\n")
        .slice(1, 5)
        .map((s) => s.trim().slice(0, 110))
        .filter((f) => !f.includes("node:internal") && !f.includes("next-server"));
      parts.push(...frames.map((f) => `   ${f}`));
      current = current.cause;
    } else {
      parts.push(String(current).slice(0, 160));
      break;
    }
  }
  return parts.join(" // ");
}

export async function GET(): Promise<Response> {
  const results: Record<string, string> = {};
  const date = new Date();
  const iso = date.toISOString();

  await ensureTable();

  // 1. drizzle + Date param (the failing case)
  try {
    await getDb().execute(sql`select count(*)::int as c from _diag_t where ts >= ${date}`);
    results.drizzle_execute_date = "ok";
  } catch (err) {
    results.drizzle_execute_date = describe(err);
  }

  // 2. drizzle + ISO string param
  try {
    await getDb().execute(sql`select count(*)::int as c from _diag_t where ts >= ${iso}::timestamptz`);
    results.drizzle_execute_iso = "ok";
  } catch (err) {
    results.drizzle_execute_iso = describe(err);
  }

  // 3. drizzle insert with Date
  try {
    await getDb().execute(
      sql`insert into _diag_t (id, ts, note) values (2, ${date}, 'drizzle-date') on conflict (id) do update set ts = excluded.ts`,
    );
    results.drizzle_insert_date = "ok";
  } catch (err) {
    results.drizzle_insert_date = describe(err);
  }

  // 4. raw client + Date (control)
  const raw = postgres(config.databaseUrl ?? "", { max: 1, prepare: false });
  try {
    await raw.unsafe("select $1::timestamptz as d", [date]);
    results.raw_client_date = "ok";
  } catch (err) {
    results.raw_client_date = describe(err);
  }
  await raw.end();

  return Response.json(results);
}

async function ensureTable(): Promise<void> {
  await getDb().execute(
    sql`create table if not exists _diag_t (id int primary key, ts timestamptz, note text)`,
  );
}
