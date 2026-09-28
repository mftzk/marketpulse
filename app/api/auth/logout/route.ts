import { SESSION_COOKIE_NAME, sessionCookieOptions } from "@/lib/auth/session";
import { jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(): Promise<Response> {
  const response = jsonResponse({ data: { ok: true } });
  response.cookies.set(SESSION_COOKIE_NAME, "", { ...sessionCookieOptions(), maxAge: 0 });
  return response;
}
