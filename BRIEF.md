# MarketPulse — implementation brief

MarketPulse is a **real-time stock news intelligence dashboard for short-term traders**.
It ingests market news/events, classifies them, measures how the market actually reacted, scores
impact deterministically, and presents the evidence. It **never** tells the user to buy or sell.

This brief is the single source of truth. It is implemented in **three phases**; each phase is a
separate work order (the prompt tells you which phase to build). **Never change a frozen contract
from an earlier phase** — later phases depend on it.

---

## 0. Non-negotiable product principles

1. **No investment advice, ever.** No "BUY", "SELL", "Enter at", "Take profit", "target price",
   "recommendation", "should buy". Only observable evidence, e.g.
   *"Positive guidance surprise accompanied by elevated relative volume (2.8x) and stock
   outperformance versus the semiconductor sector."* Green/red = measured +/– market movement.
2. **The LLM never produces the final score.** Impact score is computed by deterministic code
   (`lib/scoring/impact.ts`). The LLM only extracts structured facts, and its output is validated
   against a strict zod schema before it is stored. Invalid output is *never* persisted.
3. **Sentiment alone never decides importance.** Sentiment (-1..1) is one input; event type,
   surprise vs expectations, and measured market reaction carry more weight.
4. **Strong YoY growth is not automatically a positive catalyst.** Everything is judged against
   *expectations* (surprise), not absolute growth.
5. **Ingestion/analysis never runs synchronously inside a user-facing read request.** Reads
   (`GET /api/events`, …) only read the database. All writes happen in the pipeline tick.

## 1. Stack (fixed — do not substitute)

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router) + React 19 + TypeScript (strict) |
| Styling | Tailwind CSS v4 (already configured via `@tailwindcss/postcss`) |
| ORM | Drizzle ORM 0.45 (`drizzle-orm/postgres-js`) + `postgres` 3.4 driver |
| Validation | zod 3.25 |
| Charts | `lightweight-charts` 5.x (client component only) |
| Tests | vitest 3 |
| DB | PostgreSQL (managed DBaaS on the Nrapken platform) |
| Cache | Redis **optional** — must degrade to in-process memory when `REDIS_URL` is absent |
| Workers | in-process pipeline scheduler + `POST /api/pipeline/run` (see §7) |

Everything is **already installed**; `package.json`, `tsconfig.json`, `next.config.mjs`,
`postcss.config.mjs`, `vitest.config.ts`, `.gitignore` exist. Add a dependency only if the brief
demands it.

### Platform constraints (hard)
- **Never** add `output: 'standalone'` to `next.config.mjs` — the platform patches it at build time.
- The release command runs **without a shell**: `node scripts/release.mjs` must spawn its children
  itself (see §3). No `&&`, no pipes, no shell metacharacters anywhere in `release_command`.
- The deployed artifact root is `.next/standalone`; the build script already copies `scripts/`,
  `drizzle/` and `node_modules/postgres` there. **Any new file the release command needs must be
  added to the copy list in `package.json` → `build`** (and only files that exist).
- Runtime env values are never readable back. `DATABASE_URL` + `DB_*` are injected by the platform
  when a database is attached — never hardcode credentials.
- Node 20 on the platform, Node 22 locally. Keep syntax compatible with Node 20.
- Keep `package-lock.json` committed (`npm ci` is the install command).

## 2. Director architecture

```
app/                    Next.js routes + API route handlers (thin: parse → service → envelope)
components/             UI components (no financial math here, ever)
lib/
  config.ts             zod-validated env → typed config (never read process.env elsewhere)
  logger.ts             structured JSON logging (level, msg, ts, event, duration_ms, ctx)
  errors.ts http.ts     AppError + response envelopes
  core/                 domain types + zod schemas (the shared contract)
  db/                   schema.ts (drizzle), client.ts, errors.ts, queries/*.ts
  providers/            NewsProvider | MarketDataProvider | FundamentalDataProvider + mock impls
  analysis/             ticker detection, LLM classification, dedup, surprise math
  market/               reaction windows, RVOL, relative strength, technicals, macro
  scoring/              deterministic impact score + interpretation language (+ no-advice guard)
  alerts/               rule evaluation + channel registry (telegram/discord/slack/email/webhook)
  cache/                Redis-if-available store (get/set/del/lock/rateLimit) with memory fallback
  pipeline/             orchestrator (job steps), scheduler, job registry
  services/             business query layer used by API routes and server components
drizzle/                NNNN_*.sql migrations
scripts/                migrate.mjs seed.mjs release.mjs demo-data.mjs smoke.mjs
tests/                  vitest unit suites
docker-compose.yml  Dockerfile  .env.example  README.md
```

Rules: financial math lives in `lib/market/**` + `lib/scoring/**` only. UI components receive
computed values. API route handlers contain no business logic.

---

## 3. Migrations, seed, release (platform contract)

