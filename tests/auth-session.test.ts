import { describe, expect, it } from "vitest";

import {
  SESSION_COOKIE_NAME,
  createSessionToken,
  sessionCookieOptions,
  signSessionPayload,
  verifySessionToken,
  verifySessionTokenWithSecret,
} from "@/lib/auth/session";

const SECRET = "unit-test-secret-0123456789abcdefghij";
const USER = { id: "11111111-2222-4333-8444-555555555555", email: "trader@example.com" };

describe("session tokens", () => {
  it("signs and verifies a fresh token", () => {
    const token = createSessionToken(USER);
    const result = verifySessionToken(token);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.uid).toBe(USER.id);
      expect(result.payload.email).toBe(USER.email);
      expect(result.payload.exp).toBeGreaterThan(result.payload.iat);
    }
  });

  it("rejects an expired token", () => {
    const iat = 1_000_000;
    const token = signSessionPayload(
      { uid: USER.id, email: USER.email, iat, exp: iat + 10 },
      SECRET,
    );
    expect(verifySessionTokenWithSecret(token, SECRET, iat + 100)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("rejects a tampered body", () => {
    const token = createSessionToken(USER);
    const [body, signature] = token.split(".");
    const last = body.slice(-1);
    const tamperedBody = `${body.slice(0, -1)}${last === "A" ? "B" : "A"}`;
    const result = verifySessionToken(`${tamperedBody}.${signature}`);
    expect(result.ok).toBe(false);
  });

  it("rejects a tampered signature", () => {
    const token = createSessionToken(USER);
    const [body] = token.split(".");
    expect(verifySessionToken(`${body}.deadbeef`).ok).toBe(false);
  });

  it("rejects a token signed with a different secret", () => {
    const token = signSessionPayload(
      { uid: USER.id, email: USER.email, iat: 1, exp: 9_999_999_999 },
      SECRET,
    );
    const result = verifySessionTokenWithSecret(token, `${SECRET}-other`);
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects malformed tokens", () => {
    expect(verifySessionToken("").ok).toBe(false);
    expect(verifySessionToken("no-dot-at-all").ok).toBe(false);
    expect(verifySessionToken("body.").ok).toBe(false);
    expect(verifySessionToken(".sig").ok).toBe(false);
  });

  it("uses a hardened cookie policy", () => {
    const options = sessionCookieOptions();
    expect(SESSION_COOKIE_NAME).toBe("mp_session");
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe("lax");
    expect(options.path).toBe("/");
    expect(options.maxAge).toBeGreaterThan(0);
    expect(typeof options.secure).toBe("boolean");
  });
});
