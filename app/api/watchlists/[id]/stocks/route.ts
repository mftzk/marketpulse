import { z } from "zod";

import { tickerFilter } from "@/lib/core/filters";
import { errorResponse, jsonResponse } from "@/lib/http";
import { addStock, getWatchlist } from "@/lib/services/watchlists";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const addStockSchema = z.object({ ticker: z.string().min(1).max(20) });

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const body: unknown = await request.json().catch(() => null);
    const parsed = addStockSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(parsed.error);
    }
    const ticker = tickerFilter.safeParse(parsed.data.ticker);
    if (!ticker.success) {
      return errorResponse(ticker.error);
    }
    await addStock(id, ticker.data);
    const watchlist = await getWatchlist(id);
    return jsonResponse({ data: watchlist }, 201);
  } catch (err) {
    return errorResponse(err);
  }
}
