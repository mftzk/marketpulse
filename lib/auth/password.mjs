import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Password hashing — the single source of truth for both the app
 * (`lib/auth/password.ts`) and the release-time seeder (`scripts/seed.mjs`).
 * This file is dependency-free ESM (`node:crypto` only) so it can run at
 * release time; `npm run build` copies it into `.next/standalone/lib/auth/`.
 *
 * Format: `scrypt$<N>$<r>$<p>$<saltBase64>$<keyBase64>`
 * scrypt parameters: N=16384, r=8, p=1, 64-byte derived key, 16-byte random salt.
 */

export const SCRYPT_N = 16384;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
export const SCRYPT_KEY_LENGTH = 64;
export const SCRYPT_SALT_BYTES = 16;

const MAX_MEM = 64 * 1024 * 1024;

/** Derives the scrypt hash string for a plaintext password. */
export function hashPassword(plain) {
  if (typeof plain !== "string" || plain.length === 0) {
    throw new Error("password must be a non-empty string");
  }
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const key = scryptSync(plain, salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: MAX_MEM,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

/** Constant-time verification of a plaintext password against a stored hash. */
export function verifyPassword(plain, hash) {
  if (typeof plain !== "string" || typeof hash !== "string") {
    return false;
  }
  const parts = hash.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    return false;
  }
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  // Only the parameters this module emits are accepted — this both rejects
  // malformed hashes and prevents a hostile hash from requesting huge work.
  if (N !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P) {
    return false;
  }
  const salt = Buffer.from(parts[4], "base64");
  const expected = Buffer.from(parts[5], "base64");
  if (salt.length === 0 || expected.length === 0) {
    return false;
  }
  let derived;
  try {
    derived = scryptSync(plain, salt, expected.length, { N, r, p, maxmem: MAX_MEM });
  } catch {
    return false;
  }
  if (derived.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(derived, expected);
}
