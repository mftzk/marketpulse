import { createHash } from "node:crypto";

/**
 * Pure helpers for the incremental tail of the pipeline (Phase 9).
 *
 * The market-reaction, impact-score and alert steps used to recompute every
 * recent event on every tick, one query per event. These helpers decide — from
 * data already read in a batched query — whether an event actually needs work,
 * and produce the deterministic hashes that make "has any input changed?" a
 * cheap comparison. Kept free of I/O so the decisions are unit-testable.
 */

export type EventTickerRelation = "primary" | "affected" | "peer" | "sector" | "benchmark";

// ---------------------------------------------------------------------------
// Deterministic hashing
// ---------------------------------------------------------------------------

/** Order-independent JSON so an object's key order can never change a hash. */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "null";
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (value instanceof Date) {
    return String(value.getTime());
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return "null";
}

export function hashInput(parts: unknown): string {
  return createHash("sha256").update(stableStringify(parts)).digest("hex");
}

/** Canonical numeric normalisation shared by every hash input. */
function num(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export interface ScoreInputHashFields {
  algorithmVersion: string;
  publishedAtMs: number | null;
  sourceQuality: number | null;
  companyRelevance: number | null;
  eventType: string;
  eventImportance: number | null;
  weightedSurprisePct: number | null;
  priceReactionPct: number | null;
  rvol: number | null;
  relativeStrengthPp: number | null;
  stockMovePct: number | null;
  etfMovePct: number | null;
  /** Quantised freshness (0..1) so the score only changes at a band boundary. */
  freshnessBucket: number | null;
}

/**
 * Fingerprint of every input that can change an `impact-v2` score. Raw reaction
 * values are included so a score is refreshed when the market moves, while the
 * freshness input is quantised so an ageing event does not trigger a rewrite on
 * every tick.
 */
export function scoreInputHash(fields: ScoreInputHashFields): string {
  return hashInput([
    "impact-score-v1",
    fields.algorithmVersion,
    fields.publishedAtMs,
    num(fields.sourceQuality),
    num(fields.companyRelevance),
    fields.eventType,
    num(fields.eventImportance),
    num(fields.weightedSurprisePct),
    num(fields.priceReactionPct),
    num(fields.rvol),
    num(fields.relativeStrengthPp),
    num(fields.stockMovePct),
    num(fields.etfMovePct),
    num(fields.freshnessBucket),
  ]);
}

/**
 * Quantised freshness band for a publication age in minutes (null age → null),
 * matching the documented §6.1 bands. The score's real freshness input is a
 * continuous piecewise-linear interpolation, so it must NOT be hashed directly
 * (it would change on every tick); the band changes only at a documented
 * boundary, and the score step additionally forces a refresh every
 * `RECOMPUTE_MS`, so a stored score is never more than that stale.
 */
export function freshnessBucket(ageMinutes: number | null): number | null {
  if (ageMinutes === null || !Number.isFinite(ageMinutes)) {
    return null;
  }
  const age = Math.max(0, ageMinutes);
  if (age <= 5) return 1.0;
  if (age <= 30) return 0.8;
  if (age <= 120) return 0.5;
  if (age <= 360) return 0.25;
  if (age <= 1440) return 0.1;
  return 0;
}

export interface AlertRuleFingerprintInput {
  id: string;
  updatedAt: Date | null;
  conditions: unknown;
  channels: unknown;
}

/** Stable fingerprint of the enabled rule set, so a rule edit invalidates skips. */
export function rulesFingerprint(rules: readonly AlertRuleFingerprintInput[]): string {
  const parts = rules
    .map((rule) => `${rule.id}:${rule.updatedAt?.getTime() ?? 0}:${stableStringify(rule.conditions)}:${stableStringify(rule.channels)}`)
    .sort();
  return hashInput(parts);
}

export interface AlertsStateHashFields {
  rulesFingerprint: string;
  ticker: string | null;
  eventType: string;
  catalystDirection: string | null;
  sector: string | null;
  impactScore: number | null;
  impactBand: string | null;
  rvol: number | null;
  changePct: number | null;
}

/**
 * Fingerprint of the fields an alert rule can match on. `news_age_minutes_lt`
 * is intentionally excluded: an ageing event only ever stops matching, and the
 * stored `alert_events.material_state` already prevents a repeat dispatch.
 */
export function alertsStateHash(fields: AlertsStateHashFields): string {
  return hashInput([
    "alerts-state-v1",
    fields.rulesFingerprint,
    fields.ticker,
    fields.eventType,
    fields.catalystDirection,
    fields.sector,
    num(fields.impactScore),
    fields.impactBand,
    num(fields.rvol),
    num(fields.changePct),
  ]);
}

// ---------------------------------------------------------------------------
// Incremental decisions
// ---------------------------------------------------------------------------

export interface ReactionRefreshInput {
  /** Tick time of the last reaction refresh, or null when never computed. */
  computedAt: Date | null;
  /** Newest market snapshot ts across the event's involved tickers. */
  latestInputTs: Date | null;
  publishedAt: Date | null;
  now: Date;
  /** Reaction window length (ms). */
  windowMs: number;
}

export interface RefreshDecision {
  needs: boolean;
  /** True when the reaction window has closed and the event can be frozen. */
  finalize: boolean;
}

/**
 * Decide whether an event's reaction must be (re)computed:
 *  - the window has closed (finalise once, then never again), or
 *  - it was never computed, or
 *  - a newer snapshot exists for one of its tickers.
 */
export function reactionRefreshDecision(input: ReactionRefreshInput): RefreshDecision {
  const closed =
    input.publishedAt !== null && input.now.getTime() >= input.publishedAt.getTime() + input.windowMs;
  if (closed) {
    return { needs: true, finalize: true };
  }
  if (input.computedAt === null) {
    return { needs: true, finalize: false };
  }
  if (input.latestInputTs !== null && input.latestInputTs.getTime() > input.computedAt.getTime()) {
    return { needs: true, finalize: false };
  }
  return { needs: false, finalize: false };
}

export interface ScoreRefreshInput {
  inputHash: string;
  storedHash: string | null;
  storedAlgorithmVersion: string | null;
  algorithmVersion: string;
  computedAt: Date | null;
  now: Date;
  /** Recompute cadence that keeps the freshness explanation bounded (ms). */
  minIntervalMs: number;
}

/** Only rewrite a score when an input changed (or it is due for a refresh). */
export function scoreRefreshDecision(input: ScoreRefreshInput): boolean {
  if (input.computedAt === null || input.storedAlgorithmVersion !== input.algorithmVersion) {
    return true;
  }
  if (input.storedHash === null || input.storedHash !== input.inputHash) {
    return true;
  }
  return input.now.getTime() - input.computedAt.getTime() >= input.minIntervalMs;
}

/** Only re-evaluate alerts when the state hash changed (or was never stored). */
export function alertsRefreshDecision(storedHash: string | null, currentHash: string): boolean {
  return storedHash === null || storedHash !== currentHash;
}

// ---------------------------------------------------------------------------
// Batching
// ---------------------------------------------------------------------------

export interface CappedBatch<T> {
  /** The items selected for this tick, at most `cap`. */
  selected: T[];
  /** Items left for a later tick because of the cap. */
  deferred: T[];
}

/** Split a deterministic, already-prioritised list into "this tick" and "next". */
export function takeWithinCap<T>(items: readonly T[], cap: number): CappedBatch<T> {
  const width = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : 0;
  if (width <= 0) {
    return { selected: [], deferred: [...items] };
  }
  return { selected: items.slice(0, width), deferred: items.slice(width) };
}

/** Split rows into chunks of at most `size` for a multi-row statement. */
export function chunk<T>(rows: readonly T[], size = 200): T[][] {
  if (rows.length === 0) {
    return [];
  }
  const width = Number.isFinite(size) && size > 0 ? Math.floor(size) : rows.length;
  const out: T[][] = [];
  for (let index = 0; index < rows.length; index += width) {
    out.push(rows.slice(index, index + width));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reaction spec assembly
// ---------------------------------------------------------------------------

export interface ReactionSpec {
  ticker: string;
  relation: EventTickerRelation;
  isDirect: boolean;
}

/**
 * The related set for one event: primary, classifier-affected, sector peers, the
 * sector ETF and the broad benchmarks — first occurrence wins, exactly as the
 * previous per-event loop built it.
 */
export function buildReactionSpecs(
  primary: string | null,
  affectedTickers: readonly string[] | null | undefined,
  peerTickers: readonly string[],
  sectorEtf: string | null,
  benchmarks: readonly string[],
): ReactionSpec[] {
  const specs = new Map<string, ReactionSpec>();
  const add = (ticker: string | null | undefined, relation: EventTickerRelation, isDirect: boolean): void => {
    if (!ticker || specs.has(ticker)) {
      return;
    }
    specs.set(ticker, { ticker, relation, isDirect });
  };

  add(primary, "primary", true);
  for (const affected of affectedTickers ?? []) {
    if (affected !== primary) {
      add(affected, "affected", true);
    }
  }
  for (const peer of peerTickers) {
    add(peer, "peer", false);
  }
  add(sectorEtf, "sector", false);
  for (const benchmark of benchmarks) {
    add(benchmark, "benchmark", false);
  }
  return [...specs.values()];
}
