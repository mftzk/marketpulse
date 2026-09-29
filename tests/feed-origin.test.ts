import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { loadConfig } from "@/lib/config";
import {
  buildFeedOriginCondition,
  feedOriginPolicy,
  isLiveOrigin,
  selectVisibleEvents,
  type OriginCandidate,
} from "@/lib/services/feed-origin";

const dialect = new PgDialect();

function render(policy: Parameters<typeof buildFeedOriginCondition>[0]) {
  const condition = buildFeedOriginCondition(policy);
  return condition ? dialect.sqlToQuery(condition) : null;
}

describe("feed origin config", () => {
  it("defaults to live-only with no demo allowance", () => {
    const cfg = loadConfig({});
    expect(cfg.feedLiveOnly).toBe(true);
    expect(cfg.feedDemoMaxItems).toBe(0);
  });

  it("reads both switches and rejects invalid values", () => {
    expect(loadConfig({ FEED_LIVE_ONLY: "0" }).feedLiveOnly).toBe(false);
    expect(loadConfig({ FEED_LIVE_ONLY: "false" }).feedLiveOnly).toBe(false);
    expect(loadConfig({ FEED_LIVE_ONLY: "1" }).feedLiveOnly).toBe(true);
    expect(loadConfig({ FEED_DEMO_MAX_ITEMS: "10" }).feedDemoMaxItems).toBe(10);
    expect(loadConfig({ FEED_DEMO_MAX_ITEMS: "0" }).feedDemoMaxItems).toBe(0);
    expect(loadConfig({ FEED_DEMO_MAX_ITEMS: "-5" }).feedDemoMaxItems).toBe(0);
    expect(loadConfig({ FEED_DEMO_MAX_ITEMS: "not-a-number" }).feedDemoMaxItems).toBe(0);
  });
});

describe("feedOriginPolicy", () => {
  it("normalises the policy", () => {
    expect(feedOriginPolicy({ feedLiveOnly: true, feedDemoMaxItems: 10 })).toEqual({
      liveOnly: true,
      demoMaxItems: 10,
    });
    expect(feedOriginPolicy({ feedLiveOnly: false, feedDemoMaxItems: 10 })).toEqual({
      liveOnly: false,
      demoMaxItems: 10,
    });
    expect(feedOriginPolicy({ feedLiveOnly: true, feedDemoMaxItems: -3 }).demoMaxItems).toBe(0);
    expect(feedOriginPolicy({ feedLiveOnly: true, feedDemoMaxItems: 2.9 }).demoMaxItems).toBe(2);
  });
});

describe("isLiveOrigin", () => {
  it("requires a canonical article with data_status LIVE", () => {
    expect(isLiveOrigin(true, "LIVE")).toBe(true);
    expect(isLiveOrigin(true, "DEMO")).toBe(false);
    expect(isLiveOrigin(true, "REPLAY")).toBe(false);
    expect(isLiveOrigin(true, null)).toBe(false);
    expect(isLiveOrigin(false, "LIVE")).toBe(false);
    expect(isLiveOrigin(false, null)).toBe(false);
  });
});

describe("selectVisibleEvents", () => {
  const events: OriginCandidate[] = [
    { id: "live-1", live: true, rank: 50 },
    { id: "demo-old", live: false, rank: 10 },
    { id: "demo-new", live: false, rank: 90 },
    { id: "demo-mid", live: false, rank: 30 },
  ];

  it("returns and hides only demo-origin events when the cap is 0", () => {
    const { visible, hidden } = selectVisibleEvents(events, { liveOnly: true, demoMaxItems: 0 });
    expect(visible.map((e) => e.id)).toEqual(["live-1"]);
    expect(hidden).toBe(3);
  });

  it("lets the N newest demo events through, preserving feed order", () => {
    const { visible, hidden } = selectVisibleEvents(events, { liveOnly: true, demoMaxItems: 2 });
    expect(visible.map((e) => e.id)).toEqual(["live-1", "demo-new", "demo-mid"]);
    expect(hidden).toBe(1);
  });

  it("returns an empty list when every event is demo-origin", () => {
    const demos = events.filter((e) => !e.live);
    const { visible, hidden } = selectVisibleEvents(demos, { liveOnly: true, demoMaxItems: 0 });
    expect(visible).toEqual([]);
    expect(hidden).toBe(3);
  });

  it("restores the unfiltered feed exactly when live-only is off", () => {
    const { visible, hidden } = selectVisibleEvents(events, { liveOnly: false, demoMaxItems: 0 });
    expect(visible).toEqual(events);
    expect(hidden).toBe(0);
  });
});

describe("buildFeedOriginCondition", () => {
  it("is undefined when live-only is off", () => {
    expect(render({ liveOnly: false, demoMaxItems: 0 })).toBeNull();
    expect(render({ liveOnly: false, demoMaxItems: 10 })).toBeNull();
  });

  it("filters on a canonical LIVE article when no demo allowance is configured", () => {
    const query = render({ liveOnly: true, demoMaxItems: 0 });
    expect(query).not.toBeNull();
    expect(query?.sql).toContain("canonical_article_id");
    expect(query?.sql).toContain("is not null");
    expect(query?.sql).toContain("data_status");
    expect(query?.sql).toContain("= $1");
    expect(query?.params).toEqual(["LIVE"]);
  });

  it("adds a bounded newest-demo subquery when a demo allowance is set", () => {
    const query = render({ liveOnly: true, demoMaxItems: 10 });
    expect(query).not.toBeNull();
    expect(query?.sql).toContain("feed_demo_event");
    expect(query?.sql).toContain("feed_demo_article");
    expect(query?.sql).toMatch(/order by .*desc/i);
    expect(query?.sql).toContain("limit $");
    expect(query?.params).toContain(10);
    expect(query?.params).toContain("LIVE");
  });
});
