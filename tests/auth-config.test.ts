import { describe, expect, it } from "vitest";

import { loadConfig } from "@/lib/config";

describe("auth config", () => {
  it("defaults to enabled", () => {
    expect(loadConfig({}).authEnabled).toBe(true);
  });

  it("flags a missing secret while auth is enabled", () => {
    const cfg = loadConfig({ AUTH_ENABLED: "1" });
    expect(cfg.authEnabled).toBe(true);
    expect(cfg.sessionSecret).toBeNull();
    expect(cfg.authConfigError).toMatch(/SESSION_SECRET/);
  });

  it("flags a secret shorter than 32 characters", () => {
    const cfg = loadConfig({ AUTH_ENABLED: "1", SESSION_SECRET: "too-short" });
    expect(cfg.authConfigError).toMatch(/32/);
  });

  it("accepts a secret of at least 32 characters", () => {
    const cfg = loadConfig({ AUTH_ENABLED: "1", SESSION_SECRET: "x".repeat(32) });
    expect(cfg.authConfigError).toBeNull();
    expect(cfg.sessionSecret).toHaveLength(32);
  });

  it("does not require a secret when auth is disabled", () => {
    const cfg = loadConfig({ AUTH_ENABLED: "0" });
    expect(cfg.authEnabled).toBe(false);
    expect(cfg.authConfigError).toBeNull();
  });
});
