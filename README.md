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
  auth/              password hashing, signed sessions, route policy
  cache/             Redis-if-available store with memory fallback
  pipeline/          orchestrator (job steps), scheduler, job registry
  services/          business query layer used by API + server components
middleware.ts        auth gate (Node runtime; no DB access)
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

Sign in with the account created by the seed. Set `ADMIN_EMAIL` (default
`zakaria@nrapken.dev`), `ADMIN_DISPLAY_NAME` and **`ADMIN_PASSWORD`** in `.env`
before `npm run db:release`; the seed creates or refreshes that single account.
Without `ADMIN_PASSWORD` the seed still writes the market dataset but creates no
account.

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
BASE_URL=http://127.0.0.1:3000 SMOKE_PASSWORD=... npm run smoke
# SMOKE_EMAIL  (default: ADMIN_EMAIL, then zakaria@nrapken.dev)
# SMOKE_PASSWORD (no default; required)
```

The harness signs in first with the admin account, then runs its checks with the session cookie.
Without `SMOKE_PASSWORD` it prints `smoke: SMOKE_PASSWORD not set — cannot sign in` and exits
non-zero rather than measuring `401`s. Prints a `PASS/FAIL` table, verifies unauthenticated API
calls get `401` while `/api/health` stays public, scans every event string for advice language,
checks all 16 event-detail sections, and exits non-zero on any failure.

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

### Fundamental data on a free-tier FMP key

`FUNDAMENTAL_PROVIDER=fmp` uses the `/stable` API. The adapter is deliberately fault-tolerant per
endpoint — each request is independent and a vendor failure yields an empty result plus a recorded
reason (`fmp_source_unavailable` log line), never a rejected pipeline tick.

- **Primary consensus** comes from the `earnings` row (`epsEstimated` / `revenueEstimated`), which
  exists on every plan. Analyst estimates are optional enrichment: `analyst-estimates?period=quarter`
  is tried first and retried once with `period=annual` when the quarterly parameter is premium.
- **Fiscal-period join** ties an `earnings` row to an `income-statement` row by announcement/filing
  date (the live `earnings` payload has no `fiscalDateEnding`). A ±3 day tolerance absorbs
  weekend/holiday shifts and `fiscalDateEnding`/`fiscalPeriodEnd` are honoured when present. A row
  that cannot be tied to a statement is dropped — the fiscal period is never guessed.
- **Budget** — `FMP_CACHE_TTL_MS` (default 12h) caches the per-ticker load in process. A supported
  ticker costs at most 3 requests per refresh (`earnings` + `income-statement` + `analyst-estimates`);
  the 7 supported universe symbols are therefore ≤21 calls per 12h window (≈42/day), comfortably
  inside a 250-request/day free plan. A cached ticker makes zero additional vendor calls; a degraded
  result is cached for at most 5 minutes so it can recover. (If a plan serves the annual estimate
  fallback, that adds one extra `analyst-estimates` request for that symbol on the first load.)
- **Per-symbol health** — health is tracked per ticker, so one symbol the plan does not cover (the
  verified key answers `AVGO` with HTTP 402 *"not available under your current subscription"* on both
  core endpoints) is reported as `degraded`/`unsupported` without demoting the feed: the status stays
  `LIVE` as long as any symbol serves data, and only an outage affecting **every** attempted symbol
  (or a configured key with no load yet) reports `UNAVAILABLE`. After the first failure an
  unsupported symbol enters `FMP_UNSUPPORTED_COOLDOWN_MS` (default 24h) and is skipped without a
  vendor call; transient failures (timeout/5xx/network) are retried on the next refresh. Each refresh
  logs one `fundamental_refresh_degraded` line with `{tickers_ok, tickers_degraded, degraded_symbols}`
  (also surfaced in `/api/pipeline/status` step context).
- **Free-tier limits** — the free plan rejects `limit > 5` (HTTP 402), so the adapter requests
  `limit=5`; `analyst-estimates?period=quarter`, intraday charts (`historical-chart/1min`), batch
  quotes (`quote?symbol=A,B`) and `news/stock` also require a paid tier, and some symbols (e.g. the
  ETF `SMH`) are not covered at all. Those slots stay on mock; the fundamental adapter degrades
  gracefully.

The market and news slots remain on their mocks (`MARKET_PROVIDER=mock`, `NEWS_PROVIDER=mock`) while
FMP fundamentals run live.

### Live feed vs archived demo data

The seed writes a deterministic demo dataset (and `NEWS_MODE=backfill` replays it). Those rows stay
in the database and back the `/replay` archive, but the **live dashboard feed must show real news
only**. An event is *live-origin* when its canonical article exists and
`news_articles.data_status = 'LIVE'`; an event with no canonical article, or any other status
(`DEMO`, `REPLAY`, …), is *demo-origin*. `market_events` has no status column of its own — it is
derived from the canonical article via the same join the events read layer already uses.

Two reversible switches control the feed serving layer (`lib/services/feed-origin.ts`); the pipeline
and the stored rows are untouched:

| Var | Default | Meaning |
|---|---|---|
| `FEED_LIVE_ONLY` | `1` | When on, `GET /api/events` and its `page.total`/pagination exclude demo-origin events. Set to `0` to restore the previous (unfiltered) feed exactly. |
| `FEED_DEMO_MAX_ITEMS` | `0` | When live-only, allow at most this many of the *newest* demo-origin events back into the feed (e.g. `10`). Ignored when `FEED_LIVE_ONLY=0`. |

`GET /api/replay` and `/replay` are deliberately **not** filtered — they surface the archive. Search
and the per-ticker event list keep working; a ticker with only demo events returns an empty list. The
events response adds `meta.hidden_demo_events` (observability; the shape is otherwise unchanged).

---

## Authentication

Every page and API route requires a signed-in session by default. The public
exceptions are `/login`, `POST /api/auth/login` and `GET /api/health` (so the
uptime monitor keeps working). `middleware.ts` gates requests: API routes get a
JSON `401 unauthorized`, pages are redirected to `/login?next=<path>`.

- **Credentials** — `users.password_hash` stores a scrypt hash
  (`lib/auth/password.mjs`: N=16384, r=8, p=1, 64-byte key, random 16-byte salt).
  Plaintext is never stored, logged or returned.
- **Sessions** — stateless signed cookie `mp_session`:
  `base64url(JSON {uid,email,iat,exp}) + "." + HMAC-SHA256(body, SESSION_SECRET)`,
  verified with a constant-time comparison. Cookie is `httpOnly`, `sameSite=lax`,
  and `secure` when `APP_URL` starts with `https://`.