- `drizzle/NNNN_name.sql` — plain SQL, applied in filename order, tracked in `_migrations`,
  wrapped in `sql.begin()` and guarded by `SELECT pg_advisory_lock(918273645)`.
  Use `CREATE TABLE IF NOT EXISTS`, `DO $$ ... EXCEPTION WHEN duplicate_object THEN NULL; END $$`
  for enum types, and `CREATE INDEX IF NOT EXISTS`. All statements must be re-runnable.
- `scripts/seed.mjs` — idempotent: if the seeded demo user already exists it prints
  `Demo data already present.` and exits 0. `--force` deletes only that dataset and re-seeds.
  Dependency-free ESM: **only `node:*` and `postgres` are importable** at release time.
  All sample data comes from `scripts/demo-data.mjs` (pure functions of a fixed-seed PRNG —
  never `Math.random()`, never `Date.now()` for dataset contents).
- `scripts/release.mjs` — spawns `migrate.mjs` then `seed.mjs` with `spawnSync(process.execPath, …,
  { stdio: "inherit", env: process.env })`, propagates exit codes.

---

## 4. Database schema (`drizzle/0000_init.sql` + `lib/db/schema.ts`)

UUID PKs (`gen_random_uuid()`), all rows carry `created_at`/`updated_at`
(`timestamptz NOT NULL DEFAULT now()`), FKs with explicit `ON DELETE`, and the indexes listed.
`lib/db/schema.ts` must mirror the SQL exactly (same names/casing) — it is the typed access layer.

**Core reference data**
- `users` (id, email unique-lower, display_name, is_demo, risk_profile?, prefs jsonb)
- `sectors` (id, slug unique, name, etf_symbol, description)
- `companies` (id, name, ticker unique, sector_id FK, exchange, country, cik, website, description,
  market_cap_usd numeric, employees int)
- `stocks` (id, company_id FK unique, ticker unique, is_active, universe bool, added_at)
- `news_sources` (id, slug unique, name, url, tier smallint 1..3, quality_score numeric(0..1),
  kind enum('wire','newspaper','press_release','sec_filing','analyst','social','exchange','macro'))

**Ingestion**
- `news_articles` (id, source_id FK, provider varchar, provider_article_id varchar,
  url text, headline text, body text, published_at timestamptz, fetched_at timestamptz,
  author, tickers_raw jsonb, hash varchar unique ← dedup fingerprint of the raw article,
  event_id FK NULL, is_primary bool, raw jsonb)
- `market_events` (id, canonical_article_id FK NULL, ticker FK stocks NULL (primary),
  company_id FK NULL, sector_id FK NULL, headline text, summary text,
  event_type enum(market_event_type), sentiment numeric(-1..1), catalyst_direction enum,
  company_relevance numeric(0..1), event_importance numeric(0..1),
  affected_tickers jsonb, affected_sectors jsonb, reasoning text,
  published_at timestamptz, dedupe_key varchar(unique when canonical),
  article_count int, analysis_source enum('llm','rules','hybrid'), llm_analysis jsonb,
  session enum('pre_market','regular','after_hours','closed'),
  latest_update_at timestamptz)
- `event_articles` (id, event_id FK, article_id FK, similarity numeric, is_primary bool,
  UNIQUE(event_id, article_id))
- `event_tickers` (id, event_id FK, ticker varchar, relation enum('primary','affected','peer',
  'sector','benchmark'), change_pct_since_publication numeric, is_direct bool,
  UNIQUE(event_id, ticker))

**Market data**
- `price_snapshots` (id, ticker, ts timestamptz, price numeric, session enum, change_pct_daily,
  gap_pct, vwap, high, low, open, prev_close, UNIQUE(ticker, ts))
- `volume_snapshots` (id, ticker, ts, cumulative_volume bigint, interval_volume bigint,
  expected_volume_to_date numeric, rvol numeric, UNIQUE(ticker, ts))
- `technical_snapshots` (id, ticker, ts, vwap, sma20, sma50, ema9, atr14, rsi14, prev_day_high,
  prev_day_low, day_high, day_low, dist_from_52w_high_pct, gap_pct, conditions jsonb,
  UNIQUE(ticker, ts))
- `options_snapshots` (id, ticker, ts, implied_volatility, iv_change, call_volume, put_volume,
  put_call_ratio, open_interest, unusual_activity bool, notes text — *optional data*, app must
  work with this table empty)

**Expectations / fundamentals**
- `fundamental_expectations` (id, ticker, fiscal_period varchar, metric enum('eps','revenue',
  'guidance'), consensus numeric, unit varchar, as_of timestamptz, source varchar,
  UNIQUE(ticker, fiscal_period, metric))
- `earnings_result` (id, ticker, event_id FK NULL, fiscal_period, reported_at timestamptz,
  eps_actual numeric, eps_consensus numeric, eps_surprise_pct numeric, revenue_actual numeric,
  revenue_consensus numeric, revenue_surprise_pct numeric, guidance_actual numeric,
  guidance_consensus numeric, guidance_surprise_pct numeric, yoy_revenue_growth_pct numeric,
  UNIQUE(ticker, fiscal_period))
