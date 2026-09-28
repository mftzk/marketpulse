import { z } from "zod";

import { errorResponse, jsonResponse } from "@/lib/http";
import { createWatchlist, listWatchlists } from "@/lib/services/watchlists";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const createWatchlistSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
});

export async function GET(): Promise<Response> {
  try {
    const watchlists = await listWatchlists();
    return jsonResponse({ data: watchlists });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body: unknown = await request.json().catch(() => null);
    const parsed = createWatchlistSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(parsed.error);
    }
    const created = await createWatchlist(parsed.data);
    return jsonResponse({ data: created }, 201);
  } catch (err) {
    return errorResponse(err);
  }
}
