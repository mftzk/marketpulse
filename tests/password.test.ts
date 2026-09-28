import { describe, expect, it } from "vitest";

import { hashPassword, verifyPassword } from "@/lib/auth/password";

describe("password hashing (scrypt)", () => {
  it("accepts the correct password", () => {
    const hash = hashPassword("correct horse battery staple");
    expect(verifyPassword("correct horse battery staple", hash)).toBe(true);
  });

  it("rejects the wrong password", () => {
    const hash = hashPassword("right-password");
    expect(verifyPassword("wrong-password", hash)).toBe(false);
    expect(verifyPassword("", hash)).toBe(false);
  });

  it("salts each hash so two hashes of the same password differ", () => {
    const first = hashPassword("same-password");
    const second = hashPassword("same-password");
    expect(first).not.toBe(second);
    expect(verifyPassword("same-password", first)).toBe(true);
    expect(verifyPassword("same-password", second)).toBe(true);
  });

  it("encodes the documented scrypt format", () => {
    const parts = hashPassword("x").split("$");
    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe("scrypt");
    expect(parts[1]).toBe("16384");
    expect(parts[2]).toBe("8");
    expect(parts[3]).toBe("1");
    expect(Buffer.from(parts[4], "base64")).toHaveLength(16);
    expect(Buffer.from(parts[5], "base64")).toHaveLength(64);
  });

  it("rejects malformed hashes without throwing", () => {
    for (const bad of [
      "",
      "not-a-hash",
      "scrypt$1$2$3$onlyfive",
      "bcrypt$16384$8$1$c2FsdA==$a2V5",
      "scrypt$16384$8$1$$",
    ]) {
      expect(verifyPassword("x", bad), bad).toBe(false);
    }
  });

  it("refuses to hash an empty password", () => {
    expect(() => hashPassword("")).toThrow();
  });
});
