import { and, eq, isNotNull, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { marketEvents, newsArticles } from "@/lib/db/schema";

/**
 * Feed origin policy (§ Phase 16).
 *
 * An event is **live-origin** when it has a canonical article whose
 * `news_articles.data_status` is `LIVE`. Everything else — an event with no
 * canonical article at all, or one whose canonical article carries any other
 * status (`DEMO`, `REPLAY`, …) — is **demo-origin**. `market_events` has no
 * `data_status` column, so the status is always derived from the canonical
 * article (the same join the events read layer already uses).
 *
 * This is a *serving-layer* concern: the rows stay in the database and back
 * `/replay`; only the events feed (list + total) is filtered, reversibly via
 * `FEED_LIVE_ONLY` / `FEED_DEMO_MAX_ITEMS`.
 */
export interface FeedOriginPolicy {
  /** When false, the feed is unfiltered (pre-phase-16 behaviour). */
  liveOnly: boolean;
  /** When live-only, how many of the newest demo events may remain (0 = none). */
  demoMaxItems: number;
}

export function feedOriginPolicy(source: {
  feedLiveOnly: boolean;
  feedDemoMaxItems: number;
}): FeedOriginPolicy {
  const requested =
    typeof source.feedDemoMaxItems === "number" && Number.isFinite(source.feedDemoMaxItems)
      ? Math.floor(source.feedDemoMaxItems)
      : 0;
  return {
    liveOnly: source.feedLiveOnly === true,
    demoMaxItems: requested > 0 ? requested : 0,
  };
}

/** Pure origin classifier used by tests and documentation. */
export function isLiveOrigin(
  canonicalArticlePresent: boolean,
  canonicalDataStatus: string | null | undefined,
): boolean {
  return canonicalArticlePresent && canonicalDataStatus === "LIVE";
}

/** SQL predicate for a live-origin event, against the outer joined tables. */
function liveOriginExpression(): SQL {
  return and(
    isNotNull(marketEvents.canonicalArticleId),
    eq(newsArticles.dataStatus, "LIVE"),
  ) as SQL;
}

/** SQL predicate for a demo-origin event, parameterised over table aliases. */
function demoOriginExpression(
  canonicalArticleId: SQLWrapper,
  dataStatus: SQLWrapper,
): SQL {
  return sql`(${canonicalArticleId} IS NULL OR ${dataStatus} IS DISTINCT FROM 'LIVE')`;
}

/**
 * Where-clause fragment that enforces the feed origin policy. Returns
 * `undefined` when the filter is off, so callers can concatenate it with the
 * user filters and every consumer of the list endpoint inherits it.
 *
 * With `demoMaxItems > 0` the newest demo-origin events are let through via a
 * bounded subquery; the same number is selected regardless of the page offset,
 * so the page and its `count(*)` stay consistent.
 */
export function buildFeedOriginCondition(policy: FeedOriginPolicy): SQL | undefined {
  if (!policy.liveOnly) {
    return undefined;
  }

  const live = liveOriginExpression();
  if (policy.demoMaxItems <= 0) {
    return live;
  }

  const demoEvent = alias(marketEvents, "feed_demo_event");
  const demoArticle = alias(newsArticles, "feed_demo_article");
  const newestDemoIds = sql`(
    select ${demoEvent.id}
    from ${demoEvent}
    left join ${demoArticle} on ${demoEvent.canonicalArticleId} = ${demoArticle.id}
    where ${demoOriginExpression(demoEvent.canonicalArticleId, demoArticle.dataStatus)}
    order by coalesce(${demoEvent.publishedAt}, ${demoEvent.firstReceivedAt}) desc, ${demoEvent.id} desc
    limit ${policy.demoMaxItems}
  )`;

  return or(live, sql`${marketEvents.id} in ${newestDemoIds}`) as SQL;
}

/**
 * Pure reference for the policy semantics, exercised by the unit tests: given
 * origin-annotated events in feed order, return the visible subset and how many
 * demo-origin events were hidden. The production path is the SQL condition
 * above; the two agree on the rule (keep every live event, then the
 * `demoMaxItems` newest demo events).
 */
export interface OriginCandidate {
  id: string;
  live: boolean;
  /** Recency rank; a larger value is newer. */
  rank: number;
}

export function selectVisibleEvents<T extends OriginCandidate>(
  events: readonly T[],
  policy: FeedOriginPolicy,
): { visible: T[]; hidden: number } {
  if (!policy.liveOnly) {
    return { visible: [...events], hidden: 0 };
  }

  const demo = events.filter((event) => !event.live);
  if (policy.demoMaxItems <= 0) {
    return { visible: events.filter((event) => event.live), hidden: demo.length };
  }

  const allowedIds = new Set(
    [...demo]
      .sort((a, b) => b.rank - a.rank)
      .slice(0, policy.demoMaxItems)
      .map((event) => event.id),
  );

  return {
    visible: events.filter((event) => event.live || allowedIds.has(event.id)),
    hidden: demo.length - allowedIds.size,
  };
}
