import { surprisePct } from "@/lib/analysis/surprise";
import { config } from "@/lib/config";
import { logger } from "@/lib/logger";
import type { EarningsResult, ExpectationMetric, FundamentalDataProvider, FundamentalExpectation } from "@/lib/providers/types";

const BASE = "https://financialmodelingprep.com/stable";
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * Free-tier `/stable` keys reject `limit > 5` with an HTTP 402 premium body
 * ("values for 'limit' must be between 0 and 5"). A small limit is plenty for
 * recent announcements and keeps the adapter working across plan tiers.
 */
const ROW_LIMIT = "5";
/** A report may be filed a few days after the statement's filing date (weekends/holidays). */
const STATEMENT_DATE_TOLERANCE_DAYS = 3;
/** Negative results are cached briefly so a transient vendor outage recovers without hammering the quota. */
const DEGRADED_CACHE_TTL_MS = 5 * 60_000;

type Row = Record<string, unknown>;

export type FmpEndpoint = "analyst-estimates" | "earnings" | "income-statement";

export type FmpSourceState = "available" | "unavailable";

export interface FmpSourceHealth {
  endpoint: FmpEndpoint;
  state: FmpSourceState;
  /** HTTP status when the request reached the vendor, `null` on network/timeout/no credentials. */
  status: number | null;
  /** Machine-readable failure reason, `null` when available. */
  reason: string | null;
}

export interface FmpHealth {
  /** At least one of the core endpoints (`earnings` / `income-statement`) responded. */
  coreAvailable: boolean;
  /** Any endpoint was unavailable on the last load, or the analyst estimates fell back to annual. */
  degraded: boolean;
  /** `analyst-estimates` used the annual period because the quarterly one is a premium parameter. */
  estimatesFallback: boolean;
  sources: FmpSourceHealth[];
}

/** Per-symbol vendor health. One blocked symbol must never demote the whole feed. */
export interface FmpTickerHealth {
  ticker: string;
  /** At least one core endpoint responded for this symbol. */
  coreAvailable: boolean;
  degraded: boolean;
  estimatesFallback: boolean;
  /** HTTP status of the last core failure, `null` when available/never reached the vendor. */
  status: number | null;
  /** Machine-readable reason of the last core failure, `null` when available. */
  reason: string | null;
  checkedAt: Date;
  /** The plan is not entitled to this symbol and calls are being skipped. */
  unsupported: boolean;
}

/** Aggregate of the per-symbol health observed so far. */
export interface FmpHealthSummary {
  attempted: number;
  ok: number;
  degraded: number;
  degradedSymbols: string[];
  unsupportedSymbols: string[];
  /** The feed as a whole is down (every attempted symbol failed its core endpoints). */
  coreUnavailable: boolean;
}

interface EstimatesLoad {
  rows: Row[];
  source: string;
  available: boolean;
  fallback: boolean;
  status: number | null;
  reason: string | null;
}

interface FmpData {
  estimates: Row[];
  estimatesSource: string;
  reports: Row[];
  statements: Row[];
  health: FmpHealth;
  /** HTTP status of the last core failure, for the per-ticker health record. */
  coreStatus: number | null;
  /** Machine-readable reason of the last core failure. */
  coreReason: string | null;
  /** Both core endpoints failed with a subscription/entitlement signal. */
  unsupported: boolean;
}

/** Internal per-ticker record: the last load's health plus the failure status/reason. */
interface TickerRecord {
  health: FmpHealth;
  checkedAt: Date;
  status: number | null;
  reason: string | null;
}

type RequestResult =
  | { ok: true; rows: Row[] }
  | { ok: false; status: number | null; reason: string };

/**
 * Reasons that mean the plan is not entitled to a symbol/endpoint. These are a
 * permanent property of the subscription, unlike a timeout or a 5xx, so the
 * symbol is put on a long cooldown instead of being re-requested on every
 * refresh (which would burn the daily request budget for nothing).
 */
const UNSUPPORTED_REASONS = new Set(["premium_restricted", "not_entitled", "subscription_required"]);

function isUnsupportedFailure(reason: string | null): boolean {
  return reason !== null && UNSUPPORTED_REASONS.has(reason);
}

