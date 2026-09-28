import { sql } from "drizzle-orm";
import { z } from "zod";

import { verifyPassword } from "@/lib/auth/password";
import { SESSION_COOKIE_NAME, createSessionToken, sessionCookieOptions } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { errorResponse, jsonResponse, rateLimitResponse } from "@/lib/http";
import { logger } from "@/lib/logger";
import { consumeRateLimit } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const loginSchema = z
  .object({
    email: z.string().trim().email().max(254),
    password: z.string().min(1).max(200),
  })
  .strict();

function clientIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body: unknown = await request.json().catch(() => null);
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(parsed.error);
    }
    const email = parsed.data.email.toLowerCase();

    // 10 attempts / 5 minutes per IP+email, before touching the database.
    if (await consumeRateLimit(`login:${clientIp(request)}:${email}`, 10, 300)) {
      return rateLimitResponse("Too many attempts");
    }

    const db = getDb();
    const rows = await db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`)
      .limit(1);
    const user = rows[0];

    const valid =
      user?.passwordHash != null && verifyPassword(parsed.data.password, user.passwordHash);
    if (!user || !valid) {
      // Same message and status whether the email is unknown or the password is
      // wrong — no user enumeration. Passwords are never logged.
      logger.warn("login_failed", { event: "auth.login" });
      return jsonResponse({ error: "Invalid email or password", code: "unauthorized" }, 401);
    }

    await db
      .update(users)
      .set({ lastLoginAt: new Date(), updatedAt: new Date() })
      .where(sql`${users.id} = ${user.id}`);

    const response = jsonResponse({
      data: {
        id: user.id,
        email: user.email,
        display_name: user.displayName,
        is_demo: user.isDemo,
      },
    });
    response.cookies.set(SESSION_COOKIE_NAME, createSessionToken({ id: user.id, email: user.email }), sessionCookieOptions());
    logger.info("login_succeeded", { event: "auth.login" });
    return response;
  } catch (err) {
    return errorResponse(err);
  }
}
