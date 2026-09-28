import { z } from "zod";

import { errorResponse, jsonResponse } from "@/lib/http";
import { getReplay } from "@/lib/services/replay";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const replaySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
});

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const date = url.searchParams.get("date") ?? "";
    const parsed = replaySchema.safeParse({ date });
    if (!parsed.success) {
      return errorResponse(parsed.error);
    }
    const replay = await getReplay(parsed.data.date);
    return jsonResponse({ data: replay });
  } catch (err) {
    return errorResponse(err);
  }
}
