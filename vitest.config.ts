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
  },
});
