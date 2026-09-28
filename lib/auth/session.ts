import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { config } from "@/lib/config";

/**
 * Stateless, signed session cookie.
 *
 * `mp_session` = base64url(JSON payload) + "." + base64url(HMAC-SHA256(body, secret))
 *
 * The payload is only integrity-protected, not encrypted — it carries no secret
 * (just the user id, email and issue/expiry timestamps). A tampered body, a
 * tampered signature, an expired token or a mismatched secret all fail closed.
 */

export const SESSION_COOKIE_NAME = "mp_session";
export const SESSION_TTL_DAYS = 7;

export interface SessionPayload {
  uid: string;
  email: string;
  iat: number;
  exp: number;
}

export interface SessionUser {
  id: string;
  email: string;
}

export type SessionVerifyResult =
  | { ok: true; payload: SessionPayload }
  | { ok: false; reason: string };

const payloadSchema = z
  .object({
    uid: z.string().min(1),
    email: z.string().min(1).max(320),
    iat: z.number().int(),
    exp: z.number().int(),
  })
  .strict();

function base64url(input: Buffer): string {
  return input.toString("base64url");
}

/**
 * The configured HMAC key. Throws a clear, actionable error when auth is on but
 * the secret is missing/short, so a misconfigured deployment fails closed
 * instead of silently signing with a weak key.
 */
export function resolveSessionSecret(): string {
  const secret = config.sessionSecret;
  if (secret === null || secret.length < 32) {
    throw new Error(
      config.authConfigError ?? "SESSION_SECRET must be set to at least 32 characters",
    );
  }
  return secret;
}

/** Signs an already-built payload. Exported for tests and internal use. */
export function signSessionPayload(payload: SessionPayload, secret: string): string {
  const body = base64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const signature = base64url(createHmac("sha256", secret).update(body).digest());
  return `${body}.${signature}`;
}

/** Verifies a token against an explicit secret. Exported for tests. */
export function verifySessionTokenWithSecret(
  token: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): SessionVerifyResult {
  if (typeof token !== "string" || token.length === 0) {
    return { ok: false, reason: "missing_token" };
  }
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) {
    return { ok: false, reason: "malformed_token" };
  }
  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = base64url(createHmac("sha256", secret).update(body).digest());

  const provided = Buffer.from(signature, "base64url");
  const wanted = Buffer.from(expected, "base64url");
  if (provided.length !== wanted.length || !timingSafeEqual(provided, wanted)) {
    return { ok: false, reason: "bad_signature" };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed_token" };
  }
  const parsed = payloadSchema.safeParse(decoded);
  if (!parsed.success) {
    return { ok: false, reason: "malformed_payload" };
  }
  if (parsed.data.exp <= nowSeconds) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, payload: parsed.data };
}

/** Creates a signed session token for a user, valid for `ttlDays`. */
export function createSessionToken(user: SessionUser, ttlDays: number = SESSION_TTL_DAYS): string {
  const secret = resolveSessionSecret();
  const iat = Math.floor(Date.now() / 1000);
  const ttl = Number.isFinite(ttlDays) && ttlDays > 0 ? Math.floor(ttlDays) : SESSION_TTL_DAYS;
  const exp = iat + ttl * 86_400;
  return signSessionPayload({ uid: user.id, email: user.email, iat, exp }, secret);
}

/** Verifies the `mp_session` token using the configured secret. */
export function verifySessionToken(token: string): SessionVerifyResult {
  let secret: string;
  try {
    secret = resolveSessionSecret();
  } catch {
    return { ok: false, reason: "secret_missing" };
  }
  return verifySessionTokenWithSecret(token, secret);
}

export interface SessionCookieOptions {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: string;
  maxAge: number;
}

/** Cookie attributes for `mp_session`. `secure` follows the app URL scheme. */
export function sessionCookieOptions(): SessionCookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: (config.appUrl ?? "").startsWith("https://"),
    path: "/",
    maxAge: SESSION_TTL_DAYS * 86_400,
  };
}
