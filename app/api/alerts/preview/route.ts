import { alertConditionsSchema } from "@/lib/alerts/conditions";
import { errorResponse, jsonResponse } from "@/lib/http";
import { previewAlertConditions } from "@/lib/services/alerts";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: Request): Promise<Response> {
  try {
    const body: unknown = await request.json().catch(() => null);
    const parsed = alertConditionsSchema.safeParse((body as { conditions?: unknown } | null)?.conditions);
    if (!parsed.success) return errorResponse(parsed.error);
    const preview = await previewAlertConditions(parsed.data);
    return jsonResponse({ data: preview });
  } catch (err) {
    return errorResponse(err);
  }
}