- `macro_snapshots` (id, series enum('FED_FUNDS_RATE','CPI_YOY','PCE_YOY','NFP_CHANGE','UNEMPLOYMENT',
  'GDP_QOQ','US10Y','DXY','VIX','SP500','NASDAQ','SOXX'), ts, value numeric, previous_value numeric,
  change numeric, unit varchar, UNIQUE(series, ts))

**Scoring / alerts**
- `impact_scores` (id, event_id FK unique, score numeric(0..100), band enum('minimal','low',
  'moderate','elevated','high'), computed_at, algorithm_version varchar)
- `impact_score_components` (id, impact_score_id FK, key varchar, label varchar, raw numeric,
  normalized numeric(0..1), weight numeric, points numeric, explanation text,
  UNIQUE(impact_score_id, key))
- `alert_rules` (id, user_id FK, name, description, conditions jsonb, channels jsonb,
  enabled bool, cooldown_minutes int default 30, last_triggered_at, match_count int)
- `alert_events` (id, rule_id FK, event_id FK, triggered_at, matched_conditions jsonb,
  title text, body text, delivered_channels jsonb, status enum('pending','delivered','failed'))

**Watchlists**
- `watchlists` (id, user_id FK, name, description, is_default bool, UNIQUE(user_id, name))
- `watchlist_stocks` (id, watchlist_id FK, ticker varchar, note text, added_at,
  UNIQUE(watchlist_id, ticker))

**Pipeline bookkeeping**
- `pipeline_jobs` (id, run_id uuid, name varchar, status enum('pending','running','succeeded',
  'failed','skipped'), attempts int default 0, max_attempts int default 3, started_at, finished_at,
  duration_ms int, processed int default 0, error text, context jsonb,
  UNIQUE(run_id, name))
- `pipeline_runs` (id, trigger enum('scheduler','api','manual'), status, started_at, finished_at,
  duration_ms, events_created int, events_updated int, articles_ingested int,
  alerts_triggered int, error text, context jsonb)

Enums (create as PG enum types): `market_event_type` = EARNINGS, GUIDANCE, PRODUCT, CONTRACT,
PARTNERSHIP, M&A, ANALYST_UPGRADE, ANALYST_DOWNGRADE, REGULATION, LAWSUIT, MANAGEMENT, BUYBACK,
DIVIDEND, OFFERING, INSIDER_TRANSACTION, MACRO, OTHER. `catalyst_direction` = positive, negative,
neutral, mixed. `market_session` = pre_market, regular, after_hours, closed (also reused for
pipeline statuses where needed).

**Required indexes**: `news_articles(published_at DESC)`, `news_articles(event_id)`,
`market_events(ticker, published_at DESC)`, `market_events(event_type)`,
`market_events(published_at DESC)`, `market_events(created_at DESC)`,
`impact_scores(score DESC)`, `price_snapshots(ticker, ts DESC)`,
`volume_snapshots(ticker, ts DESC)`, `technical_snapshots(ticker, ts DESC)`,
`event_articles(article_id)`, `event_tickers(ticker)`, `alert_events(rule_id, triggered_at DESC)`,
partial unique on `market_events(dedupe_key)`.

---

## 5. Contracts (`lib/core/`)

### 5.1 Event types
`EVENT_TYPES` tuple + `EventType` union, with `EVENT_TYPE_LABELS` (human label, e.g.
`ANALYST_UPGRADE` → "Analyst Upgrade") and `EVENT_TYPE_BASE_IMPORTANCE` (0..1, see §6.1).

### 5.2 LLM extraction schema (strict)
`lib/analysis/classification-schema.ts`:
```ts
export const classificationSchema = z.object({
  ticker: z.string().regex(/^[A-Z][A-Z0-9.\-]{0,9}$/).nullable(),
  company: z.string().min(1).max(160).nullable(),
  event_type: z.enum(EVENT_TYPES),
  summary: z.string().min(10).max(600),
  sentiment: z.number().min(-1).max(1),
  catalyst_direction: z.enum(["positive", "negative", "neutral", "mixed"]),
  company_relevance: z.number().min(0).max(1),
  event_importance: z.number().min(0).max(1),
  source_quality: z.number().min(0).max(1),
  affected_tickers: z.array(z.string().regex(/^[A-Z][A-Z0-9.\-]{0,9}$/)).max(12),
  affected_sectors: z.array(z.string().max(60)).max(6),
  reasoning: z.string().min(10).max(1200),
}).strict();

export const classificationEnvelopeSchema = z.object({
  classifications: z.array(classificationSchema).max(20),
}).strict();
```

