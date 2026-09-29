import type { Classification } from "@/lib/analysis/classification-schema";
import { classificationEnvelopeSchema } from "@/lib/analysis/classification-schema";
import type { LLMClient } from "@/lib/analysis/llm-client";
import { logger } from "@/lib/logger";

/**
 * News classification (§7 step 4). Batches headlines (≤10 per call) through an
 * OpenAI-compatible LLM and validates the parsed envelope against the strict
 * zod schema. On any failure the batch falls back to `classifyByRules()`.
 *
 * IMPORTANT: `sentiment` and `catalyst_direction` describe *direction* only.
 * They must NOT determine `event_importance` by themselves. In the rules
 * fallback, `event_importance` is derived from the event type's base importance
 * and explicit magnitude cues in the text — never from the sentiment sign.
 */

export interface ClassifyInput {
  id: string;
  headline: string;
  body: string | null;
  tickersRaw: string[];
  sourceQuality: number;
}

export type ClassifySource = "llm" | "rules";

export interface ClassifiedArticle {
  articleId: string;
  classification: Classification;
  source: ClassifySource;
}

export interface ClassifyOptions {
  llm: LLMClient;
  /**
   * Maximum number of LLM round-trips (batches of ≤10) this tick may perform.
   * Once exhausted the remaining backlog is left for the next tick.
   */
  maxLlmCalls?: number;
  /** Consecutive LLM failures that open the circuit for the rest of the tick. */
  failureStreakLimit?: number;
  /** Absolute epoch-ms after which no new LLM call is started. */
  deadlineAt?: number;
  /**
   * Maximum characters of each article body included in the prompt. Real vendor
   * articles can be thousands of characters long; sending them whole blows the
   * request timeout. Headlines are always included in full.
   */
  maxArticleChars?: number;
}

export interface ClassifyStats {
  /** LLM round-trips actually made. */
  llmCalls: number;
  /** Articles classified this tick (LLM + rules). */
  classified: number;
  /** Articles left for a later tick. */
  deferred: number;
  /** Deferred articles specifically left because the LLM budget was exhausted. */
  skippedNoBudget: number;
  /** Whether the failure-streak circuit opened during this tick. */
  circuitOpen: boolean;
}

export interface ClassifyRunResult {
  results: ClassifiedArticle[];
  stats: ClassifyStats;
}

const BATCH_SIZE = 10;

/** Default body budget per article in the classification prompt. */
export const DEFAULT_MAX_ARTICLE_CHARS = 1_200;

/** Cheap char→token estimate (≈4 chars/token) for observability only. */
export function estimatePromptTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Reduces arbitrary article text to prompt-safe plain text. The provider
 * adapters already convert HTML to text, but this is a defensive second pass:
 * a raw HTML body must never reach the model (markup inflates the prompt and
 * the model cannot reason about it).
 */
