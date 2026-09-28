import { z } from "zod";

import { alertConditionsSchema } from "@/lib/alerts/conditions";
import { errorResponse, jsonResponse, notFound } from "@/lib/http";
import { deleteAlert, updateAlert } from "@/lib/services/alerts";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  enabled: z.boolean().optional(),
  conditions: alertConditionsSchema.optional(),
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const body: unknown = await request.json().catch(() => null);
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(parsed.error);
    }
    const updated = await updateAlert(id, parsed.data);
    if (!updated) {
      return notFound("Alert rule not found");
    }
    return jsonResponse({ data: updated });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const deleted = await deleteAlert(id);
    if (!deleted) {
      return notFound("Alert rule not found");
    }
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