function num(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}
function str(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function parsedDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}
function parsedTimestamp(value: unknown): Date | null {
  if (typeof value !== "string" || !/[T ]\d{2}:\d{2}/.test(value)) return null;
  return parsedDate(value);
}
function periodKey(row: Row): string | null {
  const year = str(row.fiscalYear) ?? str(row.calendarYear);
  const period = str(row.period)?.toUpperCase();
  if (!year) return null;
  if (/^Q[1-4]$/.test(period ?? "")) return `${year}-${period}`;
  if (period === "FY") return `${year}-FY`;
  return null;
}
function statementDate(row: Row): string | null {
  return str(row.date) ?? str(row.fiscalDateEnding);
}
function currency(row: Row): string | null {
  return str(row.reportedCurrency) ?? str(row.currency);
}

/** Whole-day number for a date-ish value, used for tolerant date joins. */
function dayNumber(value: unknown): number | null {
  const date = parsedDate(value);
  return date ? Math.floor(date.getTime() / DAY_MS) : null;
}
function dayNumbers(...values: unknown[]): number[] {
  return values.map(dayNumber).filter((value): value is number => value !== null);
}
function statementFilingDays(statement: Row): number[] {
  return dayNumbers(statement.filingDate, statement.fillingDate, statement.acceptedDate);
}
function statementPeriodEndDays(statement: Row): number[] {
  return dayNumbers(statement.date, statement.fiscalDateEnding, statement.fiscalPeriodEnd);
}
function reportAnchorDays(report: Row): number[] {
  return dayNumbers(report.date, report.fiscalDateEnding, report.fiscalPeriodEnd);
}

/**
 * Ties an earnings report to the income statement it reports. The live `/stable`
 * `earnings` row carries no `fiscalDateEnding`, only the announcement `date`,
 * which equals the statement's `filingDate`. A ±3 day tolerance absorbs
 * weekend/holiday shifts; `fiscalDateEnding`/`fiscalPeriodEnd` are honoured when
 * a future plan provides them. Deterministic: ties keep the earliest statement
 * in provider order (newest first).
 */
function matchStatement(report: Row, statements: Row[]): Row | null {
  const anchors = reportAnchorDays(report);
  if (anchors.length === 0) return null;
  let best: { statement: Row; distance: number } | null = null;
  for (const statement of statements) {
    const candidates = [...statementFilingDays(statement), ...statementPeriodEndDays(statement)];
    let distance: number | null = null;
    for (const anchor of anchors) {
      for (const candidate of candidates) {
        const candidateDistance = Math.abs(anchor - candidate);
        if (distance === null || candidateDistance < distance) distance = candidateDistance;
      }
    }
    if (distance !== null && distance <= STATEMENT_DATE_TOLERANCE_DAYS) {
      if (!best || distance < best.distance) best = { statement, distance };
    }
  }
  return best?.statement ?? null;
}

function reasonForStatus(status: number, body: string): string {
  const text = body.slice(0, 200).toLowerCase();
  // A symbol the plan is not entitled to (AVGO on the verified key) answers 402
  // with "... not available under your current subscription". Classify it
  // distinctly so it is treated as permanently unsupported.
  if (text.includes("not entitled") || text.includes("not available under") || text.includes("subscription")) {
    return "not_entitled";
  }
  if (status === 402 || text.includes("premium") || text.includes("restricted")) return "premium_restricted";
  if (status === 401 || status === 403) return "auth_error";
  if (status === 429) return "rate_limited";
  return `http_${status}`;
}

/**
 * `/stable` returns HTTP 200 with a plain-text `Premium Query Parameter: …`
 * body for endpoints the plan cannot access. Treat any non-JSON body (and the
 * known premium/restricted wording) as an unavailable source, never as data.
 */
function reasonForText(body: string): string {
  const text = body.slice(0, 200).toLowerCase();
  if (text.includes("not entitled") || text.includes("not available under") || text.includes("subscription")) {
    return "not_entitled";
  }
  if (
    text.includes("premium") ||
    text.includes("restricted") ||
    text.includes("upgrade") ||
    text.includes("not available")
  ) {
    return "premium_restricted";
  }
  return "non_json";
}

/**
 * FMP adapter. Each underlying request is independent and total: a vendor
 * error, an HTTP failure, a non-JSON premium body or a timeout yields an empty
 * array plus a recorded reason instead of rejecting the load. Fiscal periods
 * come from FMP financial statements, never from announcement dates.
 */
