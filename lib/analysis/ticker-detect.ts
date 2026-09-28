import { TICKER_PATTERN } from "@/lib/core/filters";

/**
 * Ticker detection (§7 step 3). Pure function of (text, universe): extracts
 * ticker references from free text via three strategies — cashtags (`$NVDA`),
 * bare all-caps symbols with word boundaries, and company names/aliases — and
 * resolves them against the active universe. Unknown symbols are ignored;
 * ambiguous spans are resolved by preferring the highest-confidence source and
 * collapsing to one detection per ticker.
 */

export interface TickerUniverseEntry {
  /** Uppercase ticker symbol, e.g. "NVDA". */
  ticker: string;
  /** Display name, e.g. "NVIDIA". */
  name: string;
  /** Alternate names/symbols, e.g. "TSMC" for TSM. */
  aliases?: string[];
}

export type TickerDetectionSource = "cashtag" | "symbol" | "name";

export interface TickerDetection {
  ticker: string;
  source: TickerDetectionSource;
  confidence: number;
}

const SOURCE_CONFIDENCE: Record<TickerDetectionSource, number> = {
  cashtag: 1,
  name: 0.9,
  symbol: 0.7,
};

/** Common English words that would otherwise collide with short ticker-like tokens. */
const GENERIC_WORDS = new Set([
  "A",
  "AN",
  "AND",
  "ARE",
  "AT",
  "BE",
  "BY",
  "DO",
  "GO",
  "IF",
  "IN",
  "IS",
  "IT",
  "OF",
  "ON",
  "OR",
  "SO",
  "TO",
  "UP",
  "US",
  "WE",
  "FOR",
  "NOT",
  "NEW",
  "CUT",
  "NOW",
]);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeUniverse(entries: TickerUniverseEntry[]): TickerUniverseEntry[] {
  return entries.map((entry) => ({
    ticker: entry.ticker.toUpperCase(),
    name: entry.name,
    aliases: entry.aliases ?? [],
  }));
}

/**
 * Detects tickers in `text` against `universe`. Returns at most one detection
 * per ticker, ordered by the position of the first match in the source text.
 * Symbol matches require an all-caps token with word boundaries; cashtags and
 * company-name matches are case-insensitive.
 */
export function detectTickers(
  text: string,
  universe: TickerUniverseEntry[],
): TickerDetection[] {
  if (!text || text.length === 0) {
    return [];
  }

  const normalized = normalizeUniverse(universe);
  const byTicker = new Map(normalized.map((entry) => [entry.ticker, entry]));
  const byName = new Map<string, TickerUniverseEntry>();
  for (const entry of normalized) {
    byName.set(entry.name.toLowerCase(), entry);
    for (const alias of entry.aliases ?? []) {
      byName.set(alias.toLowerCase(), entry);
    }
  }

  // best[source] per ticker, plus the earliest match index for ordering.
  const detections = new Map<
    string,
    { ticker: string; source: TickerDetectionSource; confidence: number; index: number }
  >();

  const record = (
    ticker: string,
    source: TickerDetectionSource,
    index: number,
  ): void => {
    const existing = detections.get(ticker);
    const confidence = SOURCE_CONFIDENCE[source];
    if (!existing || confidence > existing.confidence) {
      detections.set(ticker, { ticker, source, confidence, index });
    }
  };

  // 1. Cashtags: $NVDA
  const cashtagRe = /\$([A-Za-z][A-Za-z0-9.\-]{0,9})/g;
  let match: RegExpExecArray | null;
  while ((match = cashtagRe.exec(text)) !== null) {
    const ticker = match[1].toUpperCase();
    if (TICKER_PATTERN.test(ticker) && byTicker.has(ticker)) {
      record(ticker, "cashtag", match.index);
    }
  }

  // 2. Company names / aliases (case-insensitive, word-boundary). Prefer the
  //    longest name first so "Advanced Micro Devices" wins over a shorter alias.
  const nameEntries = [...byName.entries()].sort(
    (a, b) => b[0].length - a[0].length,
  );
  for (const [name, entry] of nameEntries) {
    const re = new RegExp(`\\b${escapeRegExp(name)}\\b`, "i");
    const m = re.exec(text);
    if (m !== null) {
      record(entry.ticker, "name", m.index);
    }
  }

  // 3. Bare symbols: all-caps tokens with word boundaries, present in universe.
  const wordRe = /\b[A-Z][A-Z0-9.\-]{0,9}\b/g;
  while ((match = wordRe.exec(text)) !== null) {
    const token = match[0];
    const upper = token.toUpperCase();
    if (GENERIC_WORDS.has(upper)) {
      continue;
    }
    if (byTicker.has(upper) && byName.has(upper.toLowerCase())) {
      // The token is both a ticker symbol and a company name; the name pass
      // already recorded it at higher confidence, so skip the symbol pass.
      continue;
    }
    if (byTicker.has(upper)) {
      record(upper, "symbol", match.index);
    }
  }

  return [...detections.values()]
    .sort((a, b) => a.index - b.index)
    .map(({ ticker, source, confidence }) => ({ ticker, source, confidence }));
}

/**
 * Convenience: returns just the ticker symbols, ordered by first match.
 */
export function detectTickerSymbols(
  text: string,
  universe: TickerUniverseEntry[],
): string[] {
  return detectTickers(text, universe).map((d) => d.ticker);
}
