import { config } from "@/lib/config";
import { logger } from "@/lib/logger";

/**
 * Minimal OpenAI-compatible chat-completions client. Uses `response_format:
 * {type:"json_object"}`, `temperature: 0`, a 30s `AbortController` timeout, and
 * one retry with backoff. It never throws to its caller — it returns a
 * discriminated result — and exposes `lastSuccessAt` / `lastFailureReason` for
 * the `/api/health` endpoint.
 */

export type LLMResult =
  | { ok: true; content: string }
  | { ok: false; reason: string };

interface LlmState {
  lastSuccessAt: Date | null;
  lastFailureReason: string | null;
}

/**
 * Kept on `globalThis` because the pipeline runs from the `instrumentation.ts` bundle while
 * `GET /api/health` runs from the route-handler bundle — module state is not shared between
 * the two in a Next.js production build.
 */
const llmGlobals = globalThis as unknown as { marketPulseLlmState?: LlmState };

const state: LlmState = (llmGlobals.marketPulseLlmState ??= {
  lastSuccessAt: null,
  lastFailureReason: null,
});

export interface LlmHealth {
  configured: boolean;
  model: string;
  lastSuccessAt: Date | null;
  lastFailureReason: string | null;
}

export function getLlmHealth(): LlmHealth {
  return {
    configured: config.llmConfigured,
    model: config.llmModel,
    lastSuccessAt: state.lastSuccessAt,
    lastFailureReason: state.lastFailureReason,
  };
}

export interface LLMClient {
  isConfigured(): boolean;
  complete(prompt: string): Promise<LLMResult>;
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const TIMEOUT_MS = 30_000;
const RETRY_BACKOFF_MS = 500;

interface ChatResponse {
  choices?: { message?: { content?: string } }[];
}

function extractContent(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") {
    return null;
  }
  const response = payload as ChatResponse;
  const content = response.choices?.[0]?.message?.content;
  return typeof content === "string" && content.length > 0 ? content : null;
}

async function post(prompt: string): Promise<{ ok: true; content: string } | { ok: false; reason: string }> {
  const baseUrl = config.llmBaseUrl ?? DEFAULT_BASE_URL;
  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.llmApiKey}`,
      },
      body: JSON.stringify({
        model: config.llmModel,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: prompt }],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return { ok: false, reason: `llm http ${response.status}` };
    }

    const content = extractContent(await response.json());
    if (content === null) {
      return { ok: false, reason: "empty llm content" };
    }
    return { ok: true, content };
  } catch (err) {
    const reason = err instanceof Error && err.name === "AbortError" ? "timeout" : "network_error";
    return { ok: false, reason };
  } finally {
    clearTimeout(timer);
  }
}

export function createLlmClient(): LLMClient {
  return {
    isConfigured(): boolean {
      return config.llmConfigured;
    },
    async complete(prompt: string): Promise<LLMResult> {
      if (!config.llmConfigured) {
        return { ok: false, reason: "not_configured" };
      }

      const first = await post(prompt);
      if (first.ok) {
        state.lastSuccessAt = new Date();
        return first;
      }

      await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS));
      const second = await post(prompt);
      if (second.ok) {
        state.lastSuccessAt = new Date();
        return second;
      }

      state.lastFailureReason = second.reason;
      logger.warn("llm_complete_failed", {
        event: "llm.client",
        reason: second.reason,
      });
      return { ok: false, reason: second.reason };
    },
  };
}

export const llmClient: LLMClient = createLlmClient();
