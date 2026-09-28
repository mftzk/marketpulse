import { tickerFilter } from "@/lib/core/filters";
import { AppError } from "@/lib/errors";
import { errorResponse, jsonResponse, notFound } from "@/lib/http";
import { getStock } from "@/lib/services/stocks";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ ticker: string }> },
): Promise<Response> {
  try {
    const { ticker: raw } = await params;
    const parsed = tickerFilter.safeParse(raw);
    if (!parsed.success) {
      throw new AppError("validation_error", "Invalid ticker symbol");
    }
    const stock = await getStock(parsed.data);
    if (!stock) {
      return notFound("Stock not found");
    }
    return jsonResponse({ data: stock });
  } catch (err) {
    return errorResponse(err);
  }
}