### 5.3 Event card DTO (used by every list endpoint + the UI)
```ts
type ImpactComponentDTO = {
  key: string; label: string; raw: number; normalized: number;
  weight: number; points: number; explanation: string;
};
type EventCardDTO = {
  id: string;
  ticker: string | null;
  company_name: string | null;
  sector: string | null;
  headline: string;
  summary: string;
  event_type: EventType;
  event_type_label: string;
  published_at: string;              // ISO
  news_age_minutes: number;          // non-negative
  source: { name: string; tier: number; quality_label: "high" | "medium" | "low" };
  sentiment: number;
  catalyst_direction: "positive" | "negative" | "neutral" | "mixed";
  relevance_score: number;           // company_relevance 0..1
  event_importance: number;
  analysis_source: "llm" | "rules" | "hybrid";
  impact: { score: number; band: ImpactBand; components: ImpactComponentDTO[]; algorithm_version: string };
  price: {
    last: number | null; change_pct_since_publication: number | null;
    session: MarketSession; gap_pct: number | null; rvol: number | null;
    vwap: number | null; atr_pct: number | null;
  };
  market: {
    sp500_change_pct: number | null; nasdaq_change_pct: number | null;
    sector_etf: { symbol: string; change_pct: number | null } | null;
  };
  related: { ticker: string; label: string; change_pct: number | null;
             relation: "peer" | "sector" | "benchmark" | "affected"; is_direct: boolean }[];
  interpretation: string;
  article_count: number;
  is_canonical: true;
  latest_update_at: string;
};
```
List envelope: `{ data: T[], page: { limit: number, offset: number, next_offset: number|null,
has_more: boolean, total: number }, generated_at: string, meta?: object }`.
Error envelope: `{ error: string, code: "validation_error"|"not_found"|"conflict"|"internal_error"|
"unavailable", fields?: Record<string,string> }`.

---

## 6. Algorithms (exact — deterministic, unit-tested)

### 6.1 Impact score — `lib/scoring/impact.ts` (algorithm_version = `impact-v1`)
Weights sum to 100. `points = round(normalized * weight * 10) / 10`; `score = round(sum(points) * 10)
/ 10`, clamped 0..100.

| key | weight | normalized from |
|---|---|---|
| `freshness` | 15 | age ≤5m→1.0, ≤30m→0.8, ≤2h→0.5, ≤6h→0.25, ≤24h→0.1, >24h→0 |
| `source_quality` | 10 | provider/source `quality_score` (tier1 ≥0.85, tier2 0.6–0.84, tier3 <0.6) |
| `company_relevance` | 10 | LLM/rules `company_relevance` (0..1) |
| `event_importance` | 20 | `EVENT_TYPE_BASE_IMPORTANCE[type]` × `event_importance` (both 0..1) |
| `surprise_magnitude` | 15 | from §6.3: abs(weighted surprise %) → 0→0, 2→0.35, 5→0.6, 10→0.85, ≥20→1.0 (piecewise-linear interpolation between those anchors) |
| `price_reaction` | 10 | abs(reaction from publication): 0.5%→0.3, 1%→0.55, 3%→0.8, ≥5%→1.0 (piecewise) |
| `relative_volume` | 10 | rvol: 1.0→0, 1.5→0.4, 2→0.6, 3→0.85, ≥5→1.0 (piecewise) |
| `relative_strength` | 5 | abs(stock − benchmark over the reaction window): 0.5%→0.4, ≥2%→1.0 |
| `sector_confirmation` | 5 | sign agreement between stock move and sector-ETF move scaled by the ETF move: 0.3%→0.4, ≥1.5%→1.0; 0 when signs disagree |

`EVENT_TYPE_BASE_IMPORTANCE`: EARNINGS 1.00, GUIDANCE 1.00, M&A 0.95, MACRO 0.85, REGULATION 0.80,
ANALYST_DOWNGRADE 0.70, LAWSUIT 0.65, OFFERING 0.60, PRODUCT 0.60, CONTRACT 0.60,
PARTNERSHIP 0.55, MANAGEMENT 0.50, BUYBACK 0.50, ANALYST_UPGRADE 0.45,
INSIDER_TRANSACTION 0.40, DIVIDEND 0.35, OTHER 0.25.

Bands: ≥80 `high`, 60–79.9 `elevated`, 40–59.9 `moderate`, 20–39.9 `low`, <20 `minimal`.
Every component carries a human `explanation` string (evidence, never advice).
`missing inputs` (e.g. no rvol) → that component's normalized value is 0 **and** its explanation
says `"not available"` — the score must still be produced, and the UI shows the gap.
`computeImpactScore()` is pure: same input → same output (a unit test asserts this).

Interpretation string builder `buildInterpretation()` in `lib/scoring/language.ts` combines
direction, surprise, RVOL, and relative strength into 1–2 sentences, e.g.
*"Positive guidance surprise (+6.3% vs consensus) accompanied by elevated relative volume (2.8x)
and outperformance of 0.6pp versus SOXX."* It must pass `assertNoAdvice()`.

