import { describe, expect, it, vi } from "vitest";

/**
 * The LLM request must carry a hard timeout. A hanging upstream (or a stalled
 * body read) has to abort and report `timeout` so `classify_event` can count the
 * failure toward its circuit breaker instead of holding the tick open.
 */

vi.hoisted(() => {
  process.env.LLM_API_KEY = "test-key";
  process.env.LLM_BASE_URL = "http://127.0.0.1:9";
  process.env.LLM_TIMEOUT_MS = "30";
});

const { createLlmClient, getLlmHealth } = await import("@/lib/analysis/llm-client");
const { classifyArticles } = await import("@/lib/analysis/classify");

const hangingFetch = ((_url: string, init?: RequestInit) =>
  new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (signal) {
      signal.addEventListener("abort", () =>
        reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
      );
    }
  })) as unknown as typeof fetch;

describe("llm client timeout", () => {
  it("aborts a hanging request and reports timeout", async () => {
    const client = createLlmClient({ timeoutMs: 25, fetchImpl: hangingFetch, retryBackoffMs: 0 });

    const result = await client.complete("classify this");

    expect(result).toEqual({ ok: false, reason: "timeout" });
  });

  it("falls back to rules on a timeout and records the failure reason", async () => {
    const client = createLlmClient({ timeoutMs: 25, fetchImpl: hangingFetch, retryBackoffMs: 0 });

    const { results } = await classifyArticles(
      [
        { id: "a1", headline: "NVIDIA reports quarterly results", body: null, tickersRaw: ["NVDA"], sourceQuality: 0.9 },
        { id: "a2", headline: "Apple launches a new product", body: null, tickersRaw: ["AAPL"], sourceQuality: 0.9 },
      ],
      { llm: client, maxLlmCalls: 1, failureStreakLimit: 1 },
    );

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.source === "rules")).toBe(true);
    expect(getLlmHealth().lastFailureReason).toBe("timeout");
  });

  it("reports a clean result when the upstream answers", async () => {
    const okFetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '{"classifications":[]}' } }] }),
    })) as unknown as typeof fetch;
    const client = createLlmClient({ timeoutMs: 1000, fetchImpl: okFetch, retryBackoffMs: 0 });

    const result = await client.complete("classify this");

    expect(result).toEqual({ ok: true, content: '{"classifications":[]}' });
  });
});
