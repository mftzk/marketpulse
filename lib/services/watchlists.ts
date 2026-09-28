import { and, asc, desc, eq } from "drizzle-orm";

import type { WatchlistDTO, WatchlistStockDTO } from "@/lib/core/detail";
import { AppError } from "@/lib/errors";
import { getDb } from "@/lib/db/client";
import {
  companies,
  impactScores,
  marketEvents,
  priceSnapshots,
  users,
  volumeSnapshots,
  watchlistStocks,
  watchlists,
} from "@/lib/db/schema";
import { num } from "@/lib/services/shared";

const DEMO_EMAIL = "demo@marketpulse.dev";

async function getDemoUserId(): Promise<string> {
  const db = getDb();
  const rows = await db.select({ id: users.id }).from(users).where(eq(users.email, DEMO_EMAIL)).limit(1);
  const user = rows[0];
  if (!user) {
    throw new AppError("not_found", "No demo user found");
  }
  return user.id;
}

async function stockRows(tickers: string[]): Promise<Map<string, WatchlistStockDTO>> {
  const db = getDb();
  const result = new Map<string, WatchlistStockDTO>();

  for (const ticker of tickers) {
    const price = (await db.select().from(priceSnapshots).where(eq(priceSnapshots.ticker, ticker)).orderBy(desc(priceSnapshots.ts)).limit(1))[0] ?? null;
    const volume = (await db.select().from(volumeSnapshots).where(eq(volumeSnapshots.ticker, ticker)).orderBy(desc(volumeSnapshots.ts)).limit(1))[0] ?? null;
    const event = (await db
      .select({
        headline: marketEvents.headline,
        publishedAt: marketEvents.publishedAt,
        score: impactScores.score,
      })
      .from(marketEvents)
      .leftJoin(impactScores, eq(impactScores.eventId, marketEvents.id))
      .where(eq(marketEvents.ticker, ticker))
      .orderBy(desc(marketEvents.publishedAt))
      .limit(1))[0] ?? null;

    result.set(ticker, {
      ticker,
      note: null,
      price: num(price?.price),
      change_pct: num(price?.changePctDaily),
      rvol: num(volume?.rvol),
      latest_catalyst: event?.headline ?? null,
      catalyst_age_minutes: event?.publishedAt ? Math.max(0, Math.floor((Date.now() - event.publishedAt.getTime()) / 60_000)) : null,
      impact_score: num(event?.score),
    });
  }

  return result;
}

export async function listWatchlists(): Promise<WatchlistDTO[]> {
  const db = getDb();
  const userId = await getDemoUserId();
  const lists = await db.select().from(watchlists).where(eq(watchlists.userId, userId)).orderBy(desc(watchlists.isDefault), asc(watchlists.name));

  const result: WatchlistDTO[] = [];
  for (const list of lists) {
    const stocks = await db.select().from(watchlistStocks).where(eq(watchlistStocks.watchlistId, list.id));
    const tickers = stocks.map((s) => s.ticker);
    const stockMap = await stockRows(tickers);
    const stockNotes = new Map(stocks.map((s) => [s.ticker, s.note]));

    result.push({
      id: list.id,
      name: list.name,
      description: list.description,
      is_default: list.isDefault,
      stocks: stocks.map((s) => ({ ...(stockMap.get(s.ticker) ?? { ticker: s.ticker, note: null, price: null, change_pct: null, rvol: null, latest_catalyst: null, catalyst_age_minutes: null, impact_score: null }), note: stockNotes.get(s.ticker) ?? null })),
    });
  }

  return result;
}

export async function createWatchlist(input: { name: string; description?: string }): Promise<WatchlistDTO> {
  const db = getDb();
  const userId = await getDemoUserId();

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
  const tickers = stocks.map((s) => s.ticker);
  const stockMap = await stockRows(tickers);
  const notes = new Map(stocks.map((s) => [s.ticker, s.note]));
  return {
    id: list.id,
    name: list.name,
    description: list.description,
    is_default: list.isDefault,
    stocks: stocks.map((s) => ({ ...(stockMap.get(s.ticker) ?? { ticker: s.ticker, note: null, price: null, change_pct: null, rvol: null, latest_catalyst: null, catalyst_age_minutes: null, impact_score: null }), note: notes.get(s.ticker) ?? null })),
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