### 6.2 Relative volume — `lib/market/rvol.ts`
`RVOL = cumulative_session_volume / expected_volume_to_same_time_of_day`.
Expected volume = mean of the last up-to-20 sessions' cumulative volume **at the same elapsed
minute since the open** (intraday time-adjusted). Fallback when no intraday history: previous
session full-day volume × `volumeProfileFraction(elapsedMinutes)` — a U-shaped piecewise-linear
curve (fast open ~13% in the first 30m, lunch trough, closing ramp) defined as a constant table
with interpolation. Sessions before the open → RVOL from the pre-market window; closed → daily RVOL.

### 6.3 Surprise math — `lib/analysis/surprise.ts`
`surprisePct = (actual - consensus) / |consensus| * 100`, guarded: `consensus === 0` or not finite →
`null` + reason `"no consensus"`; negative consensus produces a sign-correct value (document it).
Weighted surprise = `0.4*eps + 0.3*revenue + 0.3*guidance` over whichever values exist
(re-normalised by the weights actually present).

### 6.4 Reaction windows — `lib/market/reaction.ts`
For a publication timestamp, find the first snapshot at or after `published_at + W` for
W ∈ {1m, 5m, 15m, 30m, 60m, session close}; `reaction = (p_t - p_pub) / p_pub * 100`.
Missing window → `null` (never 0). Also return `volume`, `rvol`, `vwap`, `atr`, `gap_pct`
at publication and the peak/trough reaction in the first 60 minutes.

### 6.5 Relative strength — `lib/market/relative-strength.ts`
`stockReturn - benchmarkReturn` over the reaction window, for benchmarks SPX (SPY), NASDAQ (QQQ)
and the sector ETF (SOXX for semiconductors, XLK technology, XLC communication services, XLY
consumer discretionary, SMH/SOXX hardware). Benchmark map lives in one constant.

### 6.6 Deduplication — `lib/analysis/dedupe.ts`
Article fingerprint `sha256(ticker|provider|url-or-headline|published_date_hour)` for raw storage.
Event clustering: two classifications belong to the same canonical event when
**same primary ticker** AND **same event_type** AND `|published_at delta| ≤ 90 min` AND
(`tokenJaccard(headline) ≥ 0.45` OR `trigramSimilarity(headline) ≥ 0.6`).
Token normalisation: lowercase, strip punctuation/stopwords, split on `TICKER:` prefixes and
number-only tokens, keep cashtags. Canonical event = highest `(source_quality, -age)` member;
its headline/summary come from that member; `article_count` = cluster size; every member is linked
in `event_articles` with its similarity; `is_primary` on the earliest article.
A dedupe cache key (`event:dedupe:<ticker>:<event_type>:<bucket>`) is written to the cache store
(TTL 6h) to short-circuit repeats. Cache writes are best-effort — failures must never break ingest.

### 6.7 Technicals — `lib/market/technical.ts`
VWAP (session, from bars), SMA20, SMA50, EMA9, ATR(14) (Wilder smoothing), RSI(14) (Wilder).
`conditions` array from: `above_vwap`, `below_vwap`, `breaking_prev_day_high`,
`breaking_prev_day_low`, `unusual_volume` (session RVOL ≥ 2), `large_gap` (|gap| ≥ 2%).
All indicators are pure functions of a bar array — unit-tested against hand-computed values.
Never phrased as advice: labels are `"Breaking previous day high"`, not `"Breakout buy"`.

## 7. Pipeline & jobs — `lib/pipeline/`

Steps (each an idempotent function, recorded as a `pipeline_jobs` row with `UNIQUE(run_id, name)`,
`attempts`, `max_attempts=3`, exponential backoff 1s → 2s → 4s, retry only on transient errors):

1. `fetch_news` — `NewsProvider.list({ sinceMinutes })` → upsert `news_articles` by `hash`
   (unique; re-ingest of an existing article is a no-op → idempotent).
2. `normalize_news` — trim/normalise headline+body, resolve `news_sources` by slug, stamp
   `published_at`, derive `session`.
3. `detect_ticker` — cashtag/name/symbol detection in `lib/analysis/ticker-detect.ts`
   against the active universe; pure function, tested.
4. `classify_event` — LLM (`lib/analysis/classify.ts`) in batches of ≤10 headlines, strict schema
   validation; on any failure fall back to `classifyByRules()` (keyword + surprise based) and mark
   `analysis_source = 'rules'` (or `'hybrid'` when only some items came from the LLM).
5. `deduplicate_event` — §6.6 → canonical `market_events`.
6. `fetch_market_data` — `MarketDataProvider` snapshots → `price_snapshots`, `volume_snapshots`,
   `technical_snapshots`, `macro_snapshots` (upsert by `(ticker, ts)`).
7. `calculate_market_reaction` — §6.4/6.2/6.5 → update `market_events` + `event_tickers`.
8. `calculate_impact_score` — §6.1 → `impact_scores` + `impact_score_components` (delete+insert per
   event = idempotent).
9. `evaluate_alerts` — §8 → `alert_events` (respect `cooldown_minutes`; a rule fires at most once
   per cooldown, tracked by `last_triggered_at`).

