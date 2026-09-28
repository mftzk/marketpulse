# MarketPulse

Real-time stock news intelligence for short-term traders. MarketPulse ingests market news and
events, classifies them, measures how the market actually reacted, scores impact deterministically,
and presents the evidence.

> **Evidence, not instructions.** MarketPulse never tells you to buy or sell. It shows observable
> market reaction. Green/red are only ever used for measured positive/negative price movement.

Impact scores are computed by deterministic code (`lib/scoring/impact.ts`), never by the language
model. The LLM only extracts structured facts, validated against a strict zod schema before storage.

---

## Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router) + React 19 + TypeScript (strict) |
| Styling | Tailwind CSS v4 (`@tailwindcss/postcss`) |
| ORM | Drizzle ORM + `postgres` driver |
| Validation | zod |
| Charts | `lightweight-charts` (client only) |
| Tests | vitest |
| DB | PostgreSQL |
| Cache | Redis (optional; degrades to in-process memory) |
| Workers | in-process scheduler + `POST /api/pipeline/run` |

---

## Architecture

```
app/                 Next.js routes + API handlers (thin: parse → service → envelope)
components/          UI components (no financial math)
lib/
  config.ts          zod-validated env → typed config
  logger.ts          structured JSON logging
  errors.ts http.ts  AppError + response envelopes
  core/              domain types + zod schemas (the shared contract)
  db/                schema.ts (drizzle), client.ts, queries/
  providers/         News | Market | Fundamental providers + mocks
  analysis/          ticker detection, LLM classification, dedup, surprise math
  market/            reaction windows, RVOL, relative strength, technicals, macro
  scoring/           deterministic impact score + interpretation language
  alerts/            rule evaluation + channel registry
  cache/             Redis-if-available store with memory fallback
  pipeline/          orchestrator (job steps), scheduler, job registry
  services/          business query layer used by API + server components
drizzle/             NNNN_*.sql migrations
scripts/             migrate.mjs seed.mjs release.mjs demo-data.mjs smoke.mjs
tests/               vitest unit suites
```

Reads (`GET /api/events`, …) only read the database. All writes happen in the pipeline tick.

---

## Local quickstart

```bash
cp .env.example .env
docker compose up -d db redis     # Postgres + Redis
npm ci
npm run db:release                # run migrations, then seed demo data
npm run dev                       # http://localhost:3000
```

Useful scripts:

