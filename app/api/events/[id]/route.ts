import { errorResponse, jsonResponse, notFound } from "@/lib/http";
import { getEventDetail } from "@/lib/services/events";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const result = await getEventDetail(id);
    if (!result) {
      return notFound("Event not found");
    }
    return jsonResponse({ data: result });
  } catch (err) {
    return errorResponse(err);
  }
}
