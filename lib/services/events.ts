import { and, asc, desc, eq, gte, ilike, inArray, lte, or, sql } from "drizzle-orm";

import type { EventType } from "@/lib/core/event-types";
import { EVENT_TYPE_LABELS } from "@/lib/core/event-types";
import type { EventCardDTO, ImpactBand, ListPage } from "@/lib/core/dto";
import type { EventDetailDTO, IntradayMarkerDTO, SourceDTO } from "@/lib/core/detail";
import type { EventFilters } from "@/lib/core/filters";
import { getDb } from "@/lib/db/client";
import {
  companies,
  earningsResult,
  eventArticles,
  eventTickers,
  impactScoreComponents,
  impactScores,
  macroSnapshots,
  marketEvents,
  newsArticles,
  newsSources,
  optionsSnapshots,
  sectors,
  technicalSnapshots,
} from "@/lib/db/schema";
import { computeImpactScore } from "@/lib/scoring/impact";
import {
  computeReactionInputs,
  latestPriceSnapshots,
  type ReactionInputs,
} from "@/lib/db/queries/market-data";
import { deriveMacroChange, deriveRegime, macroChangeUnit, type MacroPoint } from "@/lib/market/macro";
import { getMarketDataProvider } from "@/lib/providers";
import {
  buildEventInterpretation,
  directionOrNeutral,
  newsAgeMinutes,
  num,
  qualityLabel,
  sectorEtfView,
  toIso,
} from "@/lib/services/shared";

type MarketEventRow = typeof marketEvents.$inferSelect;
type TechnicalRow = typeof technicalSnapshots.$inferSelect;

interface EventRow {
  event: MarketEventRow;
  score: string | null;
  band: string | null;
  algorithmVersion: string | null;
  companyName: string | null;
  sectorSlug: string | null;
  sectorEtf: string | null;
  sourceName: string | null;
  sourceTier: number | null;
  sourceQuality: string | null;
}

function buildWhere(filters: EventFilters, now: Date): ReturnType<typeof and> | undefined {
  const parts: ReturnType<typeof eq>[] = [];

  if (filters.ticker !== undefined) {
    parts.push(eq(marketEvents.ticker, filters.ticker));
  }
  if (filters.sector !== undefined) {
    parts.push(eq(sectors.slug, filters.sector));
  }
  if (filters.event_type !== undefined && filters.event_type.length > 0) {
    parts.push(inArray(marketEvents.eventType, filters.event_type));
  }
  if (filters.session !== undefined) {
    parts.push(eq(marketEvents.session, filters.session));
  }
  if (filters.catalyst_direction !== undefined && filters.catalyst_direction.length > 0) {
    parts.push(inArray(marketEvents.catalystDirection, filters.catalyst_direction));
  }
  if (filters.source !== undefined) {
    parts.push(eq(newsSources.slug, filters.source));
  }
  if (filters.min_impact !== undefined) {
    parts.push(gte(impactScores.score, String(filters.min_impact)));
  }
  if (filters.max_impact !== undefined) {
    parts.push(sql`${impactScores.score} <= ${filters.max_impact}`);
  }
  if (filters.max_age_minutes !== undefined) {
    parts.push(gte(marketEvents.publishedAt, new Date(now.getTime() - filters.max_age_minutes * 60_000)));
  }
  if (filters.q !== undefined) {
    const like = `%${filters.q}%`;
    parts.push(
      or(ilike(marketEvents.headline, like), ilike(marketEvents.summary, like)) as never,
    );
  }

  return parts.length > 0 ? and(...parts) : undefined;
}

