import { describe, expect, it } from "vitest";

import { detectTickers, detectTickerSymbols } from "@/lib/analysis/ticker-detect";

const UNIVERSE = [
  { ticker: "NVDA", name: "NVIDIA" },
  { ticker: "AMD", name: "Advanced Micro Devices" },
  { ticker: "TSM", name: "Taiwan Semiconductor", aliases: ["TSMC"] },
  { ticker: "MSFT", name: "Microsoft" },
];

describe("cashtags", () => {
  it("detects $NVDA", () => {
    const result = detectTickers("Chip stocks rallied as $NVDA hit a record.", UNIVERSE);
    expect(result.map((d) => d.ticker)).toContain("NVDA");
    expect(result.find((d) => d.ticker === "NVDA")?.source).toBe("cashtag");
  });
});

describe("bare symbols with word boundaries", () => {
  it("detects an uppercase ticker token", () => {
    const result = detectTickers("NVDA rallied today.", UNIVERSE);
    expect(result.map((d) => d.ticker)).toContain("NVDA");
  });

  it("does not match a ticker inside another word", () => {
    const result = detectTickerSymbols("The NONVDA index moved.", UNIVERSE);
    expect(result).not.toContain("NVDA");
  });
});

describe("company names and aliases", () => {
  it("detects a company name", () => {
    const result = detectTickers("NVIDIA reported earnings.", UNIVERSE);
    expect(result.find((d) => d.ticker === "NVDA")?.source).toBe("name");
  });

  it("detects an alias", () => {
    const result = detectTickers("TSMC reports strong demand.", UNIVERSE);
    expect(result.map((d) => d.ticker)).toContain("TSM");
  });

  it("resolves a full name to its ticker", () => {
    const result = detectTickerSymbols("Advanced Micro Devices lowered guidance.", UNIVERSE);
    expect(result).toContain("AMD");
  });
});

describe("ambiguity and unknown symbols", () => {
  it("collapses a symbol and name reference to a single detection", () => {
    const result = detectTickers("NVIDIA (NVDA) reported.", UNIVERSE);
    const nvda = result.filter((d) => d.ticker === "NVDA");
    expect(nvda).toHaveLength(1);
  });

  it("prefers the name source over the symbol when both could match", () => {
    const result = detectTickers("Microsoft delivered results.", UNIVERSE);
    expect(result.find((d) => d.ticker === "MSFT")?.source).toBe("name");
  });

  it("ignores unknown tickers", () => {
    const result = detectTickerSymbols("XYZQ surged on no news.", UNIVERSE);
    expect(result).toHaveLength(0);
  });
});
