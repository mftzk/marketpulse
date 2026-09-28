import { errorResponse, jsonResponse } from "@/lib/http";
import { getMarketContext } from "@/lib/services/market-context";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(): Promise<Response> {
  try {
    const context = await getMarketContext();
    return jsonResponse({ data: context });
  } catch (err) {
    return errorResponse(err);
  }
}