export function toPromptText(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(nbsp|#160);/gi, " ")
    .replace(/&(amp);/gi, "&")
    .replace(/&(lt|#60);/gi, "<")
    .replace(/&(gt|#62);/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Truncates `text` to at most `maxChars`, preferring a sentence boundary and
 * falling back to the last word boundary so a word is never cut in half.
 */
export function truncateOnBoundary(text: string, maxChars: number): string {
  if (!Number.isFinite(maxChars) || maxChars <= 0) {
    return "";
  }
  if (text.length <= maxChars) {
    return text;
  }
  let slice = text.slice(0, maxChars);
  // Cut exactly at a word boundary (next char is a space) — keep the slice.
  if (text.charAt(maxChars) === " ") {
    return slice.trim();
  }
  const sentenceEnd = Math.max(
    slice.lastIndexOf(". "),
    slice.lastIndexOf("! "),
    slice.lastIndexOf("? "),
  );
  if (sentenceEnd > maxChars * 0.5) {
    return slice.slice(0, sentenceEnd + 1).trim();
  }
  const wordEnd = slice.lastIndexOf(" ");
  if (wordEnd > 0) {
    slice = slice.slice(0, wordEnd);
  }
  return slice.trim();
}

/**
 * Builds the classification prompt. The headline is always present in full; the
 * body is reduced to prompt-safe plain text and capped at `maxArticleChars`
 * (default `DEFAULT_MAX_ARTICLE_CHARS`) so a long vendor article cannot blow
 * the LLM request timeout.
 */
export function buildPrompt(
  items: ClassifyInput[],
  maxArticleChars: number = DEFAULT_MAX_ARTICLE_CHARS,
): string {
  const lines = items
    .map((item, index) => {
      const bodyText = item.body ? truncateOnBoundary(toPromptText(item.body), maxArticleChars) : "";
      const body = bodyText ? ` body="${bodyText}"` : "";
      return `${index}. headline="${item.headline}"${body} tickers=${JSON.stringify(item.tickersRaw)}`;
    })
    .join("\n");

  return [
    "Classify the following news items into structured market events.",
    "Return ONLY a JSON object with this exact shape:",
    '{"classifications":[{"ticker":"AAPL","company":"Apple","event_type":"PRODUCT","summary":"...","sentiment":0.5,"catalyst_direction":"positive","company_relevance":1.0,"event_importance":0.6,"source_quality":0.9,"affected_tickers":["AAPL"],"affected_sectors":["technology"],"reasoning":"..."}]}',
    "Rules:",
    "- ticker is the primary ticker symbol (uppercase) or null.",
    "- event_type is one of: EARNINGS, GUIDANCE, PRODUCT, CONTRACT, PARTNERSHIP, M&A, ANALYST_UPGRADE, ANALYST_DOWNGRADE, REGULATION, LAWSUIT, MANAGEMENT, BUYBACK, DIVIDEND, OFFERING, INSIDER_TRANSACTION, MACRO, OTHER.",
    "- sentiment is -1..1 (direction, NOT importance).",
    "- catalyst_direction is positive|negative|neutral|mixed.",
    "- event_importance (0..1) reflects the magnitude of the event versus expectations — never the sentiment sign alone.",
    "- company_relevance is 0..1.",
    "- source_quality is 0..1.",
    "- summary is 10-600 chars; reasoning is 10-1200 chars.",
    "- affected_tickers max 12; affected_sectors max 6.",
    "Items:",
    lines,
  ].join("\n");
}

function parseEnvelope(content: string): Classification[] | null {
  try {
    const parsed: unknown = JSON.parse(content);
    const result = classificationEnvelopeSchema.safeParse(parsed);
    if (!result.success) {
      return null;
    }
    return result.data.classifications;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Rules fallback
// ---------------------------------------------------------------------------

const POSITIVE_WORDS =
  /\b(beat|beats|tops|exceeds|raise(?:s|d)?|upgrade(?:s|d)?|outperform(?:s|ed)?|surge(?:s|d)?|soar(?:s|ed)?|jump(?:s|ed)?|record|strong|growth|win(?:s)?|approve(?:s|d)?|authorize(?:s|d)?|unveil(?:s|ed)?|launch(?:es|ed)?|partnership|agreement|buyback|repurchase|increase(?:s|d)?)\b/i;

const NEGATIVE_WORDS =
  /\b(miss(?:es|ed)?|below|misses|cut(?:s)?|downgrade(?:s|d)?|underperform(?:s|ed)?|plunge(?:s|d)?|drop(?:s|ped)?|fall(?:s|en)?|probe|investigation|lawsuit|probe(?:s|d)?|offering|sale of shares|sell(?:s)?|weak|loss|soft|decline(?:s|d)?)\b/i;

interface EventTypeRule {
  type: Classification["event_type"];
  pattern: RegExp;
}

// Ordered: more specific rules first.
const EVENT_TYPE_RULES: EventTypeRule[] = [
  { type: "ANALYST_UPGRADE", pattern: /\b(analyst|desk|firm|upgraded|upgrade|raises rating|price target raised)\b.*\b(upgrade|raises|raised)\b/i },
  { type: "ANALYST_DOWNGRADE", pattern: /\b(analyst|desk|firm|downgraded|downgrade|cuts rating|lowers rating)\b.*\b(downgrade|downgrades|cuts|cut)\b/i },
  { type: "GUIDANCE", pattern: /\b(guidance|outlook|forecast|full-year|fiscal year|raises full-year|cuts full-year|lowers.*outlook|raises.*outlook)\b/i },
  { type: "EARNINGS", pattern: /\b(earnings|quarterly results|reports quarterly|quarterly earnings|q[1-4] results|eps|revenue.*beat|revenue.*miss|results above|results below|fell short)\b/i },
  { type: "M&A", pattern: /\b(acquire(?:s|d)?|acquisition|merger|merge(?:s|d)?|takeover|buyout|to acquire)\b/i },
  { type: "BUYBACK", pattern: /\b(buyback|share repurchase|repurchase program|stock buyback)\b/i },
  { type: "OFFERING", pattern: /\b(secondary offering|share offering|public offering|stock offering)\b/i },
  { type: "INSIDER_TRANSACTION", pattern: /\b(insider|executive.*(sold|bought)|discloses.*(sale|purchase)|form 4)\b/i },
  { type: "DIVIDEND", pattern: /\b(dividend|payout)\b/i },
  { type: "PARTNERSHIP", pattern: /\b(partnership|strategic alliance|collaboration|teams up)\b/i },
  { type: "CONTRACT", pattern: /\b(contract|supply agreement|deal worth|wins contract|awarded)\b/i },
  { type: "REGULATION", pattern: /\b(regulator|regulatory|probe|investigation|antitrust|fcc|sec inquiry|ftc)\b/i },
  { type: "LAWSUIT", pattern: /\b(lawsuit|sues|sued|litigation|class action)\b/i },
  { type: "MANAGEMENT", pattern: /\b(ceo|cfo|executive|leadership|appoints|resign(?:s|ed)?|steps down)\b/i },
  { type: "PRODUCT", pattern: /\b(product|launch(?:es|ed)?|unveil(?:s|ed)?|new model|new chip|releases)\b/i },
  { type: "MACRO", pattern: /\b(fed|federal reserve|interest rate|cpi|inflation|gdp|jobs report|unemployment|macro|economic data|yields|treasury)\b/i },
];

const IMPORTANCE_HINTS: Array<{ pattern: RegExp; boost: number }> = [
  { pattern: /\b(record|blowout|surprise|surge|plunge|shock|unexpectedly)\b/i, boost: 0.2 },
  { pattern: /\b(beat|miss)\b/i, boost: 0.1 },
];

function detectEventType(text: string): Classification["event_type"] {
  for (const rule of EVENT_TYPE_RULES) {
    if (rule.pattern.test(text)) {
      return rule.type;
    }
  }
  return "OTHER";
}

function detectSentiment(text: string): number {
  const pos = POSITIVE_WORDS.test(text) ? 1 : 0;
  const neg = NEGATIVE_WORDS.test(text) ? 1 : 0;
  if (pos && neg) {
    return 0.05;
  }
  if (pos) {
    return 0.55;
  }
  if (neg) {
    return -0.55;
  }
  return 0;
}

function directionForSentiment(sentiment: number): Classification["catalyst_direction"] {
  if (sentiment > 0.2) {
    return "positive";
  }
  if (sentiment < -0.2) {
    return "negative";
  }
  return "neutral";
}

/**
 * Keyword/pattern classification fallback. `event_importance` is derived from
 * the event type's base importance plus magnitude cues in the text — explicitly
 * NOT from `sentiment`/`catalyst_direction` (direction must not drive
 * importance).
 */
export function classifyByRules(
  input: Omit<ClassifyInput, "id">,
): Classification {
  const text = `${input.headline} ${input.body ?? ""}`;
  const eventType = detectEventType(text);
  const sentiment = detectSentiment(text);
  const direction = directionForSentiment(sentiment);

  let importance = 0.4;
  for (const hint of IMPORTANCE_HINTS) {
    if (hint.pattern.test(text)) {
      importance += hint.boost;
    }
  }
  if (eventType === "EARNINGS" || eventType === "GUIDANCE") {
    importance = Math.max(importance, 0.8);
  } else if (eventType === "M&A") {
    importance = Math.max(importance, 0.75);
  }
  importance = Math.max(0.1, Math.min(1, importance));

  const ticker = input.tickersRaw[0]?.toUpperCase() ?? null;
  const tickerValid = ticker !== null && /^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker);

  const summary =
    input.body && input.body.trim().length >= 10
      ? input.body.trim().slice(0, 600)
      : input.headline.trim().slice(0, 600);

  return {
    ticker: tickerValid ? ticker : null,
    company: null,
    event_type: eventType,
    summary,
    sentiment,
    catalyst_direction: direction,
    company_relevance: tickerValid ? 1 : 0.5,
    event_importance: importance,
    source_quality: Math.max(0, Math.min(1, input.sourceQuality)),
    affected_tickers: input.tickersRaw
      .map((t) => t.toUpperCase())
      .filter((t) => /^[A-Z][A-Z0-9.\-]{0,9}$/.test(t))
      .slice(0, 12),
    affected_sectors: [],
    reasoning: `Detected ${eventType} event from headline text; direction reflects ${direction} language while importance is derived from the event type and magnitude cues, not sentiment alone.`,
  };
}

/**
 * Classifies a batch of articles with three bounds that keep a small container
 * from wedging the whole tick on the LLM:
 *
 *  1. **Per-tick call cap** (`maxLlmCalls`) — at most N LLM round-trips; the
 *     remaining backlog is deferred to the next tick.
 *  2. **Circuit breaker** (`failureStreakLimit`) — after N consecutive LLM
 *     failures the LLM is skipped for the rest of the tick and every remaining
 *     article is classified by the deterministic rules classifier.
 *  3. **Deadline** (`deadlineAt`) — no new LLM call starts after it.
 *
 * LLM output is validated strictly per batch; an invalid envelope counts as a
 * failure and falls back to rules for that batch. Per-article `source` is
 * `"llm"` or `"rules"`.
 */
export async function classifyArticles(
  items: ClassifyInput[],
  opts: ClassifyOptions,
): Promise<ClassifyRunResult> {
  const results: ClassifiedArticle[] = [];
  const useLLM = opts.llm.isConfigured();
  const maxLlmCalls = opts.maxLlmCalls ?? Number.POSITIVE_INFINITY;
  const failureStreakLimit = Math.max(1, opts.failureStreakLimit ?? 3);
  const deadlineAt = opts.deadlineAt ?? Number.POSITIVE_INFINITY;

  let llmCalls = 0;
  let consecutiveFailures = 0;
  let circuitOpen = false;
  let classified = 0;
  let stoppedForBudget = false;

  for (let start = 0; start < items.length; start += BATCH_SIZE) {
    const chunk = items.slice(start, start + BATCH_SIZE);

    // Cooperative deadline: defer everything after this point to the next tick.
    if (Date.now() >= deadlineAt) {
      break;
    }

    const budgetAvailable = llmCalls < maxLlmCalls;
    const canUseLlm = useLLM && !circuitOpen && budgetAvailable;

    if (canUseLlm) {
      llmCalls += 1;
      let handled = false;
      const prompt = buildPrompt(chunk, opts.maxArticleChars);
      const promptChars = prompt.length;
      const callStarted = Date.now();
      const llmResult = await opts.llm.complete(prompt);
      const latencyMs = Date.now() - callStarted;
      let outcome = "rules";
      let failReason: string | null = null;
      if (llmResult.ok) {
        const classifications = parseEnvelope(llmResult.content);
        if (classifications !== null && classifications.length === chunk.length) {
          chunk.forEach((item, index) => {
            results.push({
              articleId: item.id,
              classification: classifications[index],
              source: "llm",
            });
          });
          classified += chunk.length;
          consecutiveFailures = 0;
          handled = true;
          outcome = "llm";
        } else {
          failReason = "invalid_output";
          logger.warn("llm_classification_invalid", {
            event: "analysis.classify",
            batchSize: chunk.length,
          });
        }
      } else {
        failReason = llmResult.reason;
      }

      // Per-call observability: a future timeout must be diagnosable from the
      // log line alone (prompt size + latency + why the fallback ran).
      logger.info("llm_classification_call", {
        event: "analysis.classify",
        batch_size: chunk.length,
        prompt_chars: promptChars,
        est_tokens: estimatePromptTokens(prompt),
        latency_ms: latencyMs,
        outcome,
        ...(failReason ? { reason: failReason } : {}),
      });

      if (!handled) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= failureStreakLimit && !circuitOpen) {
          circuitOpen = true;
          logger.warn("llm_circuit_open", {
            event: "analysis.classify",
            consecutive_failures: consecutiveFailures,
          });
        }
        chunk.forEach((item) => {
          results.push({
            articleId: item.id,
            classification: classifyByRules(item),
            source: "rules",
          });
        });
        classified += chunk.length;
      }
      continue;
    }

    // Budget exhausted (LLM healthy, circuit closed): defer the backlog.
    if (useLLM && !circuitOpen && !budgetAvailable) {
      stoppedForBudget = true;
      break;
    }

    // Circuit open, or no LLM configured: deterministic rules, no network.
    chunk.forEach((item) => {
      results.push({
        articleId: item.id,
        classification: classifyByRules(item),
        source: "rules",
      });
    });
    classified += chunk.length;
  }

  const deferred = items.length - classified;
  return {
    results,
    stats: {
      llmCalls,
      classified,
      deferred,
      skippedNoBudget: stoppedForBudget ? deferred : 0,
      circuitOpen,
    },
  };
}
