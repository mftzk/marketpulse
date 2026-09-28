import type {
  EarningsResult,
  ExpectationMetric,
  FundamentalDataProvider,
  FundamentalExpectation,
} from "@/lib/providers/types";

/**
 * Mock fundamental data provider (§10). Returns plausible consensus/actual
 * triples per ticker/fiscal period, deterministically derived from a seeded
 * PRNG so repeated calls for the same ticker agree.
 */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

const EPS_BASE: Record<string, number> = {
  NVDA: 0.81,
  AMD: 0.92,
  TSM: 2.24,
  AVGO: 1.42,
  META: 6.03,
  MSFT: 3.23,
  AAPL: 1.64,
  TSLA: 0.62,
};

const REVENUE_BASE: Record<string, number> = {
  NVDA: 35.1,
  AMD: 6.8,
  TSM: 23.5,
  AVGO: 14.2,
  META: 40.6,
  MSFT: 65.6,
  AAPL: 94.9,
  TSLA: 25.2,
};

const PERIODS = ["Q1", "Q2", "Q3", "Q4"];

export class MockFundamentalProvider implements FundamentalDataProvider {
  async expectations(ticker: string): Promise<FundamentalExpectation[]> {
    const rng = mulberry32(hashString(`fund:${ticker}:expectations`));
    const now = new Date();
    const year = now.getUTCFullYear();
    const results: FundamentalExpectation[] = [];

    for (const period of PERIODS) {
      const metrics: ExpectationMetric[] = ["eps", "revenue", "guidance"];
      for (const metric of metrics) {
        const base = metric === "eps" ? EPS_BASE[ticker] : REVENUE_BASE[ticker];
        if (typeof base !== "number") {
          continue;
        }
        const consensus = round(base * (0.94 + rng() * 0.12), 2);
        results.push({
          ticker,
          fiscalPeriod: `FY${year}${period}`,
          metric,
          consensus,
          unit: metric === "eps" ? "USD" : metric === "revenue" ? "B" : "USD",
          asOf: new Date(Date.UTC(year, 0, 1)),
          source: "analyst-consensus",
        });
      }
    }
    return results;
  }

  async earnings(ticker: string): Promise<EarningsResult[]> {
    const rng = mulberry32(hashString(`fund:${ticker}:earnings`));
    const now = new Date();
    const year = now.getUTCFullYear();
    const results: EarningsResult[] = [];

    for (const period of PERIODS) {
      const epsBase = EPS_BASE[ticker];
      const revenueBase = REVENUE_BASE[ticker];
      if (typeof epsBase !== "number" || typeof revenueBase !== "number") {
        continue;
      }
      const epsConsensus = round(epsBase * (0.94 + rng() * 0.12), 2);
      const epsActual = round(epsConsensus * (0.9 + rng() * 0.2), 2);
      const revenueConsensus = round(revenueBase * (0.94 + rng() * 0.12), 2);
      const revenueActual = round(revenueConsensus * (0.9 + rng() * 0.2), 2);
      const epsSurprise = epsConsensus !== 0 ? round(((epsActual - epsConsensus) / Math.abs(epsConsensus)) * 100, 1) : null;
      const revenueSurprise = revenueConsensus !== 0 ? round(((revenueActual - revenueConsensus) / Math.abs(revenueConsensus)) * 100, 1) : null;

      results.push({
        ticker,
        fiscalPeriod: `FY${year}${period}`,
        reportedAt: new Date(Date.UTC(year, 0, 1)),
        epsActual,
        epsConsensus,
        epsSurprisePct: epsSurprise,
        revenueActual,
        revenueConsensus,
        revenueSurprisePct: revenueSurprise,
        guidanceActual: null,
        guidanceConsensus: null,
        guidanceSurprisePct: null,
        yoyRevenueGrowthPct: round(5 + rng() * 25, 1),
      });
    }
    return results;
  }
}
