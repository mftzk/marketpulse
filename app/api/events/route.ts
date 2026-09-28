import { eventFiltersSchema } from "@/lib/core/filters";
import { errorResponse, jsonResponse, parseQuery } from "@/lib/http";
import { listEvents } from "@/lib/services/events";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request): Promise<Response> {
  try {
    const filters = parseQuery(request, eventFiltersSchema);
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