function baseQuery() {
  return getDb()
    .select({
      event: marketEvents,
      score: impactScores.score,
      band: impactScores.band,
      algorithmVersion: impactScores.algorithmVersion,
      companyName: companies.name,
      sectorSlug: sectors.slug,
      sectorEtf: sectors.etfSymbol,
      sourceName: newsSources.name,
      sourceTier: newsSources.tier,
      sourceQuality: newsSources.qualityScore,
    })
    .from(marketEvents)
    .leftJoin(companies, eq(marketEvents.companyId, companies.id))
    .leftJoin(sectors, eq(marketEvents.sectorId, sectors.id))
    .leftJoin(impactScores, eq(impactScores.eventId, marketEvents.id))
    .leftJoin(newsArticles, eq(marketEvents.canonicalArticleId, newsArticles.id))
    .leftJoin(newsSources, eq(newsArticles.sourceId, newsSources.id));
}

async function latestTechnical(ticker: string): Promise<TechnicalRow | null> {
  const rows = await getDb()
    .select()
    .from(technicalSnapshots)
    .where(eq(technicalSnapshots.ticker, ticker))
    .orderBy(desc(technicalSnapshots.ts))
    .limit(1);
  return rows[0] ?? null;
}

function atrPctFromTechnical(technical: TechnicalRow | null, lastPrice: number | null): number | null {
  const atr = num(technical?.atr14);
  if (atr === null || lastPrice === null || lastPrice <= 0) {
    return null;
  }
  return (atr / lastPrice) * 100;
}

function relatedFromTickers(rows: typeof eventTickers.$inferSelect[]): EventCardDTO["related"] {
  return rows
    .filter((r) => r.relation !== "primary")
    .map((r) => ({
      ticker: r.ticker,
      label: r.ticker,
      change_pct: num(r.changePctSincePublication),
      relation: r.relation as EventCardDTO["related"][number]["relation"],
      is_direct: r.isDirect,
    }));
}

async function componentsForEvents(eventIds: string[]): Promise<Map<string, EventCardDTO["impact"]["components"]>> {
  const result = new Map<string, EventCardDTO["impact"]["components"]>();
  if (eventIds.length === 0) {
    return result;
  }
  const rows = await getDb()
    .select({
      eventId: impactScores.eventId,
      key: impactScoreComponents.key,
      label: impactScoreComponents.label,
      raw: impactScoreComponents.raw,
      normalized: impactScoreComponents.normalized,
      weight: impactScoreComponents.weight,
      points: impactScoreComponents.points,
      explanation: impactScoreComponents.explanation,
    })
    .from(impactScoreComponents)
    .innerJoin(impactScores, eq(impactScoreComponents.impactScoreId, impactScores.id))
    .where(inArray(impactScores.eventId, eventIds))
    .orderBy(asc(impactScoreComponents.weight));

  for (const row of rows) {
    const list = result.get(row.eventId) ?? [];
    list.push({
      key: row.key,
      label: row.label,
      raw: num(row.raw) ?? 0,
      normalized: num(row.normalized) ?? 0,
      weight: num(row.weight) ?? 0,
      points: num(row.points) ?? 0,
      explanation: row.explanation ?? "",
    });
    result.set(row.eventId, list);
  }
  return result;
}

async function tickersForEvents(eventIds: string[]): Promise<Map<string, typeof eventTickers.$inferSelect[]>> {
  const result = new Map<string, typeof eventTickers.$inferSelect[]>();
  if (eventIds.length === 0) {
    return result;
  }
  const rows = await getDb()
    .select()
    .from(eventTickers)
    .where(inArray(eventTickers.eventId, eventIds))
    .orderBy(asc(eventTickers.relation));
  for (const row of rows) {
    const list = result.get(row.eventId) ?? [];
    list.push(row);
    result.set(row.eventId, list);
  }
  return result;
}

