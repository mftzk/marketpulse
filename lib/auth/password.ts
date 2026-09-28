import { hashPassword as coreHashPassword, verifyPassword as coreVerifyPassword } from "./password.mjs";

/**
 * Typed facade over the shared, dependency-free implementation in
 * `password.mjs`. The seeder imports the same module, so the hash the seeder
 * writes is guaranteed to verify here (see `tests/password.test.ts`).
 */
export function hashPassword(plain: string): string {
  return coreHashPassword(plain);
}

export function verifyPassword(plain: string, hash: string): boolean {
  return coreVerifyPassword(plain, hash);
}