- **Rate limiting** — login is limited to 10 attempts / 5 min per IP+email via
  the cache store (memory fallback when Redis is absent).

| Variable | Meaning |
|---|---|
| `AUTH_ENABLED` | `1` (default) enforces the gate; `0` disables it (local-dev escape hatch) |
| `SESSION_SECRET` | HMAC signing key — **required and >= 32 chars** when auth is on |
| `ADMIN_EMAIL` | Email of the single seeded owner account (default `zakaria@nrapken.dev`) |
| `ADMIN_DISPLAY_NAME` | Display name of that account (default `Zakaria`) |
| `ADMIN_PASSWORD` | Password to create/refresh that account — **no default** |

Generate a secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

**The admin account.** The seed owns exactly one account. It is created/refreshed
from `ADMIN_EMAIL` / `ADMIN_DISPLAY_NAME` / `ADMIN_PASSWORD` (the default watchlist
and alert rules belong to it). `ADMIN_PASSWORD` is required to create the account:
there is no default and no generated password, and the plaintext is never logged.
When it is unset the seed prints
`seed: ADMIN_PASSWORD not set — skipping account creation` and still seeds the
market dataset, so local/CI runs need no secret.

**Rotate the password** by changing `ADMIN_PASSWORD` and re-running the seed;
it re-hashes and updates `password_hash` in place, leaving watchlists and alerts
untouched:

```bash
ADMIN_PASSWORD='new-secret' npm run db:seed
```

The seed is idempotent. On an existing deployment that still has the old demo
account (`trader@marketpulse.dev` / `demo@marketpulse.dev`), it first transfers
that account's watchlists and alert rules to the admin and then removes the
legacy row — the demo watchlist survives under the admin.

**Adding another user manually.** There is intentionally no signup endpoint. Hash
a password with the same module and insert the row:

```bash
node -e "import('./lib/auth/password.mjs').then((m) => console.log(m.hashPassword('your-password')))"
```

```sql
INSERT INTO users (email, display_name, password_hash) VALUES ('you@example.com', 'You', '<hash>');
```

---

## Pipeline

Each tick runs nine idempotent steps, recorded in `pipeline_jobs`
(`UNIQUE(run_id, name)`, max 3 attempts, exponential backoff):

1. `fetch_news` — `NewsProvider.list` → upsert `news_articles` by `hash`. The lookback window is
   `NEWS_LOOKBACK_MINUTES` (default 240). Vendor feeds return a single **ascending** page
   (`pageSize=100`), so a window wider than one page would only replay the oldest, already-stored
   articles and never see fresh ones; the step reports `fetched` and `ingested` independently and
   logs `news_window_saturated` when the page is full, advising a narrower window.
