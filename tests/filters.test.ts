import { describe, expect, it } from "vitest";

import {
  catalystDirectionFilter,
  eventFiltersSchema,
  eventTypeFilter,
  limitFilter,
  tickerFilter,
} from "@/lib/core/filters";

describe("limit/offset filters", () => {
  it("applies defaults", () => {
    expect(limitFilter.parse(undefined)).toBe(25);
    expect(eventFiltersSchema.parse({})).toMatchObject({ sort: "impact_desc", limit: 25, offset: 0 });
  });

  it("rejects out-of-range limits", () => {
    expect(limitFilter.safeParse("0").success).toBe(false);
    expect(limitFilter.safeParse("101").success).toBe(false);
  });
});

describe("ticker filter", () => {
  it("normalises to uppercase", () => {
    expect(tickerFilter.parse("nvda")).toBe("NVDA");
  });

  it("rejects invalid symbols", () => {
    expect(tickerFilter.safeParse("1234").success).toBe(false);
    expect(tickerFilter.safeParse("too-long-ticker-here").success).toBe(false);
  });
});

describe("event_type filter", () => {
  it("splits comma-separated values", () => {
    expect(eventTypeFilter.parse("EARNINGS,GUIDANCE")).toEqual(["EARNINGS", "GUIDANCE"]);
    expect(eventTypeFilter.parse(" M&A , PRODUCT ")).toEqual(["M&A", "PRODUCT"]);
  });

  it("rejects unknown event types", () => {
    expect(eventTypeFilter.safeParse("NOT_A_TYPE").success).toBe(false);
  });
});

describe("catalyst_direction filter", () => {
  it("splits comma-separated values", () => {
    expect(catalystDirectionFilter.parse("positive,negative")).toEqual(["positive", "negative"]);
  });

  it("rejects unknown directions", () => {
    expect(catalystDirectionFilter.safeParse("sideways").success).toBe(false);
  });
});

describe("eventFiltersSchema", () => {
  it("coerces numeric filters", () => {
    const result = eventFiltersSchema.parse({ min_impact: "50", max_impact: "80" });
    expect(result.min_impact).toBe(50);
    expect(result.max_impact).toBe(80);
  });

  it("parses a full filter set", () => {
    const result = eventFiltersSchema.parse({
      ticker: "nvda",
      sector: "semiconductors",
      event_type: "EARNINGS,GUIDANCE",
      sort: "published_desc",
      limit: "10",
      offset: "5",
    });
    expect(result.ticker).toBe("NVDA");
    expect(result.event_type).toEqual(["EARNINGS", "GUIDANCE"]);
    expect(result.limit).toBe(10);
    expect(result.offset).toBe(5);
  });
});
