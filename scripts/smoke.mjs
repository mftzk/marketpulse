#!/usr/bin/env node
/**
 * MarketPulse live acceptance harness (dependency-free).
 *
 * Usage:  BASE_URL=http://127.0.0.1:3000 node scripts/smoke.mjs
 *
 * Runs a table of HTTP checks against a running instance, prints PASS/FAIL per
 * line with a summary, and exits non-zero if any check fails. Only `node:*` /
 * globals (fetch) are used.
 */

const BASE_URL = (process.env.BASE_URL || process.argv[2] || "http://127.0.0.1:3000").replace(
  /\/$/,
  "",
);
const SMOKE_EMAIL =
  process.env.SMOKE_EMAIL || process.env.ADMIN_EMAIL || "zakaria@nrapken.dev";
const SMOKE_PASSWORD = process.env.SMOKE_PASSWORD || "";

if (!SMOKE_PASSWORD) {
  console.error("smoke: SMOKE_PASSWORD not set — cannot sign in");
  process.exit(1);
}

const NO_ADVICE = /\b(buy|sell|recommend(ation)?s?|target price|take profit|enter at)\b/i;

const state = { events: [], sessionCookie: "" };

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function authHeaders(extra = {}) {
  return state.sessionCookie ? { cookie: state.sessionCookie, ...extra } : { ...extra };
}

async function getJson(path) {
  const response = await fetch(`${BASE_URL}${path}`, { headers: authHeaders() });
  if (!response.ok) {
    throw new Error(`GET ${path} -> HTTP ${response.status}`);
  }
  return response.json();
}

function* walkStrings(value) {
  if (typeof value === "string") {
    yield value;
  } else if (Array.isArray(value)) {
    for (const item of value) {
      yield* walkStrings(item);
    }
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      yield* walkStrings(item);
    }
  }
}

function findAdvice(value) {
  for (const text of walkStrings(value)) {
    const match = NO_ADVICE.exec(text);
    if (match) {
      return `${match[0]} in ${JSON.stringify(text).slice(0, 80)}`;
    }
  }
  return null;
}

function countStrings(value) {
  let count = 0;
  for (const _ of walkStrings(value)) {
    count += 1;
  }
  return count;
}

const results = [];

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail ?? "" });
  } catch (err) {
    results.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
  }
}

const DETAIL_SECTIONS = [
  "overview",
  "what_happened",
  "why_it_matters",
  "expectation_vs_actual",
  "price_reaction",
  "volume_reaction",
  "sector_reaction",
  "related_stocks",
  "technical",
  "macro",
  "regime",
  "options",
  "timeline",
  "sources",
  "impact_breakdown",
  "intraday",
];

await check("POST /api/auth/login (admin account)", async () => {
  const response = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: SMOKE_EMAIL, password: SMOKE_PASSWORD }),
  });
  assert(response.ok, `HTTP ${response.status}`);
  const setCookie = response.headers.get("set-cookie");
  assert(setCookie, "session cookie was not set");
  state.sessionCookie = setCookie.split(";")[0];
  const body = await response.json();
  assert(body.data && body.data.email, "user payload missing");
  return `signed in as ${body.data.email}`;
});

await check("GET /api/events without a session -> 401", async () => {
  const response = await fetch(`${BASE_URL}/api/events?limit=1`);
  assert(response.status === 401, `HTTP ${response.status}`);
  const body = await response.json();
  assert(body.code === "unauthorized", `code ${body.code}`);
  return "401 unauthorized";
});

await check("GET /api/health without a session -> 200", async () => {
  const response = await fetch(`${BASE_URL}/api/health`);
  assert(response.status === 200, `HTTP ${response.status}`);
  return "200 ok";
});

await check("GET /api/health", async () => {
  const health = await getJson("/api/health");
  assert(["ok", "degraded"].includes(health.status), `unexpected status ${health.status}`);
  assert(health.database && typeof health.database.ok === "boolean", "database.ok missing");
  return `status=${health.status} db.ok=${health.database.ok}`;
});

await check("GET /api/events (shape + no advice)", async () => {
  const body = await getJson("/api/events?limit=100&sort=published_desc");
  assert(Array.isArray(body.data), "data is not an array");
  assert(body.data.length >= 1, "expected at least one event");
  const required = [
    "id",
    "headline",
    "summary",
    "event_type",
    "published_at",
    "news_age_minutes",
    "source",
    "sentiment",
    "catalyst_direction",
    "relevance_score",
    "impact",
    "price",
    "market",
    "interpretation",
  ];
  for (const card of body.data) {
    for (const key of required) {
      assert(card[key] !== undefined, `event ${card.id} missing "${key}"`);
    }
    assert(
      typeof card.impact.score === "number" && card.impact.score >= 0 && card.impact.score <= 100,
      `impact score out of range on ${card.id}`,
    );
    const advice = findAdvice(card);
    assert(!advice, `advice language: ${advice}`);
  }
  state.events = body.data;
  return `${body.data.length} events`;
});

