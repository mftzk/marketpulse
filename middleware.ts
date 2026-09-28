import { NextResponse, type NextRequest } from "next/server";

import { isApiPath, shouldBypassAuth } from "@/lib/auth/policy";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth/session";
import { config as appConfig } from "@/lib/config";

/**
 * Auth gate (§ Phase 4). Runs on the Node.js runtime (so the same
 * `node:crypto`-based session helpers used by the API routes verify the token),
 * never touches the database, and fails closed.
 *
 * Public: `/login`, `POST /api/auth/login`, `GET /api/health`, Next static
 * assets, favicon/icon/robots/opengraph. Everything else needs a valid
 * `mp_session` cookie; API routes get a JSON 401, pages are redirected to
 * `/login?next=<path>`.
 */
export const runtime = "nodejs";

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

function unauthorized(): NextResponse {
  return NextResponse.json({ error: "Unauthorized", code: "unauthorized" }, { status: 401 });
}

function unavailable(): NextResponse {
  return NextResponse.json(
    { error: "Auth is not configured", code: "unavailable" },
    { status: 503 },
  );
}

export function middleware(request: NextRequest): NextResponse {
  if (!appConfig.authEnabled) {
    return NextResponse.next();
  }

  const { pathname } = request.nextUrl;
  if (shouldBypassAuth(pathname)) {
    return NextResponse.next();
  }

  // Fail closed if AUTH_ENABLED=1 but the signing secret is missing/short.
  if (appConfig.authConfigError !== null) {
    return isApiPath(pathname)
      ? unavailable()
      : new NextResponse("Service unavailable: SESSION_SECRET is not configured", {
          status: 503,
        });
  }

  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const result = token ? verifySessionToken(token) : { ok: false as const, reason: "missing_token" };
  if (result.ok) {
    return NextResponse.next();
  }

  if (isApiPath(pathname)) {
    return unauthorized();
  }

  const loginUrl = request.nextUrl.clone();
  const next = `${pathname}${request.nextUrl.search ?? ""}`;
  loginUrl.pathname = "/login";
  loginUrl.search = "";
  loginUrl.searchParams.set("next", next);
  return NextResponse.redirect(loginUrl, 302);
}
