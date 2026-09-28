import { eq } from "drizzle-orm";
import { cookies } from "next/headers";

import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { errorResponse, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function unauthorized(): Response {
  return jsonResponse({ error: "Unauthorized", code: "unauthorized" }, 401);
}

export async function GET(): Promise<Response> {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
    const result = token ? verifySessionToken(token) : { ok: false as const, reason: "missing_token" };
    if (!result.ok) {
      return unauthorized();
    }

    const db = getDb();
    const rows = await db
      .select()
      .from(users)
      .where(eq(users.id, result.payload.uid))
      .limit(1);
    const user = rows[0];
    if (!user) {
      return unauthorized();
    }

    return jsonResponse({
      data: {
        id: user.id,
        email: user.email,
        display_name: user.displayName,
        is_demo: user.isDemo,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
