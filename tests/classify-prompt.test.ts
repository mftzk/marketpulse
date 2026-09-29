import { describe, expect, it, vi } from "vitest";

import { buildPrompt, classifyArticles, toPromptText, truncateOnBoundary, type ClassifyInput } from "@/lib/analysis/classify";
import { loadConfig } from "@/lib/config";

/**
 * Bug B regression suite (live `NEWS_PROVIDER=benzinga` incident): real vendor
 * articles carry multi-thousand-character bodies, so the classification prompt
 * blew the LLM timeout. The prompt builder must bound the body, strip HTML, and
 * keep the headline, and a timeout must fall back to the rules classifier.
 */

function input(overrides: Partial<ClassifyInput> & { id: string }): ClassifyInput {
  return {
    headline: "NVIDIA reports quarterly results",
    body: null,
    tickersRaw: ["NVDA"],
    sourceQuality: 0.9,
    ...overrides,
  };
}

describe("classification prompt builder", () => {
  it("truncates a long body to the configured character budget", () => {
    const longBody = "word ".repeat(1_000);
    const prompt = buildPrompt([input({ id: "a1", body: longBody })], 1_200);

    const match = prompt.match(/body="([^"]*)"/);
    expect(match).not.toBeNull();
    expect((match?.[1] ?? "").length).toBeLessThanOrEqual(1_200);
    expect(prompt).toContain("NVIDIA reports quarterly results");
  });

  it("never includes raw HTML markup in the prompt", () => {
    const html = `<p>NVIDIA <b>beat</b> estimates.</p><script>alert("x")</script><div>More text here.</div>`;
    const prompt = buildPrompt([input({ id: "a1", body: html })], 1_200);

    expect(prompt).not.toContain("<p>");
    expect(prompt).not.toContain("<b>");
    expect(prompt).not.toContain("<script");
    expect(prompt).not.toContain("alert(");
    expect(prompt).toContain("NVIDIA");
    expect(prompt).toContain("beat");
  });

  it("keeps the headline even when the body is empty", () => {
    const prompt = buildPrompt([input({ id: "a1", headline: "Special headline here", body: null })], 1_200);
    expect(prompt).toContain("Special headline here");
  });

  it("truncates on a sentence or word boundary", () => {
    expect(truncateOnBoundary("First sentence. Second sentence follows", 20)).toBe("First sentence.");
    expect(truncateOnBoundary("alpha beta gamma delta", 10)).toBe("alpha beta");
    expect(truncateOnBoundary("short", 10)).toBe("short");
  });

  it("strips HTML to plain text", () => {
    expect(toPromptText("<p>Hello <b>world</b>&nbsp;today</p>")).toBe("Hello world today");
  });

  it("defaults LLM_MAX_ARTICLE_CHARS to 1200 (env-overridable)", () => {
    expect(loadConfig({}).llmMaxArticleChars).toBe(1_200);
    expect(loadConfig({ LLM_MAX_ARTICLE_CHARS: "500" }).llmMaxArticleChars).toBe(500);
  });

  it("defaults LLM_TIMEOUT_MS to 45000 (env-overridable)", () => {
    expect(loadConfig({}).llmTimeoutMs).toBe(45_000);
    expect(loadConfig({ LLM_TIMEOUT_MS: "10000" }).llmTimeoutMs).toBe(10_000);
  });
});

describe("classification timeout fallback", () => {
  it("falls back to rules on an LLM timeout and keeps classifying the batch", async () => {
    const complete = vi.fn(async () => ({ ok: false as const, reason: "timeout" }));
    const llm = { isConfigured: () => true, complete };

    const items = Array.from({ length: 12 }, (_, i) =>
      input({ id: `a${i}`, headline: `Company ${i} reports quarterly results` }),
    );
    const { results, stats } = await classifyArticles(items, {
      llm,
      maxLlmCalls: 2,
      failureStreakLimit: 3,
    });

    expect(complete).toHaveBeenCalled();
    expect(results).toHaveLength(12);
    expect(results.every((r) => r.source === "rules")).toBe(true);
    expect(stats.classified).toBe(12);
    expect(stats.deferred).toBe(0);
    expect(stats.circuitOpen).toBe(false);
  });
});
