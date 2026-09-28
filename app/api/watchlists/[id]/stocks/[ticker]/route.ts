import { tickerFilter } from "@/lib/core/filters";
import { AppError } from "@/lib/errors";
import { errorResponse, notFound } from "@/lib/http";
import { removeStock } from "@/lib/services/watchlists";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; ticker: string }> },
): Promise<Response> {
  try {
    const { id, ticker: raw } = await params;
    const parsed = tickerFilter.safeParse(raw);
    if (!parsed.success) {
      throw new AppError("validation_error", "Invalid ticker symbol");
    }
    const removed = await removeStock(id, parsed.data);
    if (!removed) {
      return notFound("Ticker not in watchlist");
    }
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
