import { eventFiltersSchema, tickerFilter } from "@/lib/core/filters";
import { AppError } from "@/lib/errors";
import { errorResponse, jsonResponse, parseQuery } from "@/lib/http";
import { listEvents } from "@/lib/services/events";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ ticker: string }> },
): Promise<Response> {
  try {
    const { ticker: raw } = await params;
    const parsedTicker = tickerFilter.safeParse(raw);
    if (!parsedTicker.success) {
      throw new AppError("validation_error", "Invalid ticker symbol");
    }
    const filters = parseQuery(request, eventFiltersSchema);
    filters.ticker = parsedTicker.data;
    const result = await listEvents(filters);
    return jsonResponse({
      data: result.data,
      page: result.page,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
