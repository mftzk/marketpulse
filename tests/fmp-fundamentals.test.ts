import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FmpFundamentalProvider } from "@/lib/providers/fmp";
import { fundamentalFeedStatus } from "@/lib/providers";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function endpointOf(input: RequestInfo | URL): string {
  const url = new URL(String(input));
  return url.pathname.split("/").filter(Boolean).pop() ?? "";
}

describe("FMP free-tier fault tolerance", () => {
  it("treats a 200 plain-text premium body as unavailable and falls back to annual estimates", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const endpoint = endpointOf(input);
      const period = url.searchParams.get("period") ?? "";
      calls.push(`${endpoint}:${period}`);
      if (endpoint === "analyst-estimates" && period === "quarter") {
        // `/stable` returns HTTP 200 with a non-JSON premium body on free plans.
        return new Response("Premium Query Parameter: period=quarter", { status: 200 });
      }
      if (endpoint === "analyst-estimates" && period === "annual") {
        return jsonResponse([{ date: "2026-12-31", fiscalYear: "2026", period: "FY", epsAvg: 2.0, revenueAvg: 100 }]);
      }
      if (endpoint === "income-statement") {
        return jsonResponse([{
          date: "2026-09-30", filingDate: "2026-10-05", fiscalYear: "2026", period: "Q4",
          epsDiluted: 1.5, revenue: 50, reportedCurrency: "USD",
        }]);
      }
      return jsonResponse([{ date: "2026-10-05", epsActual: 1.6, epsEstimated: 1.5, revenueActual: 52, revenueEstimated: 50 }]);
    }));

    const provider = new FmpFundamentalProvider("fixture-key", 60_000);
    const expectations = await provider.expectations("NVDA");
    const earnings = await provider.earnings("NVDA");

    expect(calls).toContain("analyst-estimates:quarter");
    expect(calls).toContain("analyst-estimates:annual");
    expect(expectations.some((item) => item.fiscalPeriod === "2026-FY" && item.metric === "eps")).toBe(true);
    expect(earnings[0]).toMatchObject({ fiscalPeriod: "2026-Q4", epsActual: 1.6, epsConsensus: 1.5 });
    const health = provider.health();
    expect(health?.estimatesFallback).toBe(true);
    expect(health?.coreAvailable).toBe(true);
    expect(health?.degraded).toBe(true);
    expect(provider.coreUnavailable()).toBe(false);
  });

  it("survives a total outage without throwing and reports the core side unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Premium Query Parameter: nope", { status: 200 })));
    const provider = new FmpFundamentalProvider("fixture-key", 60_000);
    expect(await provider.expectations("NVDA")).toEqual([]);
    expect(await provider.earnings("NVDA")).toEqual([]);
    expect(provider.coreUnavailable()).toBe(true);
    expect(provider.health()?.coreAvailable).toBe(false);
    expect(provider.health()?.degraded).toBe(true);
  });

  it("treats a network failure as unavailable rather than rejecting", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("socket hang up"); }));
    const provider = new FmpFundamentalProvider("fixture-key", 60_000);
    expect(await provider.expectations("NVDA")).toEqual([]);
    const source = provider.health()?.sources.find((s) => s.endpoint === "earnings");
    expect(source).toMatchObject({ state: "unavailable", status: null, reason: "network_error" });
  });
});