await check("GET /api/events/{id} (16 sections, bars, sources)", async () => {
  assert(state.events.length > 0, "no events available from the previous check");
  const body = await getJson(`/api/events/${state.events[0].id}`);
  const { detail } = body.data;
  assert(detail, "detail missing");
  for (const section of DETAIL_SECTIONS) {
    assert(section in detail, `missing detail section "${section}"`);
  }
  assert(detail.intraday.bars.length > 0, "intraday bars empty");
  assert(detail.sources.length > 0, "sources empty");
  return `${DETAIL_SECTIONS.length} sections, ${detail.intraday.bars.length} bars, ${detail.sources.length} sources`;
});

await check("GET /api/stocks/NVDA", async () => {
  const stock = (await getJson("/api/stocks/NVDA")).data;
  assert(stock.quote, "quote missing");
  assert("technical" in stock, "technical missing");
  assert(Array.isArray(stock.expectations) && stock.expectations.length > 0, "expectations empty");
  return `price=${stock.quote.price}`;
});

await check("GET /api/stocks/NVDA/events", async () => {
  const body = await getJson("/api/stocks/NVDA/events?limit=5");
  assert(Array.isArray(body.data), "data is not an array");
  return `${body.data.length} events`;
});

await check("GET /api/market/context", async () => {
  const context = (await getJson("/api/market/context")).data;
  const macroCount = Object.keys(context.macro ?? {}).length;
  assert(macroCount >= 8, `macro series ${macroCount} < 8`);
  assert(
    context.regime && typeof context.regime.description === "string" && context.regime.description.length > 0,
    "regime description empty",
  );
  return `${macroCount} macro series`;
});

await check("GET /api/sectors/semiconductors", async () => {
  const sector = (await getJson("/api/sectors/semiconductors")).data;
  assert(sector.sector && sector.etf, "sector/etf missing");
  return `${sector.stocks.length} stocks`;
});

await check("GET /api/watchlists", async () => {
  const lists = (await getJson("/api/watchlists")).data;
  assert(Array.isArray(lists), "data is not an array");
  return `${lists.length} watchlists`;
});

await check("GET /api/alerts", async () => {
  const alerts = (await getJson("/api/alerts")).data;
  assert(Array.isArray(alerts.rules) && Array.isArray(alerts.events), "rules/events missing");
  return `${alerts.rules.length} rules, ${alerts.events.length} triggers`;
});

await check("GET /api/pipeline/status", async () => {
  const status = (await getJson("/api/pipeline/status")).data;
  assert(status.scheduler, "scheduler missing");
  return `enabled=${status.scheduler.enabled}`;
});

await check("POST /api/pipeline/run", async () => {
  const response = await fetch(`${BASE_URL}/api/pipeline/run`, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ trigger: "api" }),
  });
  assert(response.ok, `HTTP ${response.status}`);
  const run = (await response.json()).data;
  assert(run.status !== "failed", `run status ${run.status}`);
  const failed = (run.steps ?? []).filter((step) => step.status === "failed");
  assert(failed.length === 0, `failed steps: ${failed.map((s) => s.name).join(", ")}`);
  return `status=${run.status} steps=${run.steps.length}`;
});

await check("GET /api/replay?date=<today>", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const replay = (await getJson(`/api/replay?date=${today}`)).data;
  assert(replay.date === today, `date mismatch ${replay.date}`);
  assert(Array.isArray(replay.timeline) && Array.isArray(replay.session_windows), "replay shape");
  return `${replay.timeline.length} events`;
});

await check("GET /api/search?q=nv", async () => {
  const search = (await getJson("/api/search?q=nv")).data;
  assert(Array.isArray(search.tickers) && Array.isArray(search.events), "search shape");
  return `${search.tickers.length} tickers, ${search.events.length} events`;
});

await check("no-advice scan over /api/events?limit=50", async () => {
  const body = await getJson("/api/events?limit=50");
  const advice = findAdvice(body);
  assert(!advice, `advice language found: ${advice}`);
  return `${countStrings(body)} strings scanned`;
});

await check("older event has a measured reaction", async () => {
  const body = await getJson("/api/events?limit=100&sort=published_desc");
  const older = body.data.filter(
    (event) =>
      event.news_age_minutes > 15 &&
      event.price.change_pct_since_publication !== null &&
      event.price.change_pct_since_publication !== 0,
  );
  assert(older.length > 0, "no event older than 15m has a non-zero change_pct_since_publication");
  return `${older.length} events with measured reaction`;
});

const width = Math.max(...results.map((result) => result.name.length));
for (const result of results) {
  const status = result.ok ? "PASS" : "FAIL";
  console.log(`${status}  ${result.name.padEnd(width)}  ${result.detail}`);
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.error(`smoke: ${failed.length} check(s) failed against ${BASE_URL}`);
  process.exit(1);
}
console.log(`smoke: all checks passed against ${BASE_URL}`);
