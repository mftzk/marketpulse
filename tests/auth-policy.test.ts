import { describe, expect, it } from "vitest";

import { isApiPath, shouldBypassAuth } from "@/lib/auth/policy";

describe("auth policy", () => {
  it("bypasses the documented public paths", () => {
    const publicPaths = [
      "/login",
      "/api/auth/login",
      "/api/health",
      "/_next/static/chunks/main.js",
      "/_next/image",
      "/favicon.ico",
      "/icon.svg",
      "/robots.txt",
      "/opengraph-image",
      "/opengraph-image/abc123",
    ];
    for (const path of publicPaths) {
      expect(shouldBypassAuth(path), path).toBe(true);
    }
  });

  it("gates every other page and API route", () => {
    const gated = [
      "/",
      "/events/abc",
      "/watchlists",
      "/alerts",
      "/macro",
      "/replay",
      "/about",
      "/api/events",
      "/api/events/abc",
      "/api/watchlists",
      "/api/auth/session",
      "/api/auth/logout",
      "/api/pipeline/run",
      "/api/replay",
    ];
    for (const path of gated) {
      expect(shouldBypassAuth(path), path).toBe(false);
    }
  });

  it("normalises a single trailing slash", () => {
    expect(shouldBypassAuth("/login/")).toBe(true);
    expect(shouldBypassAuth("/api/health/")).toBe(true);
    expect(shouldBypassAuth("/api/auth/login/")).toBe(true);
  });

  it("rejects empty input", () => {
    expect(shouldBypassAuth("")).toBe(false);
  });

  it("identifies API paths", () => {
    expect(isApiPath("/api")).toBe(true);
    expect(isApiPath("/api/events")).toBe(true);
    expect(isApiPath("/apiary")).toBe(false);
    expect(isApiPath("/")).toBe(false);
  });
});
