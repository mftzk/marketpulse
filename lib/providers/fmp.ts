import { surprisePct } from "@/lib/analysis/surprise";
import { config } from "@/lib/config";
import type { EarningsResult, ExpectationMetric, FundamentalDataProvider, FundamentalExpectation } from "@/lib/providers/types";

const BASE = "https://financialmodelingprep.com/stable";
type Row = Record<string, unknown>;
interface FmpData { estimates: Row[]; reports: Row[]; statements: Row[] }

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

/** FMP adapter. Fiscal periods come from FMP financial statements, never from announcement dates. */
export class FmpFundamentalProvider implements FundamentalDataProvider {
  private readonly cache = new Map<string, { promise: Promise<FmpData>; expiresAt: number }>();

  constructor(private readonly apiKey: string | null) {}

  private async get(path: string, ticker: string, params: Record<string, string> = {}): Promise<Row[]> {
    if (!this.apiKey) return [];
    const url = new URL(`${BASE}/${path}`);
    url.searchParams.set("symbol", ticker);
    url.searchParams.set("apikey", this.apiKey);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(config.providerHttpTimeoutMs) });
    if (!response.ok) throw new Error(`FMP request failed (${response.status})`);
    const value: unknown = await response.json();
    return Array.isArray(value) ? value as Row[] : [];
  }

  private load(ticker: string): Promise<FmpData> {
    const cached = this.cache.get(ticker);
    if (cached && cached.expiresAt > Date.now()) return cached.promise;
    const result = Promise.all([
      this.get("analyst-estimates", ticker, { period: "quarter", page: "0", limit: "100" }),
      this.get("earnings", ticker, { limit: "100" }),
      this.get("income-statement", ticker, { period: "quarter", limit: "40" }),
    ]).then(([estimates, reports, statements]) => ({ estimates, reports, statements }));
    const entry = { promise: result, expiresAt: Date.now() + 15 * 60_000 };
    this.cache.set(ticker, entry);
    void result.catch(() => {
      if (this.cache.get(ticker) === entry) this.cache.delete(ticker);
    });
    return result;
  }

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

  async expectations(ticker: string): Promise<FundamentalExpectation[]> {
    const data = await this.load(ticker);
    const statementsByDate = new Map<string, Row>();
    for (const statement of data.statements) {
      const date = statementDate(statement);
      if (date) statementsByDate.set(date, statement);
    }
    const result: FundamentalExpectation[] = [];
    for (const row of data.estimates) {
      const statement = statementsByDate.get(statementDate(row) ?? "");
      const fiscalPeriod = statement ? periodKey(statement) : periodKey(row);
      // The estimates response date is a fiscal-period end, not a report date.
      // If it cannot be tied to a statement period, keep it out of event matching.
      if (!fiscalPeriod) continue;
      const reportedCurrency = currency(statement ?? row);
      const eps = num(row.epsAvg ?? row.estimatedEpsAvg ?? row.estimatedEps);
      const revenue = num(row.revenueAvg ?? row.estimatedRevenueAvg ?? row.estimatedRevenue);
      for (const [metric, consensus] of [["eps", eps], ["revenue", revenue]] as [ExpectationMetric, number | null][]) {
        if (consensus === null) continue;
        result.push({
          ticker,
          fiscalPeriod,
          metric,
          consensus,
          unit: metric === "eps" ? "per share" : "full currency units",
          asOf: parsedDate(row.lastUpdated ?? row.updatedAt),
          source: "FMP quarterly analyst estimates",
          currency: reportedCurrency,
          epsType: str(row.epsType),
        });
      }
    }
    return result;
  }

  async earnings(ticker: string): Promise<EarningsResult[]> {
    const data = await this.load(ticker);
    const estimatesByPeriod = this.estimatesByPeriod(data);
    const statementsByDate = new Map<string, Row>();
    for (const statement of data.statements) {
      const date = statementDate(statement);
      if (date) statementsByDate.set(date, statement);
    }
    const reportsByPeriod = new Map<string, Row>();
    for (const report of data.reports) {
      // Earnings `date` is an announcement date. Only join to a fiscal period
      // when the response itself supplies a fiscal-period key/end date.
      const periodEnd = str(report.fiscalDateEnding) ?? str(report.fiscalPeriodEnd);
      const matchingStatement = periodEnd ? statementsByDate.get(periodEnd) : undefined;
      const fiscalPeriod = periodKey(report) ?? (matchingStatement ? periodKey(matchingStatement) : null);
      if (fiscalPeriod) reportsByPeriod.set(fiscalPeriod, report);
    }
    return data.statements.flatMap((statement) => {
      const fiscalPeriod = periodKey(statement);
      if (!fiscalPeriod) return [];
      const statementCurrency = currency(statement);
      const reportRow = reportsByPeriod.get(fiscalPeriod);
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
        consensusSource: reportRow && (num(reportRow.epsEstimated) !== null || num(reportRow.revenueEstimated) !== null)
          ? "FMP earnings report estimates"
          : estimates ? "FMP quarterly analyst estimates" : null,
      }];
    });
  }
}