describe("FMP fiscal-period join", () => {
  const NVDA_EARNINGS = [{
    symbol: "NVDA", date: "2026-08-26", epsActual: 2.22, epsEstimated: 2.09,
    revenueActual: 96_221_000_000, revenueEstimated: 92_270_940_000, lastUpdated: "2026-08-26T20:05:00Z",
  }];
  const NVDA_STATEMENT = [{
    date: "2026-07-26", filingDate: "2026-08-26", fiscalYear: "2027", period: "Q2",
    revenue: 96_221_000_000, epsDiluted: 2.22, reportedCurrency: "USD",
  }];

  function stub(earnings: unknown[], statements: unknown[]): void {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const endpoint = endpointOf(input);
      if (endpoint === "analyst-estimates") {
        return new Response("Premium Query Parameter: period=quarter", { status: 200 });
      }
      if (endpoint === "income-statement") return jsonResponse(statements);
      return jsonResponse(earnings);
    }));
  }

  it("joins by announcement/filing date and yields the fiscal period and surprise", async () => {
    stub(NVDA_EARNINGS, NVDA_STATEMENT);
    const provider = new FmpFundamentalProvider("fixture-key", 60_000);
    const expectations = await provider.expectations("NVDA");
    const earnings = await provider.earnings("NVDA");

    expect(earnings).toHaveLength(1);
    expect(earnings[0]).toMatchObject({
      fiscalPeriod: "2027-Q2",
      epsActual: 2.22,
      epsConsensus: 2.09,
      revenueActual: 96_221_000_000,
      revenueConsensus: 92_270_940_000,
    });
    expect(earnings[0].epsSurprisePct).toBeCloseTo(6.2201, 4);
    expect(earnings[0].revenueSurprisePct).toBeCloseTo(4.281, 2);
    expect(expectations.find((item) => item.metric === "eps")).toMatchObject({
      fiscalPeriod: "2027-Q2",
      consensus: 2.09,
      source: "FMP earnings report estimates",
    });
  });

  it("accepts a filing date within a ±3 day tolerance but not beyond it", async () => {
    stub([{ ...NVDA_EARNINGS[0], date: "2026-08-28" }], NVDA_STATEMENT);
    const provider = new FmpFundamentalProvider("fixture-key", 60_000);
    const near = await provider.earnings("NVDA");
    expect(near[0]?.fiscalPeriod).toBe("2027-Q2");
    expect(near[0]?.epsConsensus).toBe(2.09);
    expect(near[0]?.consensusSource).toBe("FMP earnings report estimates");

    vi.unstubAllGlobals();
    stub([{ ...NVDA_EARNINGS[0], date: "2026-09-08" }], NVDA_STATEMENT);
    const far = new FmpFundamentalProvider("fixture-key", 60_000);
    // The statement still yields a row from its own actuals, but the report is
    // too far from the filing date to be tied to it — no consensus is guessed.
    const [farRow] = await far.earnings("NVDA");
    expect(farRow?.epsConsensus).toBeNull();
    expect(farRow?.consensusSource).toBeNull();
  });

  it("accepts fiscalDateEnding when a future plan provides it", async () => {
    // Announcement date is far from the statement; only the supplied period end ties it.
    stub([{ date: "2026-05-01", fiscalDateEnding: "2026-07-26", epsActual: 2.22, epsEstimated: 2.09 }], NVDA_STATEMENT);
    const provider = new FmpFundamentalProvider("fixture-key", 60_000);
    expect((await provider.earnings("NVDA"))[0]?.fiscalPeriod).toBe("2027-Q2");
  });
});

describe("FMP request budget", () => {
  it("issues at most three calls per ticker per refresh, and zero on a cache hit", async () => {
    const calls: string[] = [];
    const limits: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      calls.push(endpointOf(input));
      if (url.searchParams.has("limit")) limits.push(url.searchParams.get("limit") as string);
      const endpoint = endpointOf(input);
      if (endpoint === "analyst-estimates") return jsonResponse([{ date: "2026-06-30", epsAvg: 1.25, revenueAvg: 33 }]);
      if (endpoint === "income-statement") {
        return jsonResponse([{ date: "2026-06-30", filingDate: "2026-08-10", fiscalYear: "2026", period: "Q2", epsDiluted: 1.3, revenue: 34 }]);
      }
      return jsonResponse([{ date: "2026-08-10", epsActual: 1.3, epsEstimated: 1.25, revenueActual: 34, revenueEstimated: 33 }]);
    }));

    const provider = new FmpFundamentalProvider("fixture-key", 60_000);
    await provider.expectations("NVDA");
    expect(calls).toHaveLength(3);
    expect(new Set(calls).size).toBe(3);
    // The free plan rejects limit > 5 with an HTTP 402 premium body.
    expect(limits.length).toBeGreaterThan(0);
    expect(limits.every((limit) => Number(limit) <= 5)).toBe(true);

    await provider.earnings("NVDA");
    await provider.expectations("NVDA");
    expect(calls).toHaveLength(3);
  });

  it("caches a degraded (total-outage) result so a second call makes no vendor request", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      calls.push(endpointOf(input));
      return new Response("Premium Query Parameter: nope", { status: 200 });
    }));
    const provider = new FmpFundamentalProvider("fixture-key", 60_000);
    await provider.expectations("NVDA");
    const afterFirst = calls.length;
    await provider.earnings("NVDA");
    expect(calls).toHaveLength(afterFirst);
    expect(afterFirst).toBeGreaterThan(0);
  });
});

describe("fundamental feed status", () => {
  it("maps mock, missing credentials, healthy and core-broken states", () => {
    expect(fundamentalFeedStatus("mock", null, false)).toBe("DEMO");
    expect(fundamentalFeedStatus("fmp", null, false)).toBe("UNAVAILABLE");
    expect(fundamentalFeedStatus("fmp", "fixture-key", false)).toBe("LIVE");
    // The quarterly analyst-estimates premium parameter alone keeps LIVE; only a
    // total failure of the core earnings/statements side demotes the feed.
    expect(fundamentalFeedStatus("fmp", "fixture-key", true)).toBe("UNAVAILABLE");
  });
});