| Command | Purpose |
|---|---|
| `npm run build` | production build |
| `npm test` | vitest unit suites (no network/DB) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:migrate` | apply SQL migrations |
| `npm run db:seed` | idempotent demo seed (`--force` to reset) |
| `npm run db:release` | migrate then seed |
| `npm run smoke` | live acceptance harness (see below) |

### Full stack in Docker

```bash
docker compose up --build
```

The `app` container runs `node scripts/release.mjs` (migrations + seed) and then the standalone
server. `docker compose config -q` validates the compose file.

### Smoke harness

```bash
BASE_URL=http://127.0.0.1:3000 npm run smoke
```

Prints a `PASS/FAIL` table, scans every event string for advice language, checks all 16 event-detail
sections, and exits non-zero on any failure.

---

## Demo mode

Out of the box the app uses mock providers (`NEWS_PROVIDER=mock`, `MARKET_PROVIDER=mock`,
`FUNDAMENTAL_PROVIDER=mock`):

- **Backfill** (`NEWS_MODE=backfill`) — deterministic articles for the last five trading days, used
  by the seed. A fixed-seed PRNG means the dataset is identical every run.
- **Live** (`NEWS_MODE=live`) — each pipeline tick emits a few plausible articles from a scenario
  bank (earnings beat/miss, guidance raise/cut, analyst changes, product, partnership, contract,
  regulation, lawsuit, M&A, buyback, dividend, insider transaction, offering, macro print).
- **Market** — GBM random walk seeded per ticker with a shared market factor, a sector factor,
  session-aware U-shaped volume, and event-driven jumps so reaction windows are measurable.

The mock providers are selected through `lib/providers/index.ts`, a registry. Pointing at a real
vendor means implementing the same `NewsProvider` / `MarketDataProvider` / `FundamentalDataProvider`
interfaces and registering them there — no caller changes.

---

## Pipeline

Each tick runs nine idempotent steps, recorded in `pipeline_jobs`
(`UNIQUE(run_id, name)`, max 3 attempts, exponential backoff):

1. `fetch_news` — `NewsProvider.list` → upsert `news_articles` by `hash`
2. `normalize_news` — trim/normalise, resolve source, stamp `published_at`, derive session
3. `detect_ticker` — cashtag/name/symbol detection against the active universe
4. `classify_event` — LLM in batches of ≤10 with strict schema validation; falls back to
   `classifyByRules()` (marked `rules`/`hybrid`)
5. `deduplicate_event` — cluster into canonical `market_events`
6. `fetch_market_data` — snapshots into price/volume/technical/macro tables
7. `calculate_market_reaction` — reaction windows, RVOL, relative strength
8. `calculate_impact_score` — deterministic score + components (delete+insert = idempotent)
9. `evaluate_alerts` — rule matching with per-rule cooldown

`runPipelineTick` is guarded by an advisory lock so concurrent triggers skip instead of
double-processing. The in-process scheduler (`lib/pipeline/scheduler.ts`, started from
`instrumentation.ts` when `PIPELINE_AUTORUN=1`) catches all errors so a failure can never crash
the server.

---

## Impact score (algorithm `impact-v1`)

Weights sum to 100. `points = round(normalized × weight × 10) / 10`, `score = round(sum × 10) / 10`,
clamped 0..100. Missing inputs normalize to 0 and are labelled "not available".

| Component | Weight | Normalized from |
|---|---|---|
| `freshness` | 15 | age ≤5m→1.0, ≤30m→0.8, ≤2h→0.5, ≤6h→0.25, ≤24h→0.1, >24h→0 |
| `source_quality` | 10 | source `quality_score` (0..1) |
| `company_relevance` | 10 | relevance (0..1) |
| `event_importance` | 20 | `EVENT_TYPE_BASE_IMPORTANCE[type] × event_importance` |
| `surprise_magnitude` | 15 | abs(weighted surprise %) piecewise 0→0 … ≥20→1.0 |
| `price_reaction` | 10 | abs(reaction %) piecewise 0.5%→0.3 … ≥5%→1.0 |
| `relative_volume` | 10 | RVOL piecewise 1.0→0 … ≥5→1.0 |
| `relative_strength` | 5 | abs(stock − benchmark pp) 0.5→0.4 … ≥2→1.0 |
| `sector_confirmation` | 5 | sign agreement × ETF move 0.3%→0.4 … ≥1.5%→1.0 |

Bands: ≥80 `high`, 60–79.9 `elevated`, 40–59.9 `moderate`, 20–39.9 `low`, <20 `minimal`.

---

## API

All list endpoints accept `?limit=` (1..100, default 25) and `&offset=` (default 0) and return
`{ data, page, generated_at }`. Unknown query params return `400 validation_error`. Reads never
mutate.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | never 500s; unreachable DB → `degraded` |
| GET | `/api/events` | filters: `ticker`, `sector`, `event_type`, `min_impact`, `max_impact`, `source`, `max_age_minutes`, `session`, `catalyst_direction`, `q`, `sort` |
| GET | `/api/events/{id}` | `{ data: { event, detail } }`, 404 `not_found` |
| GET | `/api/stocks/{ticker}` | quote, technical, expectations, earnings, latest events, related |
| GET | `/api/stocks/{ticker}/events` | event list with ticker fixed |
| GET | `/api/watchlists` | watchlists with computed per-stock rows |
| POST | `/api/watchlists` | `{ name, description? }` → 201, 409 on duplicate |
| GET/PATCH/DELETE | `/api/watchlists/{id}` | |
| POST | `/api/watchlists/{id}/stocks` | `{ ticker }` → 201 |
| DELETE | `/api/watchlists/{id}/stocks/{ticker}` | 204 / 404 |
| GET | `/api/alerts` | rules + recent triggers |
| POST | `/api/alerts` | `{ name, conditions, channels, … }` → 201, rate-limited |
| PATCH/DELETE | `/api/alerts/{id}` | |
| GET | `/api/market/context` | indices, sectors, macro, regime, breadth |
| GET | `/api/sectors/{slug}` | sector detail + top events |
| GET | `/api/pipeline/status` | scheduler + recent runs |
| POST | `/api/pipeline/run` | worker entrypoint; rate-limited |
| GET | `/api/replay` | `?date=YYYY-MM-DD` |
| GET | `/api/search` | `?q=` ticker + event quick search |

Error envelope: `{ error, code, fields? }` with
`code ∈ validation_error | not_found | conflict | internal_error | unavailable | rate_limit`.

---

## Cache / Redis

Redis is **optional**. Set `REDIS_URL` to use a tiny dependency-free RESP client; otherwise the app
uses an in-process `Map` with TTL. The cache is **never a source of truth** — every read path
re-reads Postgres on a miss, so a Redis outage cannot corrupt or lose event data. Rate limiting
(`POST /api/alerts`, `POST /api/pipeline/run`, 30/min per IP) uses the same store.

---

## Tests

```bash
npm test          # vitest run
npm run typecheck # tsc --noEmit
```

Suites cover impact scoring, RVOL, surprise math, dedup, ticker detection, reaction windows,
technicals, relative strength, alerts, language (no-advice), demo-data determinism, cache, format
helpers, and API DTO contracts. No network or database is touched.

---

## Deploy on Nrapken Quick

1. Attach a Postgres DBaaS. The platform injects `DATABASE_URL` (and `DB_*`) — never hardcode
   credentials.
2. Release command: `node scripts/release.mjs` (runs migrations then the idempotent seed).
   `scripts/release.mjs` spawns its children itself, so the command needs no shell.
3. Environment:
   ```
   NEWS_MODE=live
   PIPELINE_AUTORUN=1
   PIPELINE_TICK_SECONDS=30
   # REDIS_URL optional
   ```
4. Optional `REDIS_URL` for a shared cache. Again: the cache is never a source of truth, so the app
   behaves identically without it.
5. The deployed artifact root is `.next/standalone`. `npm run build` copies `scripts/`, `drizzle/`
   and `node_modules/postgres` into it.

The app is designed to behave identically at `https://marketpulse.quick.nrapken.dev`.

---

## Product principles

1. No investment advice, ever — only observable evidence.
2. The final impact score is computed by deterministic code, never by the LLM.
3. Sentiment alone never decides importance.
4. Strong YoY growth is not automatically positive; everything is judged against expectations.
5. Ingestion/analysis never runs synchronously inside a user-facing read.
