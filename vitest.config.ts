import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Vitest runs the pure-logic suites in `tests/`. The `@/*` path alias mirrors
 * tsconfig.json so test files import application modules the same way the app does.
 * No network or database is touched by these tests.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // A valid signing key for the auth suites. This is a test-only value and is
    // never used outside the vitest process.
    env: { AUTH_ENABLED: "1", SESSION_SECRET: "vitest-session-secret-0123456789abcdef" },
  },
});