export class FmpFundamentalProvider implements FundamentalDataProvider {
  private readonly cache = new Map<string, { promise: Promise<FmpData>; expiresAt: number }>();
  private readonly ttlMs: number;
  private readonly unsupportedCooldownMs: number;
  /**
   * Health is tracked PER TICKER. A single unsupported/blocked symbol (e.g. AVGO
   * on a plan that excludes it) must never be interpreted as "the feed is down".
   */
  private readonly healthByTicker = new Map<string, TickerRecord>();
  /** Ticker → epoch-ms until which vendor calls are skipped (entitlement cooldown). */
  private readonly unsupportedUntil = new Map<string, number>();

  constructor(
    private readonly apiKey: string | null,
    ttlMs: number = config.fmpCacheTtlMs,
    unsupportedCooldownMs: number = config.fmpUnsupportedCooldownMs,
  ) {
    this.ttlMs = Math.max(60_000, ttlMs);
    this.unsupportedCooldownMs = Math.max(0, unsupportedCooldownMs);
  }

  /**
   * Health of the most recently completed load, or `null` before the first load
   * finished. Kept for diagnostics; `coreUnavailable()` uses the per-ticker map.
   */
  health(): FmpHealth | null {
    let latest: TickerRecord | null = null;
    for (const record of this.healthByTicker.values()) {
      if (!latest || record.checkedAt.getTime() >= latest.checkedAt.getTime()) latest = record;
    }
    return latest?.health ?? null;
  }

  /** Per-symbol health, or `null` when the symbol has never been loaded. */
  tickerHealth(ticker: string): FmpTickerHealth | null {
    const record = this.healthByTicker.get(ticker);
    if (!record) return null;
    return {
      ticker,
      coreAvailable: record.health.coreAvailable,
      degraded: record.health.degraded,
      estimatesFallback: record.health.estimatesFallback,
      status: record.status,
      reason: record.reason,
      checkedAt: record.checkedAt,
      unsupported: this.isUnsupported(ticker),
    };
  }

  /** Aggregate across every symbol observed so far. */
  healthSummary(): FmpHealthSummary {
    let attempted = 0;
    let ok = 0;
    let degraded = 0;
    const degradedSymbols: string[] = [];
    const unsupportedSymbols: string[] = [];
    for (const [ticker, record] of this.healthByTicker) {
      attempted += 1;
      if (record.health.coreAvailable) {
        ok += 1;
      } else {
        degraded += 1;
        degradedSymbols.push(ticker);
      }
      if (this.isUnsupported(ticker)) unsupportedSymbols.push(ticker);
    }
    return {
      attempted,
      ok,
      degraded,
      degradedSymbols,
      unsupportedSymbols,
      coreUnavailable: this.coreUnavailable(),
    };
  }

  /**
   * True only when the feed as a whole is down: no symbol was ever attempted
   * with a key configured, or every attempted symbol failed its core endpoints.
   * A single unsupported symbol among working ones never demotes the feed.
   */
  coreUnavailable(): boolean {
    if (!this.apiKey) return false;
    if (this.healthByTicker.size === 0) return true;
    for (const record of this.healthByTicker.values()) {
      if (record.health.coreAvailable) return false;
    }
    return true;
  }

  private isUnsupported(ticker: string): boolean {
    const retryAt = this.unsupportedUntil.get(ticker);
    return retryAt !== undefined && Date.now() < retryAt;
  }

