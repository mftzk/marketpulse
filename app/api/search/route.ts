import { z } from "zod";

import { errorResponse, jsonResponse } from "@/lib/http";
import { search } from "@/lib/services/search";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const searchSchema = z.object({
  q: z.string().trim().min(1).max(200),
});

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const q = url.searchParams.get("q") ?? "";
    const parsed = searchSchema.safeParse({ q });
    if (!parsed.success) {
      return errorResponse(parsed.error);
    }
    const result = await search(parsed.data.q);
    return jsonResponse({ data: result });
  } catch (err) {
    return errorResponse(err);
  }
}
