import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  runPipelineTick: vi.fn(),
  startPipelineTickInBackground: vi.fn(),
  exceedsRateLimit: vi.fn(),
}));

vi.mock("@/lib/pipeline/run", () => ({
  runPipelineTick: h.runPipelineTick,
  startPipelineTickInBackground: h.startPipelineTickInBackground,
}));

vi.mock("@/lib/ratelimit", () => ({
  exceedsRateLimit: h.exceedsRateLimit,
}));

vi.mock("@/lib/pipeline/registry", () => ({
  STEP_NAMES: ["fetch_news"],
}));

const { POST } = await import("@/app/api/pipeline/run/route");

const REPORT = {
  runId: "run-123",
  status: "succeeded" as const,
  durationMs: 42,
  steps: [{ name: "fetch_news", status: "succeeded" as const, durationMs: 10, processed: 3 }],
  eventsCreated: 1,
  eventsUpdated: 0,
  articlesIngested: 2,
  alertsTriggered: 0,
};

function request(body: unknown, query = ""): Request {
  return new Request(`http://localhost/api/pipeline/run${query}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  h.runPipelineTick.mockReset();
  h.startPipelineTickInBackground.mockReset();
  h.exceedsRateLimit.mockReset();
  h.exceedsRateLimit.mockResolvedValue(false);
  h.startPipelineTickInBackground.mockReturnValue({ started: true });
});

describe("POST /api/pipeline/run", () => {
  it("returns 202 immediately by default and runs the tick in the background", async () => {
    const response = await POST(request({ trigger: "api" }));
    const body = (await response.json()) as { data: { status: string; run_id: string | null } };

    expect(response.status).toBe(202);
    expect(body.data.status).toBe("started");
    expect(body.data.run_id).toBeNull();
    expect(h.startPipelineTickInBackground).toHaveBeenCalledTimes(1);
    expect(h.runPipelineTick).not.toHaveBeenCalled();
  });

  it("honours { wait: true } and returns the completed run report", async () => {
    h.runPipelineTick.mockResolvedValue(REPORT);

    const response = await POST(request({ trigger: "api", wait: true }));
    const body = (await response.json()) as { data: { run_id: string; status: string } };

    expect(response.status).toBe(200);
    expect(body.data.run_id).toBe("run-123");
    expect(body.data.status).toBe("succeeded");
    expect(h.runPipelineTick).toHaveBeenCalledTimes(1);
    expect(h.startPipelineTickInBackground).not.toHaveBeenCalled();
  });

  it("honours the ?wait=1 query opt-in", async () => {
    h.runPipelineTick.mockResolvedValue(REPORT);

    const response = await POST(request({ trigger: "api" }, "?wait=1"));

    expect(response.status).toBe(200);
    expect(h.runPipelineTick).toHaveBeenCalledTimes(1);
  });

  it("reports 'skipped' (still 202) when a tick is already in flight", async () => {
    h.startPipelineTickInBackground.mockReturnValue({ started: false });

    const response = await POST(request({ trigger: "api" }));
    const body = (await response.json()) as { data: { status: string } };

    expect(response.status).toBe(202);
    expect(body.data.status).toBe("skipped");
  });

  it("rate-limits with 429 when the bucket is exhausted", async () => {
    h.exceedsRateLimit.mockResolvedValue(true);

    const response = await POST(request({ trigger: "api" }));
    const body = (await response.json()) as { code: string };

    expect(response.status).toBe(429);
    expect(body.code).toBe("rate_limit");
    expect(h.startPipelineTickInBackground).not.toHaveBeenCalled();
  });

  it("rejects a malformed body with 400 validation_error", async () => {
    const response = await POST(request({ trigger: "nope" }));

    expect(response.status).toBe(400);
    expect(h.startPipelineTickInBackground).not.toHaveBeenCalled();
  });
});
