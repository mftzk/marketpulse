import { describe, expect, it } from "vitest";

import { etWallClock, sessionFor } from "@/lib/core/session";

// January dates are EST (UTC-5); July dates are EDT (UTC-4). Both chosen on a
// Monday so weekday logic does not interfere.
describe("sessionFor", () => {
  it("maps pre-market hours (04:00–09:30 ET)", () => {
    expect(sessionFor(new Date("2026-01-05T09:00:00Z"))).toBe("pre_market"); // 04:00 ET
    expect(sessionFor(new Date("2026-01-05T14:00:00Z"))).toBe("pre_market"); // 09:00 ET
  });

  it("maps regular hours (09:30–16:00 ET)", () => {
    expect(sessionFor(new Date("2026-01-05T14:30:00Z"))).toBe("regular"); // 09:30 ET
    expect(sessionFor(new Date("2026-01-05T20:59:00Z"))).toBe("regular"); // 15:59 ET
  });

  it("maps after-hours (16:00–20:00 ET)", () => {
    expect(sessionFor(new Date("2026-01-05T21:00:00Z"))).toBe("after_hours"); // 16:00 ET
  });

  it("maps overnight hours to closed", () => {
    expect(sessionFor(new Date("2026-01-05T08:59:00Z"))).toBe("closed"); // 03:59 ET
    expect(sessionFor(new Date("2026-01-06T01:00:00Z"))).toBe("closed"); // 20:00 ET
  });

  it("maps weekends to closed", () => {
    expect(sessionFor(new Date("2026-01-10T14:30:00Z"))).toBe("closed"); // Saturday
    expect(sessionFor(new Date("2026-01-11T14:30:00Z"))).toBe("closed"); // Sunday
  });

  it("is DST-aware (EDT offset)", () => {
    expect(sessionFor(new Date("2026-07-06T13:30:00Z"))).toBe("regular"); // 09:30 EDT
  });
});

describe("etWallClock", () => {
  it("returns weekday and minutes since midnight in ET", () => {
    expect(etWallClock(new Date("2026-01-05T14:30:00Z"))).toEqual({
      weekday: 1,
      minutes: 9 * 60 + 30,
    });
  });
});