function fallbackImpact(event: MarketEventRow, now: Date, rvol: number | null, priceReaction: number | null, sourceQuality: number | null): EventCardDTO["impact"] {
  const result = computeImpactScore({
    publishedAt: event.publishedAt ?? now,
    now,
    sourceQuality,
    companyRelevance: num(event.companyRelevance),
    eventType: event.eventType as EventType,
    eventImportance: num(event.eventImportance),
    weightedSurprisePct: null,
    priceReactionPct: priceReaction,
    rvol,
    relativeStrengthPp: null,
    stockMovePct: priceReaction,
    etfMovePct: null,
  });
  return {
    score: result.score,
    band: result.band,
    components: result.components.map((c) => ({
      key: c.key,
      label: c.label,
      raw: c.raw,
      normalized: c.normalized,
      weight: c.weight,
      points: c.points,
      explanation: c.explanation,
    })),
    algorithm_version: result.algorithmVersion,
  };
}

export interface ListEventsResult {
  data: EventCardDTO[];
  page: ListPage;
}

export async function listEvents(filters: EventFilters): Promise<ListEventsResult> {
  const db = getDb();
  const now = new Date();
  const where = buildWhere(filters, now);

  const query = baseQuery();
  if (where) {
    query.where(where);
  }

  const countQuery = db
    .select({ count: sql<number>`count(*)::int` })
    .from(marketEvents)
    .leftJoin(companies, eq(marketEvents.companyId, companies.id))
    .leftJoin(sectors, eq(marketEvents.sectorId, sectors.id))
    .leftJoin(impactScores, eq(impactScores.eventId, marketEvents.id))
    .leftJoin(newsArticles, eq(marketEvents.canonicalArticleId, newsArticles.id))
    .leftJoin(newsSources, eq(newsArticles.sourceId, newsSources.id));
  if (where) {
    countQuery.where(where);
  }
  const total = (await countQuery)[0]?.count ?? 0;

  switch (filters.sort) {
    case "published_desc":
      query.orderBy(desc(marketEvents.publishedAt));
      break;
    case "impact_asc":
      query.orderBy(sql`${impactScores.score} ASC NULLS LAST`);
      break;
    default:
      query.orderBy(sql`${impactScores.score} DESC NULLS LAST`, desc(marketEvents.publishedAt));
      break;
  }
  query.limit(filters.limit).offset(filters.offset);

  const rows = (await query) as unknown as EventRow[];
  const eventIds = rows.map((r) => r.event.id);
  const tickers = [...new Set(rows.map((r) => r.event.ticker).filter((t): t is string => t !== null))];

  const componentsMap = await componentsForEvents(eventIds);
  const tickersMap = await tickersForEvents(eventIds);

  const priceTickers = new Set<string>([...tickers, "SPY", "QQQ"]);
  for (const row of rows) {
    if (row.sectorEtf) {
      priceTickers.add(row.sectorEtf);
    }
  }
  const priceSnaps = await latestPriceSnapshots(db, [...priceTickers]);

  const technicalCache = new Map<string, TechnicalRow | null>();
  for (const ticker of tickers) {
    technicalCache.set(ticker, await latestTechnical(ticker));
  }

  const reactionCache = new Map<string, ReactionInputs>();
  const reactionFor = async (
    ticker: string,
    publishedAt: Date,
    sectorSlug: string | null,
  ): Promise<ReactionInputs> => {
    const key = `${ticker}:${publishedAt.getTime()}:${sectorSlug ?? ""}`;
    const cached = reactionCache.get(key);
    if (cached) {
      return cached;
    }
    const value = await computeReactionInputs(db, ticker, publishedAt, sectorSlug);
    reactionCache.set(key, value);
    return value;
  };

  const spyPrice = priceSnaps.get("SPY") ?? null;
  const qqqPrice = priceSnaps.get("QQQ") ?? null;

  const data: EventCardDTO[] = [];

  for (const row of rows) {
    const event = row.event;
    const ticker = event.ticker;
    const price = ticker ? priceSnaps.get(ticker) ?? null : null;
    const technical = ticker ? technicalCache.get(ticker) ?? null : null;

    const reaction =
      ticker && event.publishedAt
        ? await reactionFor(ticker, event.publishedAt, row.sectorSlug)
        : null;
    const lastPrice = num(price?.price);
    const rvol = reaction?.rvol ?? null;
    const changeSincePub = reaction?.stockMovePct ?? null;

    const etRows = tickersMap.get(event.id) ?? [];

    const related = relatedFromTickers(etRows);

    const storedScore = num(row.score);
    const impact: EventCardDTO["impact"] =
      storedScore !== null
        ? {
            score: storedScore,
            band: (row.band ?? "minimal") as ImpactBand,
            components: componentsMap.get(event.id) ?? [],
            algorithm_version: row.algorithmVersion ?? "impact-v1",
          }
        : fallbackImpact(event, now, rvol, changeSincePub, num(row.sourceQuality));

    data.push({
      id: event.id,
      ticker,
      company_name: row.companyName,
      sector: row.sectorSlug,
      headline: event.headline,
      summary: event.summary ?? "",
      event_type: event.eventType as EventType,
      event_type_label: EVENT_TYPE_LABELS[event.eventType as EventType],
      published_at: toIso(event.publishedAt),
      news_age_minutes: newsAgeMinutes(event.publishedAt, now),
      source: {
        name: row.sourceName ?? "unknown",
        tier: row.sourceTier ?? 2,
        quality_label: qualityLabel(num(row.sourceQuality)),
      },
      sentiment: num(event.sentiment) ?? 0,
      catalyst_direction: directionOrNeutral(event.catalystDirection),
      relevance_score: num(event.companyRelevance) ?? 0,
      event_importance: num(event.eventImportance) ?? 0,
      analysis_source: event.analysisSource,
      impact,
      price: {
        last: lastPrice,
        change_pct_since_publication: changeSincePub,
        session: price?.session ?? event.session ?? "closed",
        gap_pct: num(price?.gapPct),
        rvol,
        vwap: num(technical?.vwap) ?? num(price?.vwap),
        atr_pct: atrPctFromTechnical(technical, lastPrice),
      },
      market: {
        sp500_change_pct: num(spyPrice?.changePctDaily ?? null),
        nasdaq_change_pct: num(qqqPrice?.changePctDaily ?? null),
        sector_etf: sectorEtfView(row.sectorEtf, priceSnaps.get(row.sectorEtf ?? "")),
      },
      related,
      interpretation: buildEventInterpretation({
        direction: event.catalystDirection,
        eventType: event.eventType as EventType,
        rvol,
      }),
      article_count: event.articleCount ?? 1,
      is_canonical: true,
      latest_update_at: toIso(event.latestUpdateAt),
    });
  }

  const hasMore = filters.offset + filters.limit < total;
  return {
    data,
    page: {
      limit: filters.limit,
      offset: filters.offset,
      next_offset: hasMore ? filters.offset + filters.limit : null,
      has_more: hasMore,
      total,
    },
  };
}

