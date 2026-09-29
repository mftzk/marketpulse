import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FmpFundamentalProvider } from "@/lib/providers/fmp";
import { fundamentalFeedStatus } from "@/lib/providers";

/**
 * Phase 12 — per-ticker fundamental health. A single symbol the plan is not
 * entitled to (the verified key answers AVGO with HTTP 402 "not available under
 * your current subscription") must never demote the whole feed, must be reported
 * as degraded, and must stop consuming the request budget after the first
 * failure. Transient failures are still retried.
 */

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function okResponse(): Response {
  return jsonResponse([]);
}

/** The exact 402 body the verified key returns for symbols outside the plan. */
function premiumResponse(): Response {
  return new Response(
    "Premium Query Parameter: 'Special Endpoint : This value set for … not available under your current subscription'",
    { status: 402 },
  );
}

type ResponseFn = (ticker: string, endpoint: string) => Response;

function stubFetch(response: ResponseFn): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const endpoint = url.pathname.split("/").filter(Boolean).pop() ?? "";
      const ticker = url.searchParams.get("symbol") ?? "";
      return response(ticker, endpoint);
    }),
  );
}

async function loadTicker(provider: FmpFundamentalProvider, ticker: string): Promise<void> {
  await provider.expectations(ticker);
  await provider.earnings(ticker);
}

async function loadUniverse(provider: FmpFundamentalProvider, tickers: string[]): Promise<void> {
  for (const ticker of tickers) {
    await loadTicker(provider, ticker);
  }
}

describe("FMP per-ticker fundamental health", () => {
  it("keeps the feed LIVE when the unsupported symbol is the last one loaded", async () => {
    stubFetch((ticker) => (ticker === "AVGO" ? premiumResponse() : okResponse()));
    const provider = new FmpFundamentalProvider("fixture-key", 60_000, 60_000);

    // AVGO is loaded last — the exact order that used to flip the whole feed.
    await loadUniverse(provider, ["AAPL", "MSFT", "NVDA", "AVGO"]);

    expect(provider.coreUnavailable()).toBe(false);
    expect(fundamentalFeedStatus("fmp", "fixture-key", provider.coreUnavailable())).toBe("LIVE");

    const summary = provider.healthSummary();
    expect(summary.ok).toBe(3);
    expect(summary.degraded).toBe(1);
    expect(summary.degradedSymbols).toEqual(["AVGO"]);
    expect(summary.unsupportedSymbols).toEqual(["AVGO"]);
    expect(provider.tickerHealth("AVGO")).toMatchObject({ coreAvailable: false, unsupported: true });
    expect(provider.tickerHealth("AAPL")).toMatchObject({ coreAvailable: true, unsupported: false });
  });

  it("reports UNAVAILABLE only when every attempted symbol fails its core endpoints", async () => {
    stubFetch(() => premiumResponse());
    const provider = new FmpFundamentalProvider("fixture-key", 60_000, 60_000);

    await loadUniverse(provider, ["AAPL", "MSFT"]);

    expect(provider.coreUnavailable()).toBe(true);
    expect(fundamentalFeedStatus("fmp", "fixture-key", provider.coreUnavailable())).toBe("UNAVAILABLE");
    expect(provider.healthSummary()).toMatchObject({ attempted: 2, ok: 0, degraded: 2 });
  });

  it("treats a configured but never-attempted feed as core-unavailable, and no key as not", () => {
    expect(new FmpFundamentalProvider("fixture-key").coreUnavailable()).toBe(true);
    expect(new FmpFundamentalProvider(null).coreUnavailable()).toBe(false);
  });

  it("classifies a 402 premium body as unsupported but a timeout as transient", async () => {
    stubFetch(() => premiumResponse());
    const premium = new FmpFundamentalProvider("fixture-key", 60_000, 60_000);
    await premium.expectations("AVGO");
    expect(premium.tickerHealth("AVGO")).toMatchObject({ coreAvailable: false, unsupported: true });

    vi.unstubAllGlobals();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const error = new Error("timed out");
        error.name = "TimeoutError";
        throw error;
      }),
    );
    const transient = new FmpFundamentalProvider("fixture-key", 60_000, 60_000);
    await transient.expectations("NVDA");
    // Every attempted symbol failed here, so the feed is down — but the failure
    // is transient, so the symbol must not be parked on the entitlement cooldown.
    expect(transient.tickerHealth("NVDA")).toMatchObject({ coreAvailable: false, unsupported: false });
    expect(transient.coreUnavailable()).toBe(true);
  });

  it("skips vendor calls during the unsupported cooldown and retries after it expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-29T15:00:00Z"));

    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        calls.push(url.searchParams.get("symbol") ?? "");
        return url.searchParams.get("symbol") === "AVGO" ? premiumResponse() : okResponse();
      }),
    );

    const provider = new FmpFundamentalProvider("fixture-key", 60_000, 10 * 60_000);
    await provider.expectations("AVGO");
    const first = calls.length;
    expect(first).toBeGreaterThan(0);

    // Within the 60s degraded cache: no vendor calls.
    await provider.earnings("AVGO");
    expect(calls.length).toBe(first);

    // Cache expired but the 10min cooldown is still active: the symbol is still
    // reported degraded and no vendor request is issued.
    vi.advanceTimersByTime(61_000);
    await provider.earnings("AVGO");
    expect(calls.length).toBe(first);
    expect(provider.tickerHealth("AVGO")?.unsupported).toBe(true);

    // Cooldown expired: the symbol is retried.
    vi.advanceTimersByTime(10 * 60_000);
    await provider.earnings("AVGO");
    expect(calls.length).toBeGreaterThan(first);
  });

  it("bounds vendor calls to at most three per supported ticker per refresh", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        calls.push(url.searchParams.get("symbol") ?? "");
        return okResponse();
      }),
    );

    const universe = ["AAPL", "AMD", "META", "MSFT", "NVDA", "TSLA", "TSM"];
    const provider = new FmpFundamentalProvider("fixture-key", 60_000);
    await loadUniverse(provider, universe);

    expect(calls.length).toBe(universe.length * 3);
    for (const ticker of universe) {
      expect(calls.filter((symbol) => symbol === ticker)).toHaveLength(3);
    }
  });

  it("is independent of iteration order", async () => {
    const statusFor = async (order: string[]): Promise<boolean> => {
      vi.unstubAllGlobals();
      stubFetch((ticker) => (ticker === "AVGO" ? premiumResponse() : okResponse()));
      const provider = new FmpFundamentalProvider("fixture-key", 60_000, 60_000);
      await loadUniverse(provider, order);
      return provider.coreUnavailable();
    };

    expect(await statusFor(["AAPL", "MSFT", "AVGO"])).toBe(false);
    expect(await statusFor(["AVGO", "AAPL", "MSFT"])).toBe(false);
  });
});
