import { afterEach, describe, expect, it } from "vitest";

import { POST } from "@/app/api/auth/login/route";
import { resetStoreForTests } from "@/lib/cache/store";

function request(body: unknown, ip = "203.0.113.7"): Request {
  return new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  resetStoreForTests();
});

describe("POST /api/auth/login", () => {
  it("rejects a malformed body with 400 validation_error", async () => {
    const response = await POST(request({ email: "not-an-email" }));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { code?: string };
    expect(body.code).toBe("validation_error");
  });

  it("rejects an unknown query shape with 400", async () => {
    const response = await POST(request({ email: "a@b.com" }));
    expect(response.status).toBe(400);
  });

  it("rate-limits the 11th attempt per IP+email with 429 rate_limit", async () => {
    const credentials = { email: "ratelimited@example.com", password: "whatever" };
    for (let i = 0; i < 10; i += 1) {
      // No database is configured in the test env, so these settle on a 500
      // after consuming a rate-limit token — the point is the counter.
      await POST(request(credentials));
    }
    const response = await POST(request(credentials));
    expect(response.status).toBe(429);
    const body = (await response.json()) as { code?: string; error?: string };
    expect(body.code).toBe("rate_limit");
    expect(body.error).toBe("Too many attempts");
  });

  it("keeps separate buckets for different emails", async () => {
    const first = { email: "one@example.com", password: "x" };
    await POST(request(first));
    const response = await POST(request({ email: "two@example.com", password: "x" }));
    expect(response.status).not.toBe(429);
  });
});