`runPipelineTick({ trigger, steps?, force? })` orchestrates them, writes the `pipeline_runs` row,
returns the per-step report. Runs are guarded by `pg_try_advisory_lock(519_842_337)` so concurrent
triggers skip instead of double-processing (`status: 'skipped'`).
`lib/pipeline/scheduler.ts` starts a `setInterval` (default 30 s, `PIPELINE_TICK_SECONDS`) inside
the server process via `instrumentation.ts` (node runtime only, `PIPELINE_AUTORUN=1`), catching all
errors so a failure can never crash the server; it exposes `getSchedulerStatus()`.
Instrumentation must also never throw at boot when the DB is unreachable.

## 8. Alerts — `lib/alerts/`
`AlertConditions` zod schema: `impact_score_gte`, `impact_score_lte`, `news_age_minutes_lt`,
`rvol_gte`, `change_pct_gte`/`lte`, `tickers: string[]`, `event_types: EventType[]`,
`catalyst_direction: string[]`, `sectors: string[]` — all optional, at least one required.
`evaluateRule(rule, eventCard)` → `{ matches: boolean, matched: string[] }` (pure, tested).
Channels: registry `{ log, webhook, telegram, discord, slack, email }`; `log` and `webhook` are
implemented (webhook does a real `fetch` POST with 5 s timeout + 1 retry); telegram/discord/slack/
email are declared extension points that return `{ delivered: false, reason: "not_configured" }`
unless their env credentials exist (`ALERT_TELEGRAM_BOT_TOKEN`+`ALERT_TELEGRAM_CHAT_ID`,
`ALERT_DISCORD_WEBHOOK_URL`, `ALERT_SLACK_WEBHOOK_URL`, `SMTP_URL`).
`alert_events.status` records the aggregate delivery result.

## 9. Cache / Redis — `lib/cache/store.ts`
Interface: `get<T>(key)`, `set(key, value, ttlSeconds)`, `del(key)`, `incr(key, ttlSeconds)`,
`withLock(key, ttlSeconds, fn)`, plus namespaced helpers for `latest:<ticker>` market snapshots,
`event:dedupe:*`, `ratelimit:<bucket>`. Implementation: if `REDIS_URL` is set, use it over the raw
RESP protocol with a tiny dependency-free client (`node:net`, `AUTH`, `GET/SET/INCR/EXPIRE/DEL`,
one connection with reconnect, 1 s timeouts, all errors swallowed → fall back to memory); otherwise
an in-process `Map` with TTL. Documented guarantee: **the cache is never a source of truth**; every
read path re-reads Postgres on a cache miss, so a Redis outage cannot corrupt or lose event data.
Rate limiting uses `incr(key, 60)` per client IP on `POST /api/alerts` and `POST /api/pipeline/run`
(limit 30/min) returning HTTP 429 with `code: "unavailable"`… (use `429` + `error: "rate_limit"`).

## 10. Mock providers — `lib/providers/`
- `NewsProvider` (`list`, `byId`, `sourceCatalog`) → `MockNewsProvider` with two modes:
  (a) **historical backfill** — deterministic articles for the last 5 trading days from
  `scripts/demo-data.mjs` data (used by the seed); (b) **live stream** — each tick emits 1–3 new
  articles from a scenario bank (earnings beat/miss, guidance raise/cut, analyst upgrade/downgrade,
  product launch, partnership, contract win, regulatory probe, lawsuit, M&A rumour, buyback,
  dividend, insider sale, secondary offering, macro print) with realistic headline/body text and a
  tiered source. The mock must stay deterministic in backfill mode and plausibly noisy in live mode
  (live mode may use `Date.now()`).
- `MarketDataProvider` (`quote`, `bars`, `snapshot`) → `MockMarketProvider`: GBM random walk seeded
  per ticker, with a shared market factor (so SPY/QQQ and peers move together — real correlation),
  sector factor, session-aware volume (U-shaped intraday profile), and **event-driven jumps**: when
  a catalyst is classified, apply a direction-scaled jump over the following minutes so reaction
  windows are measurable. Anchor prices (approx): NVDA 178.40, AMD 172.10, TSM 268.30, AVGO 342.60,
  META 612.80, MSFT 489.20, AAPL 254.70, TSLA 402.30, SPY 592.10, QQQ 524.60, SOXX 254.80,
  XLK 268.10, XLC 104.20, XLY 218.40.
- `FundamentalDataProvider` (`expectations`, `earnings`) → `MockFundamentalProvider` returning
  plausible consensus/actual triples per ticker/fiscal period (the seed writes them to
  `fundamental_expectations`, `earnings_result`).
- `lib/providers/index.ts` selects the provider from config (`NEWS_PROVIDER=mock`, `MARKET_PROVIDER=mock`,
  `FUNDAMENTAL_PROVIDER=mock`) via a registry, so a paid vendor can be added without touching
  callers. Every provider interface is documented as async and total (never throws on missing data —
  returns `null`/empty and logs).

## 11. API — exact contract

