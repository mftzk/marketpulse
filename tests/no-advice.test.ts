import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { COPY } from "@/lib/copy";
import { findAdvice } from "@/lib/scoring/language";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * The exact regex the smoke harness applies to every string returned by the API.
 * Kept in sync with `scripts/smoke.mjs`.
 */
const SMOKE_NO_ADVICE =
  /\b(buy|sell|recommend(ation)?s?|target price|take profit|enter at)\b/i;

function collectStrings(value: unknown, out: string[]): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, out);
    }
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectStrings(item, out);
    }
  }
  return out;
}

function walk(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, out);
    } else if (entry.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

describe("no-advice guard", () => {
  const copyStrings = collectStrings(COPY, []);

  it("covers a meaningful amount of copy", () => {
    expect(copyStrings.length).toBeGreaterThan(40);
  });

  it("every COPY string passes assertNoAdvice (findAdvice)", () => {
    for (const text of copyStrings) {
      expect(findAdvice(text), `advice language in copy: ${text}`).toBeNull();
    }
  });

  it("every COPY string is clean under the smoke harness regex", () => {
    for (const text of copyStrings) {
      expect(SMOKE_NO_ADVICE.test(text), `smoke regex matched: ${text}`).toBe(false);
    }
  });

  it("every component and page source file is advice-free", () => {
    const files = [...walk(join(ROOT, "components"), []), ...walk(join(ROOT, "app"), [])];
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const match = findAdvice(source);
      expect(match, `advice language in ${file}: ${String(match)}`).toBeNull();
    }
  });
});
