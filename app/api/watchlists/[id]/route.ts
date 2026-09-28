import { z } from "zod";

import { errorResponse, jsonResponse, notFound } from "@/lib/http";
import { deleteWatchlist, getWatchlist, updateWatchlist } from "@/lib/services/watchlists";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).nullable().optional(),
});

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const watchlist = await getWatchlist(id);
    if (!watchlist) {
      return notFound("Watchlist not found");
    }
    return jsonResponse({ data: watchlist });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const body: unknown = await request.json().catch(() => null);
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(parsed.error);
    }
    const updated = await updateWatchlist(id, parsed.data);
    if (!updated) {
      return notFound("Watchlist not found");
    }
    return jsonResponse({ data: updated });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const deleted = await deleteWatchlist(id);
    if (!deleted) {
      return notFound("Watchlist not found");
    }
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