  private async request(
    endpoint: FmpEndpoint,
    ticker: string,
    params: Record<string, string> = {},
  ): Promise<RequestResult> {
    if (!this.apiKey) return { ok: false, status: null, reason: "not_configured" };
    const url = new URL(`${BASE}/${endpoint}`);
    url.searchParams.set("symbol", ticker);
    url.searchParams.set("apikey", this.apiKey);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    try {
      const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(config.providerHttpTimeoutMs) });
      const body = await response.text();
      if (!response.ok) {
        return { ok: false, status: response.status, reason: reasonForStatus(response.status, body) };
      }
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        return { ok: false, status: response.status, reason: reasonForText(body) };
      }
      if (!Array.isArray(payload)) {
        return { ok: false, status: response.status, reason: "unexpected_payload" };
      }
      return { ok: true, rows: payload as Row[] };
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      return {
        ok: false,
        status: null,
        reason: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network_error",
      };
    }
  }

  private logUnavailable(endpoint: FmpEndpoint, ticker: string, result: { status: number | null; reason: string }): void {
    logger.warn("fmp_source_unavailable", {
      endpoint,
      ticker,
      status: result.status,
      reason: result.reason,
    });
  }

  /**
   * Quarterly consensus is the preferred source. On a free-tier plan
   * `period=quarter` returns a premium plain-text body, so retry once with the
   * annual period (an acceptable fallback where a quarterly figure is missing)
   * and degrade to no expectations if that fails too.
   */
  private async loadEstimates(ticker: string): Promise<EstimatesLoad> {
    const quarterly = await this.request("analyst-estimates", ticker, { period: "quarter", page: "0", limit: ROW_LIMIT });
    if (quarterly.ok) {
      return { rows: quarterly.rows, source: "FMP quarterly analyst estimates", available: true, fallback: false, status: null, reason: null };
    }
    this.logUnavailable("analyst-estimates", ticker, quarterly);
    const annual = await this.request("analyst-estimates", ticker, { period: "annual", page: "0", limit: ROW_LIMIT });
    if (annual.ok) {
      return { rows: annual.rows, source: "FMP annual analyst estimates", available: true, fallback: true, status: quarterly.status, reason: quarterly.reason };
    }
    this.logUnavailable("analyst-estimates", ticker, annual);
    return { rows: [], source: "", available: false, fallback: false, status: annual.status, reason: annual.reason };
  }

  /**
   * A symbol inside its entitlement cooldown: return an empty, clearly-degraded
   * result without issuing any vendor request. The original failure status/reason
   * is retained so the symbol is still reported as degraded.
   */
  private skippedData(ticker: string): FmpData {
    const previous = this.healthByTicker.get(ticker);
    return {
      estimates: [],
      estimatesSource: "",
      reports: [],
      statements: [],
      health: { coreAvailable: false, degraded: true, estimatesFallback: false, sources: [] },
      coreStatus: previous?.status ?? null,
      coreReason: previous?.reason ?? "not_entitled",
      unsupported: true,
    };
  }

  private async fetchAll(ticker: string): Promise<FmpData> {
    if (this.isUnsupported(ticker)) return this.skippedData(ticker);

    const [earningsResult, statementsResult, estimates] = await Promise.all([
      this.request("earnings", ticker, { limit: ROW_LIMIT }),
      this.request("income-statement", ticker, { period: "quarter", limit: ROW_LIMIT }),
      this.loadEstimates(ticker),
    ]);
    if (!earningsResult.ok) this.logUnavailable("earnings", ticker, earningsResult);
    if (!statementsResult.ok) this.logUnavailable("income-statement", ticker, statementsResult);

    const earningsHealthy = earningsResult.ok;
    const statementsHealthy = statementsResult.ok;
    const coreAvailable = earningsHealthy || statementsHealthy;
    // Only a *permanent* entitlement failure of BOTH core endpoints marks the
    // symbol unsupported. A timeout / 5xx / network failure is transient and is
    // retried on the next cache miss.
    const unsupported =
      !coreAvailable &&
      isUnsupportedFailure(earningsResult.reason) &&
      isUnsupportedFailure(statementsResult.reason);
    if (unsupported) {
      this.unsupportedUntil.set(ticker, Date.now() + this.unsupportedCooldownMs);
    } else if (coreAvailable) {
      this.unsupportedUntil.delete(ticker);
    }

    const sources: FmpSourceHealth[] = [
      {
        endpoint: "earnings",
        state: earningsHealthy ? "available" : "unavailable",
        status: earningsHealthy ? null : earningsResult.status,
        reason: earningsHealthy ? null : earningsResult.reason,
      },
      {
        endpoint: "income-statement",
        state: statementsHealthy ? "available" : "unavailable",
        status: statementsHealthy ? null : statementsResult.status,
        reason: statementsHealthy ? null : statementsResult.reason,
      },
      {
        endpoint: "analyst-estimates",
        state: estimates.available ? "available" : "unavailable",
        status: estimates.available ? null : estimates.status,
        reason: estimates.available ? null : estimates.reason,
      },
    ];
    const health: FmpHealth = {
      coreAvailable,
      degraded: sources.some((source) => source.state === "unavailable") || estimates.fallback,
      estimatesFallback: estimates.fallback,
      sources,
    };
    const coreFailure = !earningsHealthy ? earningsResult : !statementsHealthy ? statementsResult : null;
    return {
      estimates: estimates.rows,
      estimatesSource: estimates.source,
      reports: earningsHealthy ? earningsResult.rows : [],
      statements: statementsHealthy ? statementsResult.rows : [],
      health,
      coreStatus: coreFailure?.status ?? null,
      coreReason: coreFailure?.reason ?? null,
      unsupported,
    };
  }

  private load(ticker: string): Promise<FmpData> {
    const cached = this.cache.get(ticker);
    if (cached && cached.expiresAt > Date.now()) return cached.promise;
    const result = this.fetchAll(ticker);
    const entry = { promise: result, expiresAt: Date.now() + this.ttlMs };
    this.cache.set(ticker, entry);
    void result
      .then((data) => {
        // Record health per ticker. A skipped (cooldown) load still records the
        // symbol as degraded, but must never extend its own cooldown.
        this.healthByTicker.set(ticker, {
          health: data.health,
          checkedAt: new Date(),
          status: data.coreStatus,
          reason: data.coreReason,
        });
        entry.expiresAt =
          Date.now() + (data.health.coreAvailable ? this.ttlMs : Math.min(this.ttlMs, DEGRADED_CACHE_TTL_MS));
      })
      .catch(() => {
        if (this.cache.get(ticker) === entry) this.cache.delete(ticker);
      });
    return result;
  }

  /** Analyst-estimate rows joined to their statement's fiscal period. */
  private estimatesByPeriod(data: FmpData): Map<string, Row> {
    const statementsByDate = new Map<string, Row>();
    const statementsByPeriod = new Map<string, Row>();
    for (const statement of data.statements) {
      const period = periodKey(statement);
      const date = statementDate(statement);
      if (period) statementsByPeriod.set(period, statement);
      if (date) statementsByDate.set(date, statement);
    }
    const result = new Map<string, Row>();
    for (const estimate of data.estimates) {
      const statement = statementsByDate.get(statementDate(estimate) ?? "")
        ?? (periodKey(estimate) ? statementsByPeriod.get(periodKey(estimate) as string) : undefined);
      const period = statement ? periodKey(statement) : periodKey(estimate);
      if (period) result.set(period, estimate);
    }
    return result;
  }

  /**
   * Earnings rows joined to an income statement via announcement/filing date.
   * A report that cannot be tied to a statement is dropped — the fiscal period
   * is never guessed from the announcement date.
   */
  private reportsByPeriod(data: FmpData): Map<string, { report: Row; statement: Row }> {
    const result = new Map<string, { report: Row; statement: Row }>();
    for (const report of data.reports) {
      const statement = matchStatement(report, data.statements);
      if (!statement) continue;
      const fiscalPeriod = periodKey(statement);
      if (!fiscalPeriod || result.has(fiscalPeriod)) continue;
      result.set(fiscalPeriod, { report, statement });
    }
    return result;
  }

  async expectations(ticker: string): Promise<FundamentalExpectation[]> {
    const data = await this.load(ticker);
    const statementsByDate = new Map<string, Row>();
    for (const statement of data.statements) {
      const date = statementDate(statement);
      if (date) statementsByDate.set(date, statement);
    }

    const byKey = new Map<string, FundamentalExpectation>();
    const upsert = (
      metric: ExpectationMetric,
      fiscalPeriod: string,
      consensus: number,
      row: Row,
      reportedCurrency: string | null,
      source: string,
      asOf: Date | null,
    ): void => {
      byKey.set(`${fiscalPeriod}:${metric}`, {
        ticker,
        fiscalPeriod,
        metric,
        consensus,
        unit: metric === "eps" ? "per share" : "full currency units",
        asOf,
        source,
        currency: reportedCurrency,
        epsType: str(row.epsType),
      });
    };

    // Analyst estimates are optional enrichment. The quarterly figure is
    // preferred; the annual fallback fills in whatever period it can be tied to.
    for (const row of data.estimates) {
      const statement = statementsByDate.get(statementDate(row) ?? "");
      const fiscalPeriod = statement ? periodKey(statement) : periodKey(row);
      if (!fiscalPeriod) continue;
      const reportedCurrency = currency(statement ?? row);
      const eps = num(row.epsAvg ?? row.estimatedEpsAvg ?? row.estimatedEps);
      const revenue = num(row.revenueAvg ?? row.estimatedRevenueAvg ?? row.estimatedRevenue);
      if (eps !== null) upsert("eps", fiscalPeriod, eps, row, reportedCurrency, data.estimatesSource, parsedDate(row.lastUpdated ?? row.updatedAt));
      if (revenue !== null) upsert("revenue", fiscalPeriod, revenue, row, reportedCurrency, data.estimatesSource, parsedDate(row.lastUpdated ?? row.updatedAt));
    }

    // The earnings report's own estimate is the primary consensus: it exists on
    // every plan, unlike the premium quarterly analyst-estimates parameter.
    for (const [fiscalPeriod, { report, statement }] of this.reportsByPeriod(data)) {
      const reportedCurrency = currency(statement);
      const eps = num(report.epsEstimated ?? report.estimatedEPS);
      const revenue = num(report.revenueEstimated ?? report.estimatedRevenue);
      const asOf = parsedDate(report.lastUpdated ?? report.date);
      if (eps !== null) upsert("eps", fiscalPeriod, eps, report, reportedCurrency, "FMP earnings report estimates", asOf);
      if (revenue !== null) upsert("revenue", fiscalPeriod, revenue, report, reportedCurrency, "FMP earnings report estimates", asOf);
    }

    return [...byKey.values()];
  }

  async earnings(ticker: string): Promise<EarningsResult[]> {
    const data = await this.load(ticker);
    const estimatesByPeriod = this.estimatesByPeriod(data);
    const reports = this.reportsByPeriod(data);
    return data.statements.flatMap((statement) => {
      const fiscalPeriod = periodKey(statement);
      if (!fiscalPeriod) return [];
      const statementCurrency = currency(statement);
      const reportRow = reports.get(fiscalPeriod)?.report;
      const estimates = estimatesByPeriod.get(fiscalPeriod);
      const statementEpsDiluted = num(statement.epsDiluted);
      const statementEps = num(statement.eps);
      const epsActual = num(reportRow?.epsActual) ?? statementEpsDiluted ?? statementEps;
      const revenueActual = num(reportRow?.revenueActual) ?? num(statement.revenue);
      if (epsActual === null && revenueActual === null) return [];
      const epsConsensus = num(reportRow?.epsEstimated ?? reportRow?.estimatedEPS)
        ?? num(estimates?.epsAvg ?? estimates?.estimatedEpsAvg ?? estimates?.estimatedEps);
      const revenueConsensus = num(reportRow?.revenueEstimated ?? reportRow?.estimatedRevenue)
        ?? num(estimates?.revenueAvg ?? estimates?.estimatedRevenueAvg ?? estimates?.estimatedRevenue);
      const reportedAt = parsedTimestamp(reportRow?.publishedDate ?? reportRow?.date)
        ?? parsedTimestamp(statement.filingDate ?? statement.fillingDate ?? statement.acceptedDate);
      const epsSurprisePct = epsActual !== null && epsConsensus !== null
        ? surprisePct(epsActual, epsConsensus).surprisePct : null;
      const revenueSurprisePct = revenueActual !== null && revenueConsensus !== null
        ? surprisePct(revenueActual, revenueConsensus).surprisePct : null;
      const consensusSource = reportRow && (num(reportRow.epsEstimated) !== null || num(reportRow.revenueEstimated) !== null)
        ? "FMP earnings report estimates"
        : estimates ? data.estimatesSource || "FMP analyst estimates" : null;
      return [{
        ticker,
        fiscalPeriod,
        reportedAt,
        epsActual,
        epsConsensus,
        epsSurprisePct,
        revenueActual,
        revenueConsensus,
        revenueSurprisePct,
        guidanceActual: null,
        guidanceConsensus: null,
        guidanceSurprisePct: null,
        yoyRevenueGrowthPct: null,
        epsUnit: "per share",
        epsCurrency: statementCurrency,
        epsType: str(reportRow?.epsType) ?? (statementEpsDiluted !== null ? "diluted" : statementEps !== null ? "reported EPS" : null),
        revenueUnit: "full currency units",
        revenueCurrency: statementCurrency,
        consensusSource,
      }];
    });
  }
}