async function sourcesForEvent(eventId: string): Promise<SourceDTO[]> {
  const rows = await getDb()
    .select({
      headline: newsArticles.headline,
      url: newsArticles.url,
      publishedAt: newsArticles.publishedAt,
      isPrimary: eventArticles.isPrimary,
      sourceName: newsSources.name,
      tier: newsSources.tier,
    })
    .from(eventArticles)
    .innerJoin(newsArticles, eq(eventArticles.articleId, newsArticles.id))
    .leftJoin(newsSources, eq(newsArticles.sourceId, newsSources.id))
    .where(eq(eventArticles.eventId, eventId))
    .orderBy(desc(eventArticles.isPrimary), asc(newsArticles.publishedAt));

  return rows.map((r) => ({
    title: r.headline,
    url: r.url,
    source_name: r.sourceName ?? "unknown",
    tier: r.tier ?? 2,
    published_at: toIso(r.publishedAt),
    is_primary: r.isPrimary,
  }));
}

async function latestVixRows(limit: number): Promise<(typeof macroSnapshots.$inferSelect)[]> {
  return getDb()
    .select()
    .from(macroSnapshots)
    .where(eq(macroSnapshots.series, "VIX" as never))
    .orderBy(desc(macroSnapshots.ts))
    .limit(limit);
}

