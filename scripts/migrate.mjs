import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "..", "drizzle");
const ADVISORY_LOCK_KEY = 918273645;

function requireDatabaseUrl() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("migrate: DATABASE_URL is not set");
    process.exit(1);
  }
  return url;
}

async function ensureMigrationsTable(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;
}

async function run() {
  const url = requireDatabaseUrl();
  const sql = postgres(url, { max: 1 });

  try {
    await ensureMigrationsTable(sql);
    await sql`SELECT pg_advisory_lock(${ADVISORY_LOCK_KEY})`;

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith(".sql"))
      .sort();

    const appliedRows = await sql`SELECT name FROM _migrations`;
    const applied = new Set(appliedRows.map((r) => r.name));

    let appliedCount = 0;
    for (const file of files) {
      if (applied.has(file)) {
        continue;
      }
      const content = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      console.log(`migrate: applying ${file}`);
      await sql.begin(async (tx) => {
        await tx.unsafe(content);
        await tx`INSERT INTO _migrations (name) VALUES (${file})`;
      });
      appliedCount += 1;
    }

    if (appliedCount === 0) {
      console.log("migrate: no new migrations to apply");
    } else {
      console.log(`migrate: applied ${appliedCount} migration(s)`);
    }

    await sql`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`;
  } finally {
    await sql.end();
  }
}

run().catch((err) => {
  console.error("migrate: failed");
  console.error(err);
  process.exit(1);
});
