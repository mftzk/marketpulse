import { errorResponse, jsonResponse } from "@/lib/http";
import { getPipelineStatus } from "@/lib/services/pipeline";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(): Promise<Response> {
  try {
    const status = await getPipelineStatus();
    return jsonResponse({ data: status });
  } catch (err) {
    return errorResponse(err);
  }
}