2. `normalize_news` — trim/normalise, resolve source, stamp `published_at`, derive session
3. `detect_ticker` — cashtag/name/symbol detection against the active universe
4. `classify_event` — LLM in batches of ≤10 with strict schema validation; falls back to
   `classifyByRules()` (marked `rules`/`hybrid`). The prompt sends the headline in full plus at
   most `LLM_MAX_ARTICLE_CHARS` characters of the body (default 1200, truncated on a sentence/word
   boundary, HTML stripped), and each call is logged with prompt chars, estimated tokens and
   latency so a timeout is diagnosable from logs alone. `LLM_TIMEOUT_MS` defaults to 45 s.
5. `deduplicate_event` — cluster into canonical `market_events`. The primary ticker is resolved
   against `stocks WHERE universe = true`: raw/affected tickers are tried first, then headline/body
   detection. A cluster whose named tickers are all out-of-universe is skipped (counted as
   `skipped_out_of_universe` and logged once per tick), `affected_tickers` is filtered to the
   universe, and a rejected insert is logged as `event_insert_rejected` without failing the step.
6. `fetch_market_data` — snapshots into price/volume/technical/macro tables
7. `calculate_market_reaction` — reaction windows, RVOL, relative strength
8. `calculate_impact_score` — deterministic score + components (delete+insert = idempotent)
9. `evaluate_alerts` — rule matching with per-rule cooldown

`runPipelineTick` is guarded by `pg_try_advisory_lock`, so concurrent triggers skip instead of
double-processing. Because the lock is **session-scoped**, the tick `reserve()`s one physical
connection from the pool and acquires/releases the lock on that same connection — using pooled
`db.execute()` sent the acquire and the unlock to different connections and leaked the lock
(production incident 2026-09-29). The in-process scheduler (`lib/pipeline/scheduler.ts`, started
from `instrumentation.ts` when `PIPELINE_AUTORUN=1`) catches all errors so a failure can never
crash the server.

Every tick runs under a hard deadline (`PIPELINE_TICK_DEADLINE_MS`, default 90 s). When exceeded
the in-flight job and the run are marked `failed`, the advisory lock is released and the tick
returns instead of hanging. A run left `running` longer than `max(3 × deadline, 5 min)` is
**stale**: the next tick marks it `failed` with `stale: holder disappeared`, and `/api/health` +
`/api/pipeline/status` expose `running` / `stale` booleans so an operator can tell "actually
working" from "wedged". `POST /api/pipeline/run` returns `202` immediately and runs the tick in
the background behind an in-process single-flight guard; pass `{ "wait": true }` (or `?wait=1`)
for the synchronous report.

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
| POST | `/api/auth/login` | `{ email, password }` → user + `mp_session` cookie; 401 on bad creds, 429 when rate-limited |
| POST | `/api/auth/logout` | clears the cookie |
| GET | `/api/auth/session` | current user, or 401 |
| GET | `/api/health` | public; never 500s; unreachable DB → `degraded` |
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
| GET | `/api/pipeline/status` | scheduler + recent runs + `running`/`stale` |
| POST | `/api/pipeline/run` | worker entrypoint; rate-limited; `202` async by default, `{ wait: true }` sync |
| GET | `/api/replay` | `?date=YYYY-MM-DD` |
| GET | `/api/search` | `?q=` ticker + event quick search |

Error envelope: `{ error, code, fields? }` with
`code ∈ validation_error | unauthorized | not_found | conflict | internal_error | unavailable | rate_limit`.
Every route except `/login`, `POST /api/auth/login` and `GET /api/health` requires a valid session.

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
   NEWS_LOOKBACK_MINUTES=240
   PIPELINE_AUTORUN=1
   PIPELINE_TICK_SECONDS=30
   PIPELINE_TICK_DEADLINE_MS=90000
   AUTH_ENABLED=1
   SESSION_SECRET=<at least 32 random characters>
   ADMIN_EMAIL=zakaria@nrapken.dev
   ADMIN_DISPLAY_NAME=Zakaria
   ADMIN_PASSWORD=<the owner's password>
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

---

## Deployment automation

`main` is deployed automatically. A Hermes cron job polls
`github.com/mftzk/marketpulse` every 10 minutes (`~/.hermes/scripts/marketpulse_watch.py`)
and then:

1. **merges** every open, non-draft pull request that GitHub reports as
   `MERGEABLE` and that has no failing checks (squash merge, branch deleted);
   drafts, conflicting PRs and PRs with red checks are never merged
   automatically — they get reported in chat instead;
2. **triggers a Quick build with auto-deploy** as soon as `main` moves, so a
   merged commit reaches `https://marketpulse.quick.nrapken.dev` within ~10
   minutes (the build itself takes ~3.5 minutes);
3. **reports** the merge/deploy in chat and stays silent when there is nothing
   to do — and it reports a failed build once, so a broken merge cannot fail
   silently.

The deployed revision is tracked in `~/.hermes/state/marketpulse-watch.json`, so a
commit is never deployed twice.
