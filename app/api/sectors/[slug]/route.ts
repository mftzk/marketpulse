import { sectorFilter } from "@/lib/core/filters";
import { AppError } from "@/lib/errors";
import { errorResponse, jsonResponse, notFound } from "@/lib/http";
import { getSector } from "@/lib/services/sectors";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  try {
    const { slug } = await params;
    const parsed = sectorFilter.safeParse(slug);
    if (!parsed.success) {
      throw new AppError("validation_error", "Invalid sector slug");
    }
    const sector = await getSector(parsed.data);
    if (!sector) {
      return notFound("Sector not found");
    }
    return jsonResponse({ data: sector });
  } catch (err) {
    return errorResponse(err);
  }
}
