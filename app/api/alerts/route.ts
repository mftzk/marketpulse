import { z } from "zod";

import { alertConditionsSchema } from "@/lib/alerts/conditions";
import { isChannelName } from "@/lib/alerts/channels";
import { AppError } from "@/lib/errors";
import { errorResponse, jsonResponse, rateLimitResponse } from "@/lib/http";
import { exceedsRateLimit } from "@/lib/ratelimit";
import { createAlert, listAlerts } from "@/lib/services/alerts";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const createAlertSchema = z.object({
  name: z.string().min(1).max(120),
  conditions: alertConditionsSchema,
  channels: z.array(z.string()).min(1),
  enabled: z.boolean().optional(),
  cooldown_minutes: z.number().int().min(1).max(1440).optional(),
  description: z.string().max(500).optional(),
});

export async function GET(): Promise<Response> {
  try {
    const result = await listAlerts();
    return jsonResponse({ data: result });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    if (await exceedsRateLimit(request, "alerts")) {
      return rateLimitResponse();
    }
    const body: unknown = await request.json().catch(() => null);
    const parsed = createAlertSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(parsed.error);
    }
    for (const channel of parsed.data.channels) {
      if (!isChannelName(channel)) {
        throw new AppError("validation_error", `Unknown channel: ${channel}`);
      }
    }
    const created = await createAlert(parsed.data);
    return jsonResponse({ data: created }, 201);
  } catch (err) {
    return errorResponse(err);
  }
}
