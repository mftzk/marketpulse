/**
 * Pure routing decisions for the auth gate. Kept free of Next.js imports so the
 * middleware's behaviour is unit-testable without a request/DB.
 */

/** Paths that are reachable without a session (exact match). */
const PUBLIC_EXACT = new Set([
  "/login",
  "/favicon.ico",
  "/icon.svg",
  "/robots.txt",
]);

/** Prefixes that are reachable without a session. */
const PUBLIC_PREFIXES = ["/_next/", "/opengraph-image"];

/** True for any API route. API calls get a JSON 401, pages get a redirect. */
export function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

/**
 * True when the path must be allowed through the gate. Everything else (every
 * page and every API route except `POST /api/auth/login` and `GET /api/health`)
 * requires a valid `mp_session` cookie.
 */
export function shouldBypassAuth(pathname: string): boolean {
  if (typeof pathname !== "string" || pathname.length === 0) {
    return false;
  }
  // Normalise a single trailing slash (`/login/` -> `/login`).
  const path =
    pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;

  if (PUBLIC_EXACT.has(path)) {
    return true;
  }
  if (path === "/api/auth/login" || path === "/api/health") {
    return true;
  }
  return PUBLIC_PREFIXES.some((prefix) => path.startsWith(prefix));
}
