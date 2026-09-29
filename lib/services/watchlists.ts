import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import { config } from "@/lib/config";
import { sessionFor } from "@/lib/core/session";
import type { WatchlistDTO, WatchlistStockDTO } from "@/lib/core/detail";
import { AppError } from "@/lib/errors";
import { getDb } from "@/lib/db/client";
import { latestEventByTicker } from "@/lib/db/queries/events";
import { latestPriceSnapshots, latestVolumeSnapshots } from "@/lib/db/queries/market-data";
import { companies, users, watchlistStocks, watchlists } from "@/lib/db/schema";
import { num } from "@/lib/services/shared";
import { storedFeedStatus } from "@/lib/providers";

async function getAdminUserId(): Promise<string> {
  const db = getDb();
  const rows = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${config.adminEmail}`).limit(1);
  const user = rows[0];
  if (!user) {
    throw new AppError("not_found", "No admin user found");
  }
  return user.id;
}

function emptyStock(ticker: string, note: string | null = null): WatchlistStockDTO {
  return {
    ticker,
    note,
    price: null,
    change_pct: null,
    rvol: null,
    rvol_as_of: null,
    rvol_session: null,
    rvol_volume: null,
    rvol_expected_volume: null,
    rvol_sample_count: null,
    rvol_data_status: "UNAVAILABLE",
    latest_catalyst: null,
    catalyst_age_minutes: null,
    impact_score: null,
  };
}

/**
 * Batched per-ticker rows for every watchlist at once (phase 3c): one price
 * query, one volume query and one latest-event query for ALL tickers, instead
 * of three queries per ticker. Do not loop a query inside this function.
 */
async function stockRows(tickers: string[]): Promise<Map<string, WatchlistStockDTO>> {
  const db = getDb();
  const unique = [...new Set(tickers)].filter((t) => t.length > 0);
  const result = new Map<string, WatchlistStockDTO>();
  if (unique.length === 0) {
    return result;
  }

  const now = Date.now();
  const [prices, volumes, events] = await Promise.all([
    latestPriceSnapshots(db, unique),
    latestVolumeSnapshots(db, unique, sessionFor(new Date(now))),
    latestEventByTicker(db, unique),
  ]);

  for (const ticker of unique) {
    const price = prices.get(ticker) ?? null;
    const volume = volumes.get(ticker) ?? null;
    const event = events.get(ticker) ?? null;
    result.set(ticker, {
      ticker,
      note: null,
      price: num(price?.price),
      change_pct: num(price?.changePctDaily),
      rvol: num(volume?.rvol),
      rvol_as_of: volume?.rvolAsOf?.toISOString() ?? null,
      rvol_session: volume?.session ?? null,
      rvol_volume: volume?.cumulativeVolume ?? null,
      rvol_expected_volume: num(volume?.expectedVolumeToDate),
      rvol_sample_count: volume?.expectedSampleCount ?? null,
      rvol_data_status: storedFeedStatus(volume?.dataStatus, volume?.rvolAsOf, "market", new Date(now)),
      latest_catalyst: event?.headline ?? null,
      catalyst_age_minutes: event?.publishedAt
        ? Math.max(0, Math.floor((now - event.publishedAt.getTime()) / 60_000))
        : null,
      impact_score: num(event?.score),
    });
  }

  return result;
}

function hydrate(
  stocks: (typeof watchlistStocks.$inferSelect)[],
  stockMap: Map<string, WatchlistStockDTO>,
): WatchlistStockDTO[] {
  return stocks.map((s) => ({
    ...(stockMap.get(s.ticker) ?? emptyStock(s.ticker)),
    note: s.note ?? null,
  }));
}

export async function listWatchlists(): Promise<WatchlistDTO[]> {
  const db = getDb();
  const userId = await getAdminUserId();
  const lists = await db.select().from(watchlists).where(eq(watchlists.userId, userId)).orderBy(desc(watchlists.isDefault), asc(watchlists.name));
  if (lists.length === 0) {
    return [];
  }

  // One query for every list's tickers, then one batched stock lookup.
  const allStocks = await db
    .select()
    .from(watchlistStocks)
    .where(inArray(watchlistStocks.watchlistId, lists.map((l) => l.id)));
  const stocksByList = new Map<string, (typeof allStocks)[number][]>();
  for (const stock of allStocks) {
    const list = stocksByList.get(stock.watchlistId);
    if (list) {
      list.push(stock);
    } else {
      stocksByList.set(stock.watchlistId, [stock]);
    }
  }

  const stockMap = await stockRows(allStocks.map((s) => s.ticker));

  return lists.map((list) => ({
    id: list.id,
    name: list.name,
    description: list.description,
    is_default: list.isDefault,
    stocks: hydrate(stocksByList.get(list.id) ?? [], stockMap),
  }));
}

export async function createWatchlist(input: { name: string; description?: string }): Promise<WatchlistDTO> {
  const db = getDb();
  const userId = await getAdminUserId();

  const existing = await db.select().from(watchlists).where(and(eq(watchlists.userId, userId), eq(watchlists.name, input.name)));
  if (existing.length > 0) {
    throw new AppError("conflict", "Watchlist name already exists");
  }

  const inserted = await db
    .insert(watchlists)
    .values({ userId, name: input.name, description: input.description ?? null, isDefault: false })
    .returning();
  const created = inserted[0];

  return { id: created.id, name: created.name, description: created.description, is_default: created.isDefault, stocks: [] };
}

export async function getWatchlist(id: string): Promise<WatchlistDTO | null> {
  const db = getDb();
  const list = (await db.select().from(watchlists).where(eq(watchlists.id, id)).limit(1))[0];
  if (!list) {
    return null;
  }
  const stocks = await db.select().from(watchlistStocks).where(eq(watchlistStocks.watchlistId, id));
  const stockMap = await stockRows(stocks.map((s) => s.ticker));
  return {
    id: list.id,
    name: list.name,
    description: list.description,
    is_default: list.isDefault,
    stocks: hydrate(stocks, stockMap),
  };
}

export async function updateWatchlist(id: string, input: { name?: string; description?: string | null }): Promise<WatchlistDTO | null> {
  const db = getDb();
  const existing = (await db.select().from(watchlists).where(eq(watchlists.id, id)).limit(1))[0];
  if (!existing) {
    return null;
  }
  await db
    .update(watchlists)
    .set({ name: input.name ?? existing.name, description: input.description !== undefined ? input.description : existing.description, updatedAt: new Date() })
    .where(eq(watchlists.id, id));
  return getWatchlist(id);
}

export async function deleteWatchlist(id: string): Promise<boolean> {
  const db = getDb();
  const existing = (await db.select({ id: watchlists.id }).from(watchlists).where(eq(watchlists.id, id)).limit(1))[0];
  if (!existing) {
    return false;
  }
  await db.delete(watchlists).where(eq(watchlists.id, id));
  return true;
}

export async function addStock(watchlistId: string, ticker: string): Promise<void> {
  const db = getDb();
  const list = (await db.select({ id: watchlists.id }).from(watchlists).where(eq(watchlists.id, watchlistId)).limit(1))[0];
  if (!list) {
    throw new AppError("not_found", "Watchlist not found");
  }
  const company = (await db.select({ ticker: companies.ticker }).from(companies).where(eq(companies.ticker, ticker)).limit(1))[0];
  if (!company) {
    throw new AppError("not_found", "Unknown ticker");
  }
  const existing = await db.select().from(watchlistStocks).where(and(eq(watchlistStocks.watchlistId, watchlistId), eq(watchlistStocks.ticker, ticker)));
  if (existing.length > 0) {
    throw new AppError("conflict", "Ticker already in watchlist");
  }
  await db.insert(watchlistStocks).values({ watchlistId, ticker });
}

export async function removeStock(watchlistId: string, ticker: string): Promise<boolean> {
  const db = getDb();
  const existing = (await db.select({ id: watchlistStocks.id }).from(watchlistStocks).where(and(eq(watchlistStocks.watchlistId, watchlistId), eq(watchlistStocks.ticker, ticker))).limit(1))[0];
  if (!existing) {
    return false;
  }
  await db.delete(watchlistStocks).where(eq(watchlistStocks.id, existing.id));
  return true;
}