export async function getEventDetail(id: string): Promise<{ event: EventCardDTO; detail: EventDetailDTO } | null> {
  const db = getDb();
  const now = new Date();

  const rows = (await baseQuery().where(eq(marketEvents.id, id))) as unknown as EventRow[];
  const row = rows[0];
  if (!row) {
    return null;
  }

  const event = row.event;
  const ticker = event.ticker;

  const priceTickers = [ticker, row.sectorEtf, "SPY", "QQQ"].filter(
    (t): t is string => typeof t === "string" && t.length > 0,
  );
  const priceSnaps = await latestPriceSnapshots(db, priceTickers);
  const price = ticker ? priceSnaps.get(ticker) ?? null : null;
  const technical = ticker ? await latestTechnical(ticker) : null;
  const lastPrice = num(price?.price);

  const reactionInputs =
    ticker && event.publishedAt
      ? await computeReactionInputs(db, ticker, event.publishedAt, row.sectorSlug)
      : null;
  const rvol = reactionInputs?.rvol ?? null;
  const changeSincePub = reactionInputs?.stockMovePct ?? null;

  const etRows = await db.select().from(eventTickers).where(eq(eventTickers.eventId, id)).orderBy(asc(eventTickers.relation));

  const components = (await componentsForEvents([id])).get(id) ?? [];
  const storedScore = num(row.score);
  const impact: EventCardDTO["impact"] =
    storedScore !== null
      ? { score: storedScore, band: (row.band ?? "minimal") as ImpactBand, components, algorithm_version: row.algorithmVersion ?? "impact-v1" }
      : fallbackImpact(event, now, rvol, changeSincePub, num(row.sourceQuality));

  const sectorEtfViewValue = sectorEtfView(row.sectorEtf, priceSnaps.get(row.sectorEtf ?? ""));

  const card: EventCardDTO = {
    id: event.id,
    ticker,
    company_name: row.companyName,
    sector: row.sectorSlug,
    headline: event.headline,
    summary: event.summary ?? "",
    event_type: event.eventType as EventType,
    event_type_label: EVENT_TYPE_LABELS[event.eventType as EventType],
    published_at: toIso(event.publishedAt),
    news_age_minutes: newsAgeMinutes(event.publishedAt, now),
    source: { name: row.sourceName ?? "unknown", tier: row.sourceTier ?? 2, quality_label: qualityLabel(num(row.sourceQuality)) },
    sentiment: num(event.sentiment) ?? 0,
    catalyst_direction: directionOrNeutral(event.catalystDirection),
    relevance_score: num(event.companyRelevance) ?? 0,
    event_importance: num(event.eventImportance) ?? 0,
    analysis_source: event.analysisSource,
    impact,
    price: {
      last: lastPrice,
      change_pct_since_publication: changeSincePub,
      session: price?.session ?? event.session ?? "closed",
      gap_pct: num(price?.gapPct),
      rvol,
      vwap: num(technical?.vwap) ?? num(price?.vwap),
      atr_pct: atrPctFromTechnical(technical, lastPrice),
    },
    market: {
      sp500_change_pct: num(priceSnaps.get("SPY")?.changePctDaily ?? null),
      nasdaq_change_pct: num(priceSnaps.get("QQQ")?.changePctDaily ?? null),
      sector_etf: sectorEtfViewValue,
    },
    related: relatedFromTickers(etRows),
    interpretation: buildEventInterpretation({ direction: event.catalystDirection, eventType: event.eventType as EventType, rvol }),
    article_count: event.articleCount ?? 1,
    is_canonical: true,
    latest_update_at: toIso(event.latestUpdateAt),
  };

  const earnings = ticker
    ? await db.select().from(earningsResult).where(eq(earningsResult.ticker, ticker)).orderBy(desc(earningsResult.reportedAt)).limit(1)
    : [];
  const earn = earnings[0];

  const macroRows = await db.select().from(macroSnapshots).orderBy(desc(macroSnapshots.ts)).limit(48);
  const macroLatest = new Map<string, (typeof macroSnapshots.$inferSelect)>();
  for (const m of macroRows) {
    if (!macroLatest.has(m.series)) {
      macroLatest.set(m.series, m);
    }
  }
  const macroPoints: MacroPoint[] = [...macroLatest.values()].map((m) => {
    const value = Number(m.value);
    const previous = num(m.previousValue);
    return {
      series: m.series as MacroPoint["series"],
      value,
      previousValue: previous,
      change: deriveMacroChange(m.series, value, previous, num(m.change)),
      unit: macroChangeUnit(m.series, m.unit),
    };
  });
  const vixRows = await latestVixRows(20);
  const vixMean = vixRows.length > 0 ? vixRows.reduce((acc, r) => acc + Number(r.value), 0) / vixRows.length : null;

  const optionRow = ticker
    ? (await db.select().from(optionsSnapshots).where(eq(optionsSnapshots.ticker, ticker)).orderBy(desc(optionsSnapshots.ts)).limit(1))[0] ?? null
    : null;

  const barFrom = new Date(now.getTime() - 6 * 60 * 60_000);
  const bars = ticker
    ? (await getMarketDataProvider().bars(ticker, { from: barFrom, to: now, intervalMinutes: 1 })).slice(-420)
    : [];
  const markerRows = await db
    .select({
      id: marketEvents.id,
      eventType: marketEvents.eventType,
      publishedAt: marketEvents.publishedAt,
      catalystDirection: marketEvents.catalystDirection,
      score: impactScores.score,
    })
    .from(marketEvents)
    .leftJoin(impactScores, eq(impactScores.eventId, marketEvents.id))
    .where(and(gte(marketEvents.publishedAt, barFrom), lte(marketEvents.publishedAt, now)))
    .orderBy(asc(marketEvents.publishedAt))
    .limit(80);
  const markers: IntradayMarkerDTO[] = markerRows
    .filter((m) => m.publishedAt !== null)
    .map((m) => ({
      time: Math.floor((m.publishedAt as Date).getTime() / 1000),
      label: EVENT_TYPE_LABELS[m.eventType as EventType],
      event_id: m.id,
      impact_score: num(m.score) ?? 0,
      catalyst_direction: m.catalystDirection,
    }));

  const detail: EventDetailDTO = {
    overview: {
      headline: event.headline,
      summary: event.summary ?? "",
      event_type: event.eventType as EventType,
      event_type_label: EVENT_TYPE_LABELS[event.eventType as EventType],
      catalyst_direction: event.catalystDirection,
      sentiment: num(event.sentiment) ?? 0,
      published_at: toIso(event.publishedAt),
      session: event.session,
      ticker,
      company_name: row.companyName,
      sector: row.sectorSlug,
      source: { name: row.sourceName ?? "unknown", tier: row.sourceTier ?? 2, quality_label: qualityLabel(num(row.sourceQuality)) },
      article_count: event.articleCount ?? 1,
    },
    what_happened: event.summary ?? event.headline,
    why_it_matters: event.reasoning ?? event.summary ?? "",
    expectation_vs_actual: {
      eps_surprise_pct: num(earn?.epsSurprisePct),
      revenue_surprise_pct: num(earn?.revenueSurprisePct),
      guidance_surprise_pct: num(earn?.guidanceSurprisePct),
      expected: {
        eps: num(earn?.epsConsensus),
        revenue: num(earn?.revenueConsensus),
        guidance: num(earn?.guidanceConsensus),
      },
      actual: {
        eps: num(earn?.epsActual),
        revenue: num(earn?.revenueActual),
        guidance: num(earn?.guidanceActual),
      },
      note: earn
        ? "Consensus figures are as of the latest available estimate period."
        : "No earnings record is linked to this event.",
    },
    price_reaction: {
      at_publication: reactionInputs?.reaction.atPublication.price ?? null,
      reaction_1m: reactionInputs?.reaction.reaction1m ?? null,
      reaction_5m: reactionInputs?.reaction.reaction5m ?? null,
      reaction_15m: reactionInputs?.reaction.reaction15m ?? null,
      reaction_30m: reactionInputs?.reaction.reaction30m ?? null,
      reaction_60m: reactionInputs?.reaction.reaction60m ?? null,
      reaction_daily: reactionInputs?.reaction.reactionDaily ?? null,
      volume: reactionInputs?.cumulativeVolume ?? null,
      rvol: reactionInputs?.rvol ?? null,
      vwap: reactionInputs?.reaction.vwap ?? num(technical?.vwap),
      atr_pct: atrPctFromTechnical(technical, lastPrice) ?? reactionInputs?.reaction.atrPct ?? null,
      gap_pct: reactionInputs?.reaction.gapPct ?? num(price?.gapPct),
      peak_60m: reactionInputs?.reaction.peak60m ?? null,
      trough_60m: reactionInputs?.reaction.trough60m ?? null,
    },
    volume_reaction: {
      cumulative: reactionInputs?.cumulativeVolume ?? null,
      expected_to_date: reactionInputs?.expectedVolumeToDate ?? null,
      rvol: reactionInputs?.rvol ?? null,
      profile: reactionInputs?.rvol !== null && reactionInputs?.rvol !== undefined && reactionInputs.rvol >= 1.5 ? "elevated" : "normal",
    },
    sector_reaction: {
      sector_etf: row.sectorEtf,
      etf_change_pct: sectorEtfViewValue?.change_pct ?? null,
      stock_vs_etf_pp: reactionInputs?.relativeStrengthPp ?? null,
      peers: etRows
        .filter((r) => r.relation === "peer")
        .map((r) => ({ ticker: r.ticker, change_pct: num(r.changePctSincePublication) })),
    },
    related_stocks: relatedFromTickers(etRows),
    technical: {
      vwap: num(technical?.vwap),
      sma20: num(technical?.sma20),
      sma50: num(technical?.sma50),
      ema9: num(technical?.ema9),
      atr14: num(technical?.atr14),
      rsi14: num(technical?.rsi14),
      prev_day_high: num(technical?.prevDayHigh),
      prev_day_low: num(technical?.prevDayLow),
      day_high: num(technical?.dayHigh),
      day_low: num(technical?.dayLow),
      dist_from_52w_high_pct: num(technical?.distFrom52wHighPct),
      gap_pct: num(technical?.gapPct),
      conditions: technical?.conditions ?? [],
    },
    macro: Object.fromEntries(
      macroPoints.map((m) => [
        m.series,
        { value: m.value, previous: m.previousValue ?? null, change: m.change ?? null, unit: m.unit ?? null, as_of: toIso(macroLatest.get(m.series)?.ts) },
      ]),
    ),
    regime: macroPoints.length > 0 ? deriveRegime(macroPoints, { vixMean }) : null,
    options: optionRow
      ? {
          implied_volatility: num(optionRow.impliedVolatility),
          iv_change: num(optionRow.ivChange),
          put_call_ratio: num(optionRow.putCallRatio),
          unusual_activity: optionRow.unusualActivity,
        }
      : null,
    timeline: [
      { ts: toIso(event.publishedAt), label: "Event published", kind: "event" },
      { ts: toIso(event.latestUpdateAt), label: "Last update", kind: "update" },
    ],
    sources: await sourcesForEvent(id),
    impact_breakdown: impact.components,
    intraday: {
      bars: bars.map((b) => ({
        time: b.time,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
      })),
      markers,
    },
  };

  return { event: card, detail };
}
