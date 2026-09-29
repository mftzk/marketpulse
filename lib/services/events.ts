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
  fundamentalExpectations,
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
import { bandForScore } from "@/lib/scoring/impact";
import { surprisePct } from "@/lib/analysis/surprise";
import {
  computeReactionInputsBatch,
  computeReactionSummariesBatch,
  latestPriceSnapshots,
  latestTechnicalSnapshots,
  reactionRequestKey,
} from "@/lib/db/queries/market-data";
import { deriveMacroChange, deriveRegime, macroChangeUnit, type MacroPoint } from "@/lib/market/macro";
import { getMarketDataProvider, storedFeedStatus } from "@/lib/providers";
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
  computedAt: Date | null;
  initialScore: string | null;
  initialComputedAt: Date | null;
  rvolSnapshot: string | null;
  rvolAsOf: Date | null;
  rvolVolume: number | null;
  rvolExpectedVolume: string | null;
  rvolSampleCount: number | null;
  rvolSession: string | null;
  companyName: string | null;
  sectorSlug: string | null;
  sectorEtf: string | null;
  sourceName: string | null;
  sourceTier: number | null;
  sourceQuality: string | null;
  ingestProvider: string | null;
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
    parts.push(sql`coalesce(${marketEvents.publishedAt}, ${marketEvents.firstReceivedAt}) >= ${new Date(now.getTime() - filters.max_age_minutes * 60_000)}`);
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
      computedAt: impactScores.computedAt,
      initialScore: impactScores.initialScore,
      initialComputedAt: impactScores.initialComputedAt,
      rvolSnapshot: impactScores.rvolSnapshot,
      rvolAsOf: impactScores.rvolAsOf,
      rvolVolume: impactScores.rvolVolume,
      rvolExpectedVolume: impactScores.rvolExpectedVolume,
      rvolSampleCount: impactScores.rvolSampleCount,
      rvolSession: impactScores.rvolSession,
      companyName: companies.name,
      sectorSlug: sectors.slug,
      sectorEtf: sectors.etfSymbol,
      sourceName: newsSources.name,
      sourceTier: newsSources.tier,
      sourceQuality: newsSources.qualityScore,
      ingestProvider: newsArticles.ingestProvider,
    })
    .from(marketEvents)
    .leftJoin(companies, eq(marketEvents.companyId, companies.id))
    .leftJoin(sectors, eq(marketEvents.sectorId, sectors.id))
    .leftJoin(impactScores, eq(impactScores.eventId, marketEvents.id))
    .leftJoin(newsArticles, eq(marketEvents.canonicalArticleId, newsArticles.id))
    .leftJoin(newsSources, eq(newsArticles.sourceId, newsSources.id));
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
      raw: num(row.raw),
      normalized: num(row.normalized),
      weight: num(row.weight),
      points: num(row.points),
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