Every list endpoint: `?limit=` (1..100, default 25) `&offset=` (default 0) → envelope with
`page.next_offset`; unknown query params → 400 `validation_error`. All handlers wrap errors with
`errorResponse()`. Reads never mutate. `export const dynamic = "force-dynamic"` on data routes.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | `{ status, version, uptime_seconds, database{configured,ok,latency_ms}, redis{configured,ok}, llm{configured,model,last_success_at,last_failure_reason}, providers{news,market,fundamental}, pipeline{last_run_at,last_status,last_duration_ms,runs_last_hour,failed_jobs}, counts{events,articles,stocks,sources} }` — never 500s; unreachable DB → `status: "degraded"` |
| GET | `/api/events` | filters: `ticker`, `sector`, `event_type` (repeatable/comma), `min_impact`, `max_impact`, `source`, `max_age_minutes`, `session`, `catalyst_direction`, `q`, `sort` (`impact_desc` default \| `published_desc` \| `impact_asc`) → `{ data: EventCardDTO[] }` |
| GET | `/api/events/{id}` | `{ data: { event: EventCardDTO, detail: EventDetailDTO } }`, 404 `not_found` |
| GET | `/api/stocks/{ticker}` | `{ data: { ticker, company_name, sector, exchange, quote{price,change_pct,session,gap_pct,rvol,vwap,atr_pct,day_high,day_low,prev_close}, technical, expectations[], earnings[], latest_events: EventCardDTO[], related[] } }` |
| GET | `/api/stocks/{ticker}/events` | same filter/pagination contract as `/api/events`, ticker fixed |
| GET | `/api/watchlists` | `{ data: WatchlistDTO[] }` incl. computed per-stock rows |
| POST | `/api/watchlists` | body `{ name, description? }` → 201, 409 on duplicate name |
| GET/PATCH/DELETE | `/api/watchlists/{id}` | PATCH `{ name?, description? }` |
| POST | `/api/watchlists/{id}/stocks` | `{ ticker }` → 201, 409 if present, 404 unknown ticker |
| DELETE | `/api/watchlists/{id}/stocks/{ticker}` | 204 / 404 |
| GET | `/api/alerts` | rules + recent `alert_events` |
| POST | `/api/alerts` | `{ name, conditions, channels, enabled?, cooldown_minutes? }` → 201 |
| PATCH/DELETE | `/api/alerts/{id}` | PATCH `{ enabled?, conditions?, name? }` |
| GET | `/api/market/context` | `{ data: { as_of, session, indices[], sectors[{slug,name,etf_symbol,change_pct,advancers,decliners,top_event}], macro{series→{value,previous,change,unit,as_of}}, regime{ label, description, evidence[] }, breadth } }` |
| GET | `/api/sectors/{slug}` | `{ data: { sector, etf{symbol,change_pct}, stocks[{ticker,price,change_pct,rvol,impact_score}], leaders[], laggards[], top_events: EventCardDTO[] } }` |
| GET | `/api/pipeline/status` | `{ data: { scheduler{enabled,interval_seconds,last_tick_at,next_tick_at}, recent_runs[], jobs{by_status} } }` |
| POST | `/api/pipeline/run` | body `{ trigger?, steps?, force? }` → `{ data: { run_id, status, duration_ms, steps[{name,status,duration_ms,processed,error}], events_created, events_updated, alerts_triggered } }` (the worker entrypoint; rate-limited) |
| GET | `/api/replay` | `?date=YYYY-MM-DD` → `{ data: { date, session_windows[], timeline[{ts,kind,label,event_id,impact_score,price}], series{ticker→bars[]} } }` |
| GET | `/api/search?q=` | tickers + events quick search for the command bar |

`EventDetailDTO` (sections, in this order): `overview`, `what_happened`, `why_it_matters`,
`expectation_vs_actual{eps_surprise_pct, revenue_surprise_pct, guidance_surprise_pct, expected{},
actual{}, note}`, `price_reaction{at_publication, reaction_1m, reaction_5m, reaction_15m,
reaction_30m, reaction_60m, reaction_daily, volume, rvol, vwap, atr_pct, gap_pct, peak_60m,
trough_60m}`, `volume_reaction{cumulative, expected_to_date, rvol, profile}`,
`sector_reaction{sector_etf, etf_change_pct, stock_vs_etf_pp, peers[]}`,
`related_stocks[]`, `technical{...}` + `technical.conditions[]`, `macro{...}` + `regime`,
`options` (nullable), `timeline[{ts,label,kind}]`, `sources[{title,url,source_name,tier,
published_at,is_primary}]`, `impact_breakdown`, `intraday{ bars[{time,open,high,low,close,volume}],
markers[{time,label,event_id,impact_score,catalyst_direction}] }`.

## 12. UI (Tailwind v4, dark institutional terminal)

Dark by default (`#080b10` page, `#0e1420` panels, `#1b2434` borders, text `#e6edf7`/`#8fa1bb`),
tabular numerals (`font-variant-numeric: tabular-nums`), compact rows, 1px hairlines, no shadows,
no gradients, no emoji. Accent = amber `#FFB000` for attention, `#3ddc84` green / `#ff5c5c` red
**only** for measured +/- movement, plus a small legend stating exactly that.

