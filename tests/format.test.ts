import { describe, expect, it } from "vitest";

import {
  bandLabel,
  formatAge,
  formatDate,
  formatMacroChange,
  formatNumberCompact,
  formatPercent,
  formatPrice,
  formatRvol,
  formatScore,
  formatSignedPp,
} from "@/lib/format";

describe("formatPrice", () => {
  it("formats to two decimals by default", () => {
    expect(formatPrice(178.4)).toBe("178.40");
    expect(formatPrice(0)).toBe("0.00");
  });

  it("honours a custom precision", () => {
    expect(formatPrice(1234.5678, 1)).toBe("1234.6");
  });

  it("renders a placeholder for missing values", () => {
    expect(formatPrice(null)).toBe("—");
    expect(formatPrice(undefined)).toBe("—");
    expect(formatPrice(Number.NaN)).toBe("—");
  });
});

describe("formatPercent", () => {
  it("always carries a sign", () => {
    expect(formatPercent(1.23)).toBe("+1.2%");
    expect(formatPercent(-0.44)).toBe("-0.4%");
    expect(formatPercent(0)).toBe("+0.0%");
  });

  it("renders a placeholder for missing values", () => {
    expect(formatPercent(null)).toBe("—");
    expect(formatPercent(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("formatRvol", () => {
  it("renders a multiple with an x suffix", () => {
    expect(formatRvol(2.81)).toBe("2.8x");
    expect(formatRvol(1)).toBe("1.0x");
  });

  it("renders a placeholder for missing values", () => {
    expect(formatRvol(null)).toBe("—");
  });
});

describe("formatAge", () => {
  it("uses minute granularity under an hour", () => {
    expect(formatAge(0.4)).toBe("just now");
    expect(formatAge(1)).toBe("1 minute ago");
    expect(formatAge(2)).toBe("2 minutes ago");
    expect(formatAge(59)).toBe("59 minutes ago");
  });

  it("uses hours under a day", () => {
    expect(formatAge(90)).toBe("1 h ago");
    expect(formatAge(180)).toBe("3 h ago");
    expect(formatAge(1439)).toBe("23 h ago");
  });

  it("uses days beyond a day", () => {
    expect(formatAge(1440)).toBe("1 day ago");
    expect(formatAge(2880)).toBe("2 days ago");
  });

  it("handles invalid input", () => {
    expect(formatAge(null)).toBe("unknown");
    expect(formatAge(-5)).toBe("unknown");
  });
});

describe("formatNumberCompact", () => {
  it("abbreviates thousands, millions and billions", () => {
    expect(formatNumberCompact(60_000_000)).toBe("60.0M");
    expect(formatNumberCompact(1_200_000_000)).toBe("1.2B");
    expect(formatNumberCompact(3_400)).toBe("3.4K");
    expect(formatNumberCompact(2_500_000_000_000)).toBe("2.5T");
  });

  it("rounds small numbers", () => {
    expect(formatNumberCompact(999)).toBe("999");
    expect(formatNumberCompact(null)).toBe("—");
  });
});

describe("formatScore", () => {
  it("uses one decimal", () => {
    expect(formatScore(82.5)).toBe("82.5");
    expect(formatScore(60)).toBe("60.0");
    expect(formatScore(null)).toBe("—");
  });
});

describe("formatSignedPp", () => {
  it("signs percentage points", () => {
    expect(formatSignedPp(0.64)).toBe("+0.6pp");
    expect(formatSignedPp(-0.6)).toBe("-0.6pp");
    expect(formatSignedPp(null)).toBe("—");
  });
});

describe("bandLabel", () => {
  it("maps every band to a human label", () => {
    expect(bandLabel("high")).toBe("High impact");
    expect(bandLabel("minimal")).toBe("Minimal impact");
    expect(bandLabel(null)).toBe("—");
  });
});

describe("formatDate", () => {
  it("extracts the ISO date portion", () => {
    expect(formatDate("2026-01-05T18:00:00.000Z")).toBe("2026-01-05");
    expect(formatDate("2026-01-06T02:00:00.000Z")).toBe("2026-01-05");
    expect(formatDate("")).toBe("—");
  });
});

describe("formatMacroChange", () => {
  it("renders rate series in basis points", () => {
    expect(formatMacroChange("US10Y", -0.02, "%")).toBe("-2bp");
    expect(formatMacroChange("US10Y", 0.023, "%")).toBe("+2.3bp");
    expect(formatMacroChange("CPI_YOY", 0, "%")).toBe("0bp");
  });

  it("renders rate series with a non-percent unit as a signed absolute", () => {
    expect(formatMacroChange("NFP_CHANGE", 12, "k")).toBe("+12.0k");
  });

  it("renders level series as a signed percent", () => {
    expect(formatMacroChange("SP500", -0.24, "%")).toBe("-0.24%");
    expect(formatMacroChange("NASDAQ", 0.5, "%")).toBe("+0.50%");
  });

  it("renders a placeholder for missing values", () => {
    expect(formatMacroChange("SP500", null, "%")).toBe("—");
  });
});
