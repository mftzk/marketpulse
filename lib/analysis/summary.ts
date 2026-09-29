import { neutralizeAdviceLanguage } from "@/lib/analysis/advice-lexicon";

/**
 * Summary shaping (§0, Phase 15).
 *
 * `market_events.summary` is an app-owned surface: the product must never store
 * a verbatim vendor sentence that carries analyst-rating/advisory language, and
 * the summary must be about the event's own ticker (vendor feeds tag a single
 * article with several tickers, so a cluster's canonical sentence can easily be
 * about a different company). Everything here is pure and testable.
 */

const MIN_SUMMARY = 10;
const MAX_SUMMARY = 600;
const GENERIC_SUMMARY = "Market event; see the linked source for detail.";

/**
 * True when `text` names `ticker` as a standalone token (case-insensitive).
 * The token-boundary check stops a one-letter symbol such as `T` from matching
 * inside an ordinary word like "the".
 */
export function textMentionsTicker(text: string, ticker: string | null | undefined): boolean {
  const symbol = typeof ticker === "string" ? ticker.trim().toUpperCase() : "";
  if (symbol.length === 0) {
    return false;
  }
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Z0-9])${escaped}([^A-Z0-9]|$)`).test(text.toUpperCase());
}

/**
 * Neutral, factual fallback that names the ticker. Deliberately contains no
 * vendor sentence — only the app's own pointer to the headline.
 */
export function buildFallbackSummary(ticker: string | null, eventTypeLabel: string): string {
  const symbol = typeof ticker === "string" ? ticker.trim().toUpperCase() : "";
  const label = (eventTypeLabel ?? "").trim() || "Market event";
  const base = symbol.length > 0 ? `${symbol}: ${label} — see headline` : `${label} — see headline`;
  const neutral = neutralizeAdviceLanguage(base).trim();
  return (neutral.length >= MIN_SUMMARY ? neutral : GENERIC_SUMMARY).slice(0, MAX_SUMMARY);
}

/**
 * Produces the summary the app may persist and serve:
 *   - neutralise advisory language,
 *   - keep it only when it actually mentions the event ticker, one of the
 *     event's affected tickers, or the event's company name,
 *   - otherwise fall back to the app's own neutral, ticker-naming summary.
 */
export function buildEventSummary(input: {
  ticker: string | null;
  eventTypeLabel: string;
  summary: string | null | undefined;
  affectedTickers?: string[];
  companyName?: string | null;
}): string {
  const ticker = typeof input.ticker === "string" ? input.ticker.trim().toUpperCase() : null;
  const candidates = [ticker, ...(input.affectedTickers ?? []), input.companyName ?? ""].filter(
    (symbol): symbol is string => typeof symbol === "string" && symbol.trim().length > 0,
  );
  const neutral = neutralizeAdviceLanguage(input.summary ?? "").trim();
  const isRelevant = candidates.some((symbol) => textMentionsTicker(neutral, symbol));
  if (neutral.length >= MIN_SUMMARY && isRelevant) {
    return neutral.slice(0, MAX_SUMMARY);
  }
  return buildFallbackSummary(ticker, input.eventTypeLabel);
}

/**
 * Sanitises a classified summary before it is stored. `fallbacks` are tried in
 * order when neutralisation leaves too little text (e.g. the LLM summary was
 * almost entirely advisory) — the rules-derived summary is the usual fallback.
 */
export function sanitizeSummaryText(text: string | null | undefined, fallbacks: string[] = []): string {
  const neutral = neutralizeAdviceLanguage(text ?? "").trim();
  if (neutral.length >= MIN_SUMMARY) {
    return neutral.slice(0, MAX_SUMMARY);
  }
  for (const fallback of fallbacks) {
    const candidate = neutralizeAdviceLanguage(fallback ?? "").trim();
    if (candidate.length >= MIN_SUMMARY) {
      return candidate.slice(0, MAX_SUMMARY);
    }
  }
  return GENERIC_SUMMARY;
}

/** Sanitises a reasoning string; falls back to the rules reasoning if needed. */
export function sanitizeReasoningText(text: string | null | undefined, fallbacks: string[] = []): string {
  const neutral = neutralizeAdviceLanguage(text ?? "").trim();
  if (neutral.length >= MIN_SUMMARY) {
    return neutral.slice(0, 1200);
  }
  for (const fallback of fallbacks) {
    const candidate = neutralizeAdviceLanguage(fallback ?? "").trim();
    if (candidate.length >= MIN_SUMMARY) {
      return candidate.slice(0, 1200);
    }
  }
  return "Classification derived from the article text.";
}