function unavailableImpact(): EventCardDTO["impact"] {
  return {
    score: null,
    band: null,
    components: [],
    algorithm_version: "impact-v2",
    computed_at: null,
    initial_score: null,
    initial_computed_at: null,
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
      query.orderBy(sql`coalesce(${marketEvents.publishedAt}, ${marketEvents.firstReceivedAt}) DESC`);
      break;
    case "impact_asc":
      query.orderBy(sql`${impactScores.score} ASC NULLS LAST`);
      break;
    default:
      query.orderBy(sql`${impactScores.score} DESC NULLS LAST`, sql`coalesce(${marketEvents.publishedAt}, ${marketEvents.firstReceivedAt}) DESC`);
      break;
  }
  query.limit(filters.limit).offset(filters.offset);

  const rows = (await query) as unknown as EventRow[];
  const eventIds = rows.map((r) => r.event.id);
  const tickers = [...new Set(rows.map((r) => r.event.ticker).filter((t): t is string => t !== null))];

  // --- Constant-query assembly (phase 3c) ---------------------------------
  // Every lookup below consumes the whole page at once. Do NOT reintroduce a
  // per-row / per-ticker query here: the deployed container pays ~80–150 ms
  // per round-trip, so a feed of 50 events would spend seconds in N+1s.
  const priceTickers = new Set<string>([...tickers, "SPY", "QQQ"]);
  for (const row of rows) {
    if (row.sectorEtf) {
      priceTickers.add(row.sectorEtf);
    }
  }

  const reactionRequests: { ticker: string; publishedAt: Date; sectorSlug: string | null }[] = [];
  for (const row of rows) {
    if (row.event.ticker !== null && row.event.publishedAt !== null) {
      reactionRequests.push({
        ticker: row.event.ticker,
        publishedAt: row.event.publishedAt,
        sectorSlug: row.sectorSlug,
      });
    }
  }

  const [componentsMap, tickersMap, priceSnaps, technicalMap, reactionMap] = await Promise.all([
    componentsForEvents(eventIds),
    tickersForEvents(eventIds),
    latestPriceSnapshots(db, [...priceTickers]),
    latestTechnicalSnapshots(db, tickers),
    computeReactionSummariesBatch(db, reactionRequests),
  ]);

  const spyPrice = priceSnaps.get("SPY") ?? null;
  const qqqPrice = priceSnaps.get("QQQ") ?? null;

  const data: EventCardDTO[] = [];

  for (const row of rows) {
    const event = row.event;
    const ticker = event.ticker;
    const price = ticker ? priceSnaps.get(ticker) ?? null : null;
    const technical = ticker ? technicalMap.get(ticker) ?? null : null;

    const reaction =
      ticker && event.publishedAt
        ? reactionMap.get(
            reactionRequestKey({
              ticker,
              publishedAt: event.publishedAt,
              sectorSlug: row.sectorSlug,
            }),
          ) ?? null
        : null;
    const lastPrice = num(price?.price);
    const rvol = num(row.rvolSnapshot);
    const changeSincePub = reaction?.stockMovePct ?? null;

    const etRows = tickersMap.get(event.id) ?? [];

    const related = relatedFromTickers(etRows);

    const storedScore = num(row.score);
    const impact: EventCardDTO["impact"] =
      storedScore !== null
        ? {
            score: storedScore,
            band: (row.band as ImpactBand | null) ?? (storedScore === null ? null : bandForScore(storedScore)),
            components: componentsMap.get(event.id) ?? [],
            algorithm_version: row.algorithmVersion ?? "impact-v2",
            computed_at: row.computedAt?.toISOString() ?? null,
            initial_score: num(row.initialScore),
            initial_computed_at: row.initialComputedAt?.toISOString() ?? null,
          }
        : unavailableImpact();

    data.push({
      id: event.id,
      ticker,
      company_name: row.companyName,
      sector: row.sectorSlug,
      headline: event.headline,
      summary: event.summary ?? "",
      event_type: event.eventType as EventType,
      event_type_label: EVENT_TYPE_LABELS[event.eventType as EventType],
      published_at: event.publishedAt?.toISOString() ?? null,
      received_at: event.firstReceivedAt.toISOString(),
      news_age_minutes: newsAgeMinutes(event.publishedAt, now),
      source: {
        name: row.sourceName,
        tier: row.sourceTier,
        quality_score: num(row.sourceQuality),
        quality_label: qualityLabel(num(row.sourceQuality)),
        ingest_provider: row.ingestProvider,
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
        rvol_as_of: row.rvolAsOf?.toISOString() ?? null,
        rvol_session: row.rvolSession,
        rvol_volume: row.rvolVolume,
        rvol_expected_volume: num(row.rvolExpectedVolume),
        rvol_sample_count: row.rvolSampleCount,
        as_of: price?.ts.toISOString() ?? null,
        data_status: price ? storedFeedStatus(price.dataStatus, price.ts, "market", now) : "UNAVAILABLE",
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

async function sourcesForEvent(eventId: string, claimHeadline: string): Promise<SourceDTO[]> {
  const rows = await getDb()
    .select({
      headline: newsArticles.headline,
      url: newsArticles.url,
      body: newsArticles.body,
      publishedAt: newsArticles.publishedAt,
      receivedAt: newsArticles.firstReceivedAt,
      isPrimary: eventArticles.isPrimary,
      isNewInformation: eventArticles.isNewInformation,
      sourceName: newsSources.name,
      tier: newsSources.tier,
      quality: newsSources.qualityScore,
      ingestProvider: newsArticles.ingestProvider,
    })
    .from(eventArticles)
    .innerJoin(newsArticles, eq(eventArticles.articleId, newsArticles.id))
    .leftJoin(newsSources, eq(newsArticles.sourceId, newsSources.id))
    .where(eq(eventArticles.eventId, eventId))
    .orderBy(desc(eventArticles.isPrimary), asc(newsArticles.publishedAt));

  return rows.map((r) => ({
    title: r.headline,
    url: r.url,
    source_name: r.sourceName,
    tier: r.tier,
    quality_score: num(r.quality),
    ingest_provider: r.ingestProvider,
    published_at: r.publishedAt?.toISOString() ?? null,
    received_at: r.receivedAt.toISOString(),
    excerpt: verbatimExcerpt(r.body, claimHeadline),
    is_new_information: r.isNewInformation,
    is_primary: r.isPrimary,
  }));
}

function verbatimExcerpt(body: string | null, claimHeadline: string): string | null {
  if (!body) return null;
  const sentences = body.match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map((sentence) => sentence.trim()) ?? [];
  const guidanceClaim = /guidance|outlook|forecast|raises|raised|lifts|lifted/i.test(claimHeadline);
  const evidencePattern = guidanceClaim ? /guidance|outlook|forecast|raise[sd]?|lift(?:s|ed)?/i : null;
  const sentence = evidencePattern ? sentences.find((item) => evidencePattern.test(item)) : sentences[0];
  return sentence && sentence.length <= 360 ? sentence : null;
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

  const priceTickers = [ticker, row.sectorEtf, "SPY", "QQQ", "SOXX", "XLK", "XLC", "XLY"].filter(
    (t): t is string => typeof t === "string" && t.length > 0,
  );
  const priceSnaps = await latestPriceSnapshots(db, priceTickers);
  const price = ticker ? priceSnaps.get(ticker) ?? null : null;
  const technical = ticker ? (await latestTechnicalSnapshots(db, [ticker])).get(ticker) ?? null : null;
  const lastPrice = num(price?.price);

  // Batched (one price + one volume query); single event, so this is two
  // round-trips rather than the four the per-event helper issued.
  const reactionMap = await computeReactionInputsBatch(
    db,
    ticker && event.publishedAt
      ? [{ ticker, publishedAt: event.publishedAt, sectorSlug: row.sectorSlug }]
      : [],
  );
  const reactionInputs =
    ticker && event.publishedAt
      ? reactionMap.get(
          reactionRequestKey({ ticker, publishedAt: event.publishedAt, sectorSlug: row.sectorSlug }),
        ) ?? null
      : null;
  const rvol = num(row.rvolSnapshot);
  const changeSincePub = reactionInputs?.stockMovePct ?? null;

  // Components and related tickers for this single event, fetched together.
  const [etRows, components] = await Promise.all([
    db.select().from(eventTickers).where(eq(eventTickers.eventId, id)).orderBy(asc(eventTickers.relation)),
    componentsForEvents([id]).then((map) => map.get(id) ?? []),
  ]);
  const storedScore = num(row.score);
  const impact: EventCardDTO["impact"] =
    storedScore !== null
      ? {
          score: storedScore, band: (row.band as ImpactBand | null) ?? (storedScore === null ? null : bandForScore(storedScore)), components,
          algorithm_version: row.algorithmVersion ?? "impact-v2",
          computed_at: row.computedAt?.toISOString() ?? null,
          initial_score: num(row.initialScore),
          initial_computed_at: row.initialComputedAt?.toISOString() ?? null,
        }
      : unavailableImpact();

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
    published_at: event.publishedAt?.toISOString() ?? null,
    received_at: event.firstReceivedAt.toISOString(),
    news_age_minutes: newsAgeMinutes(event.publishedAt, now),
    source: { name: row.sourceName, tier: row.sourceTier, quality_score: num(row.sourceQuality), quality_label: qualityLabel(num(row.sourceQuality)), ingest_provider: row.ingestProvider },
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
      rvol_as_of: row.rvolAsOf?.toISOString() ?? null,
      rvol_session: row.rvolSession,
      rvol_volume: row.rvolVolume,
      rvol_expected_volume: num(row.rvolExpectedVolume),
      rvol_sample_count: row.rvolSampleCount,
      as_of: price?.ts.toISOString() ?? null,
        data_status: price ? storedFeedStatus(price.dataStatus, price.ts, "market", now) : "UNAVAILABLE",
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
    ? await db.select().from(earningsResult).where(and(eq(earningsResult.ticker, ticker), eq(earningsResult.eventId, event.id))).limit(1)
    : [];
  const earn = earnings[0];
  const expectationRows = ticker && event.fiscalPeriod
    ? await db.select().from(fundamentalExpectations).where(and(
        eq(fundamentalExpectations.ticker, ticker),
        eq(fundamentalExpectations.fiscalPeriod, event.fiscalPeriod),
      ))
    : [];
  const expectations = new Map(expectationRows.map((item) => [item.metric, item]));
  const epsEstimate = expectations.get("eps");
  const revenueEstimate = expectations.get("revenue");
  const epsConsensus = num(earn?.epsConsensus) ?? num(epsEstimate?.consensus);
  const revenueConsensus = num(earn?.revenueConsensus) ?? num(revenueEstimate?.consensus);
  const epsActual = num(earn?.epsActual);
  const revenueActual = num(earn?.revenueActual);
  const sourceEvidence = await sourcesForEvent(id, event.headline);
  const guidanceClaim = /guidance|outlook|forecast|raises|raised|lifts|lifted/i.test(`${event.headline} ${event.summary ?? ""}`);
  const hasGuidanceFigures = (earn?.guidanceActual !== null && earn?.guidanceActual !== undefined)
    || (earn?.guidanceConsensus !== null && earn?.guidanceConsensus !== undefined);
  const guidanceUnverified = guidanceClaim && !hasGuidanceFigures && !sourceEvidence.some((source) => source.excerpt !== null);

  const macroRows = await db.select().from(macroSnapshots).orderBy(desc(macroSnapshots.ts)).limit(48);
  const macroLatest = new Map<string, (typeof macroSnapshots.$inferSelect)>();
  for (const m of macroRows) {
    if (!macroLatest.has(m.series)) {
      macroLatest.set(m.series, m);
    }
  }
  const trackedEtfs = new Set(["SOXX", "XLK", "XLC", "XLY"]);
  const macroPoints: MacroPoint[] = [...macroLatest.values()].filter((m) => !trackedEtfs.has(m.series)).map((m) => {
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

  for (const symbol of trackedEtfs) {
    const snapshot = priceSnaps.get(symbol);
    const value = num(snapshot?.price ?? null);
    const previous = num(snapshot?.prevClose ?? null);
    if (value !== null && previous !== null) {
      macroPoints.push({ series: symbol as MacroPoint["series"], value, previousValue: previous, change: num(snapshot?.changePctDaily ?? null), unit: "%" });
    }
  }

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
      impact_score: num(m.score),
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
      published_at: event.publishedAt?.toISOString() ?? null,
      received_at: event.firstReceivedAt.toISOString(),
      session: event.session,
      ticker,
      company_name: row.companyName,
      sector: row.sectorSlug,
      source: { name: row.sourceName, tier: row.sourceTier, quality_score: num(row.sourceQuality), quality_label: qualityLabel(num(row.sourceQuality)), ingest_provider: row.ingestProvider },
      article_count: event.articleCount ?? 1,
    },
    what_happened: event.summary ?? event.headline,
    why_it_matters: event.reasoning ?? event.summary ?? "",
    expectation_vs_actual: {
      eps_surprise_pct: epsActual !== null && epsConsensus !== null
        ? surprisePct(epsActual, epsConsensus).surprisePct : null,
      revenue_surprise_pct: revenueActual !== null && revenueConsensus !== null
        ? surprisePct(revenueActual, revenueConsensus).surprisePct : null,
      guidance_surprise_pct: earn?.guidanceActual !== null && earn?.guidanceActual !== undefined && earn?.guidanceConsensus !== null && earn?.guidanceConsensus !== undefined
        ? surprisePct(Number(earn.guidanceActual), Number(earn.guidanceConsensus)).surprisePct : null,
      expected: {
        eps: epsConsensus,
        revenue: revenueConsensus,
        guidance: num(earn?.guidanceConsensus),
      },
      actual: {
        eps: epsActual,
        revenue: revenueActual,
        guidance: num(earn?.guidanceActual),
      },
      fiscal_period: earn?.fiscalPeriod ?? event.fiscalPeriod ?? null,
      reported_at: earn?.reportedAt?.toISOString() ?? null,
      units: { eps: earn?.epsUnit ?? epsEstimate?.unit ?? null, revenue: earn?.revenueUnit ?? revenueEstimate?.unit ?? null },
      currencies: { eps: earn?.epsCurrency ?? epsEstimate?.currency ?? null, revenue: earn?.revenueCurrency ?? revenueEstimate?.currency ?? null },
      eps_type: earn?.epsType ?? epsEstimate?.epsType ?? null,
      consensus_source: earn?.consensusSource ?? epsEstimate?.source ?? revenueEstimate?.source ?? null,
      provider: earn?.provider ?? epsEstimate?.provider ?? revenueEstimate?.provider ?? null,
      data_status: earn
        ? storedFeedStatus(earn.dataStatus, earn.updatedAt, "fundamental", now)
        : epsEstimate
          ? storedFeedStatus(epsEstimate.dataStatus, epsEstimate.updatedAt, "fundamental", now)
          : revenueEstimate
            ? storedFeedStatus(revenueEstimate.dataStatus, revenueEstimate.updatedAt, "fundamental", now)
            : "UNAVAILABLE",
      note: guidanceUnverified
        ? "Guidance claim is unverified: there are no guidance figures or a matching verbatim source excerpt."
        : earn
        ? earn.guidanceActual === null && earn.guidanceConsensus === null
          ? "Actual and consensus figures are linked to this event and fiscal period. Guidance figures are unavailable unless supported by numbers or a verbatim article excerpt."
          : "Figures are linked to this event and fiscal period."
        : epsEstimate || revenueEstimate
          ? "Consensus estimates are linked to this event and fiscal period; actual figures are unavailable. Guidance requires figures or a verbatim article excerpt."
          : "No FMP estimate or earnings record is linked to this ticker and fiscal period.",
    },
    price_reaction: {
      at_publication: reactionInputs?.reaction.atPublication.price ?? null,
      reaction_1m: reactionInputs?.reaction.reaction1m ?? null,
      reaction_5m: reactionInputs?.reaction.reaction5m ?? null,
      reaction_15m: reactionInputs?.reaction.reaction15m ?? null,
      reaction_30m: reactionInputs?.reaction.reaction30m ?? null,
      reaction_60m: reactionInputs?.reaction.reaction60m ?? null,
      reaction_daily: reactionInputs?.reaction.reactionDaily ?? null,
      volume: row.rvolVolume,
      rvol,
      vwap: reactionInputs?.reaction.vwap ?? num(technical?.vwap),
      atr_pct: atrPctFromTechnical(technical, lastPrice) ?? reactionInputs?.reaction.atrPct ?? null,
      gap_pct: reactionInputs?.reaction.gapPct ?? num(price?.gapPct),
      peak_60m: reactionInputs?.reaction.peak60m ?? null,
      trough_60m: reactionInputs?.reaction.trough60m ?? null,
    },
    volume_reaction: {
      cumulative: row.rvolVolume,
      expected_to_date: num(row.rvolExpectedVolume),
      rvol,
      profile: rvol === null ? "unavailable" : rvol >= 1.5 ? "elevated" : "normal",
      session: row.rvolSession,
      as_of: row.rvolAsOf?.toISOString() ?? null,
      sample_count: row.rvolSampleCount,
      data_status: ticker ? storedFeedStatus(price?.dataStatus, price?.ts, "market", now) : "UNAVAILABLE",
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
      [
      ...macroPoints.filter((m) => !trackedEtfs.has(m.series)).map((m) => [
        m.series,
        { value: m.value, previous: m.previousValue ?? null, change: m.change ?? null, unit: m.unit ?? null, as_of: toIso(macroLatest.get(m.series)?.ts), data_status: macroLatest.get(m.series)?.dataStatus ?? "UNAVAILABLE" },
      ]),
      ...[...trackedEtfs].map((symbol) => {
        const snapshot = priceSnaps.get(symbol);
        const previous = num(snapshot?.prevClose ?? null);
        return [symbol, {
          value: num(snapshot?.price ?? null),
          previous,
          change: num(snapshot?.changePctDaily ?? null),
          unit: "%",
          as_of: snapshot?.ts.toISOString() ?? null,
          reference_price: previous,
          reference_period: "daily vs prior regular-session close",
          data_status: storedFeedStatus(snapshot?.dataStatus, snapshot?.ts, "market", now),
        }];
      }),
      ],
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
      ...(event.publishedAt ? [{ ts: event.publishedAt.toISOString(), label: "Event published", kind: "event" }] : []),
      { ts: event.firstReceivedAt.toISOString(), label: "First received", kind: "received" },
      { ts: toIso(event.latestUpdateAt), label: "Last update", kind: "update" },
    ],
    sources: sourceEvidence,
    impact_breakdown: impact.components,
    impact_score: {
      current: storedScore,
      computed_at: row.computedAt?.toISOString() ?? null,
      initial: num(row.initialScore),
      initial_computed_at: row.initialComputedAt?.toISOString() ?? null,
    },
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
