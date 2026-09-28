#!/usr/bin/env node
/**
 * MarketPulse read-path benchmark (dependency-free).
 *
 * Usage:  BASE_URL=http://127.0.0.1:3000 node scripts/bench.mjs
 *
 * Warms each endpoint once, then measures it 3 times and reports the median
 * latency and response size. Prints PASS/FAIL against a per-endpoint budget and
 * exits non-zero if any endpoint misses its budget.
 *
 * Budgets are tuned for the deployed Nrapken Quick container (0.25 vCPU /
 * 512 MiB), which is roughly 4x slower than a normal dev machine; a local run
 * should land comfortably inside them. Only `node:*` / globals (fetch) are used.
 */

const BASE_URL = (process.env.BASE_URL || process.argv[2] || "http://127.0.0.1:3000").replace(
  /\/$/,
  "",
);

const RUNS = 3;

const EMAIL = process.env.SMOKE_EMAIL || "trader@marketpulse.dev";
const PASSWORD = process.env.SMOKE_PASSWORD || "marketpulse-demo";

/** Session cookie header for the gated endpoints (empty when auth is disabled). */
let SESSION_HEADER = "";

async function signIn() {
  try {
    const response = await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    if (!response.ok) {
      console.log(`bench: login failed (${response.status}) — measuring anonymously`);
      return;
    }
    const setCookie = response.headers.get("set-cookie");
    const match = setCookie?.match(/mp_session=[^;]+/);
    if (match) {
      SESSION_HEADER = match[0];
    }
  } catch {
    console.log("bench: login request failed — measuring anonymously");
  }
}

/** endpoint → budget in milliseconds. */
const BUDGETS = [
  { path: "/api/events?limit=15", budgetMs: 400 },
  { path: "/api/events?limit=50", budgetMs: 900 },
  { path: "/api/market/context", budgetMs: 250 },
  { path: "/api/watchlists", budgetMs: 250 },
  { path: "/api/health", budgetMs: 250 },
  { path: "/", budgetMs: 1500 },
  { path: "/api/stocks/NVDA", budgetMs: 400 },
  { path: "/api/sectors/semiconductors", budgetMs: 400 },
];

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function measure(path) {
  const times = [];
  let bytes = 0;
  let status = 0;
  let error = null;
  for (let i = 0; i < RUNS; i += 1) {
    const started = process.hrtime.bigint();
    try {
      const response = await fetch(`${BASE_URL}${path}`, {
        cache: "no-store",
        headers: SESSION_HEADER ? { cookie: SESSION_HEADER } : {},
      });
      const text = await response.text();
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      times.push(elapsedMs);
      bytes = Buffer.byteLength(text);
      status = response.status;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }
  return { times, bytes, status, error };
}

async function warmUp(path) {
  try {
    await fetch(`${BASE_URL}${path}`, {
      cache: "no-store",
      headers: SESSION_HEADER ? { cookie: SESSION_HEADER } : {},
    });
  } catch {
    // A warm-up failure is reported by the measured runs that follow.
  }
}

await signIn();

console.log(`bench: ${BASE_URL} (median of ${RUNS} runs, after 1 warm-up)\n`);

const rows = [];
let failures = 0;

for (const { path, budgetMs } of BUDGETS) {
  await warmUp(path);
  const result = await measure(path);
  const pass =
    result.error === null &&
    result.status >= 200 &&
    result.status < 400 &&
    result.times.length > 0 &&
    median(result.times) <= budgetMs;
  if (!pass) {
    failures += 1;
  }
  rows.push({
    path,
    medianMs: result.times.length > 0 ? median(result.times) : Number.NaN,
    bytes: result.bytes,
    status: result.status,
    budgetMs,
    pass,
    error: result.error,
  });
}

const header = ["PASS", "endpoint", "median", "budget", "bytes", "status"];
const lines = rows.map((row) => [
  row.pass ? "PASS" : "FAIL",
  row.path,
  `${row.medianMs.toFixed(1)} ms`,
  `<= ${row.budgetMs} ms`,
  `${row.bytes} B`,
  row.error ? `ERR ${row.error}` : String(row.status),
]);
const widths = header.map((h, i) => Math.max(h.length, ...lines.map((line) => line[i].length)));
const format = (cells) => cells.map((cell, i) => cell.padEnd(widths[i])).join("  ");
console.log(format(header));
console.log(format(widths.map((w) => "-".repeat(w))));
for (const line of lines) {
  console.log(format(line));
}

const passed = rows.length - failures;
console.log(`\n${passed}/${rows.length} endpoints within budget`);
if (failures > 0) {
  console.error(`bench: ${failures} endpoint(s) exceeded budget against ${BASE_URL}`);
  process.exit(1);
}
console.log(`bench: all endpoints within budget against ${BASE_URL}`);