Pages:
1. `/` **Dashboard** — header strip (session pill, live clock, last pipeline tick, health dot,
   market regime chip, SPY/QQQ/SOXX/VIX strip), left rail (watchlists + sector filter + macro),
   centre ranked event feed, right rail (watchlist table, alert feed). Polls `/api/events` every
   10 s (`useEffect` + `setInterval`, abort on unmount, keep last good data on error, show a
   "stale" indicator). Ranked by impact score by default, not chronology.
2. `/events/[id]` **Event detail** — every section from `EventDetailDTO` in the specified order,
   impact-score breakdown as a horizontal bar list showing raw → normalized → points and the
   explanation, intraday `lightweight-charts` candlestick with vertical event markers, source list,
   timeline.
3. `/watchlists` — CRUD watchlists, add/remove tickers, per-row price / daily % / RVOL / latest
   catalyst + age / impact score.
4. `/alerts` — create rules with a condition builder, list rules with matched counts, recent
   triggered alerts, enable/disable.
5. `/macro` — macro series cards, sector heatmap table, regime explanation, breadth.
6. `/replay` — date picker + chronological scrubber over a historical day (event markers on the
   chart, event list on the right).
7. `/about` — the product principle (evidence not advice), the pipeline diagram, algorithm notes.

Shared components in `components/`: `EventCard`, `ImpactBadge`, `ImpactBreakdown`, `ScoreBar`,
`PriceCell`, `SessionPill`, `RvolPill`, `SourceBadge`, `CatalystPill`, `Sparkline` (inline SVG),
`IntradayChart` (client, lightweight-charts), `FilterBar`, `WatchlistTable`, `MacroStrip`,
`RegimeChip`, `Timeline`, `SourceList`, `EmptyState`, `ErrorState`, `LoadingRows`.
Every card must show the fields listed in the original product request (ticker, company, headline,
event type, published time, age, source + quality, sentiment, catalyst direction, relevance score,
impact score, price, price change since publication, session, RVOL, sector performance, market
performance) — and the example card for NVDA in the product request is the visual reference.
Mobile: single column, the rails collapse into tabs; `min-w-0` + horizontal scroll on tables.

## 13. Tests (`tests/**/*.test.ts`, vitest, no network/DB)
Required suites: `impact-score` (component math, band boundaries, determinism, missing-input
behaviour), `rvol` (time-of-day profile + fallback), `surprise` (normal/zero/negative consensus),
`dedupe` (merge same event from 3 sources; keep two distinct events apart; token/trigram edges),
`ticker-detect` (cashtag, company name, ambiguity, unknown symbol), `reaction` (window selection
with gaps, never 0 for missing), `technical` (VWAP/SMA/EMA/ATR/RSI hand-computed, conditions),
`relative-strength` (benchmark map), `alerts` (condition matching + cooldown), `language`
(`assertNoAdvice` over every interpretation/fixture string), `demo-data` (determinism + shape +
no advice + ≥8 tickers + ≥8 event types), `api-contract` (envelope + zod DTO parse of a fixture
EventCardDTO). Target ≥ 45 assertions across ≥ 12 files; `npm test` must be green.

## 14. Phase plan

- **PHASE 1 (data foundation)**: `drizzle/0000_init.sql`, `lib/db/*`, `lib/config.ts`,
  `lib/logger.ts`, `lib/errors.ts`, `lib/http.ts`, `lib/core/*`, `lib/providers/**`,
  `lib/cache/store.ts`, `scripts/*.mjs` + `scripts/demo-data.mjs`, tests for providers/demo-data/
  cache/surprise. `npm run build` must pass. No UI yet (keep `app/layout.tsx` + a placeholder
  `app/page.tsx`).
- **PHASE 2 (brain + API)**: `lib/analysis/**`, `lib/market/**`, `lib/scoring/**`, `lib/alerts/**`,
  `lib/pipeline/**`, `instrumentation.ts`, all API routes in §11, all remaining tests.
  `npm run build` + `npm test` must pass. Placeholder UI still.
- **PHASE 3 (UI + docs)**: every page in §12, `components/**`, `README.md`, `docker-compose.yml`,
  `Dockerfile`, `.env.example`, `scripts/smoke.mjs` (live API acceptance harness that prints a
  PASS/FAIL table and exits non-zero on failure). `npm run build` + `npm test` must pass.

## 15. Acceptance (what "done" means)
`docker compose up` locally → dashboard renders seeded events with impact scores, prices and
reactions; new simulated events keep arriving (pipeline scheduler); filters narrow the feed; the
event detail page shows the full breakdown + chart; watchlists and alerts are editable; `/api/health`
reports DB + pipeline state. Then the same app deployed on Nrapken Quick behaves identically at
`https://marketpulse.quick.nrapken.dev`.
