/**
 * Advisory-language lexicon — the single source of truth shared by the
 * write-time pipeline (`lib/analysis/advice-lexicon.ts` + the dedupe/classify
 * steps) and the live acceptance harness (`scripts/smoke.mjs`).
 *
 * It is dependency-free ESM (no imports at all) so `scripts/smoke.mjs` can
 * import it directly with plain `node`, exactly like `lib/auth/password.mjs`.
 * Because both consumers import this one module, `findAdviceLanguage` in the
 * harness and the neutraliser used before persisting can never drift apart.
 *
 * Product principle (§0): the app presents observable evidence, never
 * investment advice. Real vendor copy contains analyst-rating language ("Buy
 * rating", "price target", "take profit") which must be stripped before it can
 * ever reach an app-owned surface such as `market_events.summary`.
 */

/**
 * The exact guard the acceptance harness applies to every string returned by
 * the API. This is intentionally kept byte-for-byte as strict as it has always
 * been — do NOT widen or weaken it to make a check pass.
 */
export const ADVICE_LANGUAGE_PATTERN =
  /\b(buy|sell|recommend(ation)?s?|target price|take profit|enter at)\b/i;

/** Returns the offending substring if advisory language is found, else null. */
export function findAdviceLanguage(text) {
  if (typeof text !== "string") {
    return null;
  }
  const match = ADVICE_LANGUAGE_PATTERN.exec(text);
  return match === null ? null : match[0];
}

// ---------------------------------------------------------------------------
// Neutralisation
// ---------------------------------------------------------------------------

const RATING =
  "strong\\s+buy|strong\\s+sell|buy|sell|hold|outperform(?:er)?|underperform(?:er)?|overweight|underweight|market\\s+perform|market\\s+outperform|equal[- ]weight|neutral|accumulate|reduce";

const ACTION =
  "maintains?|maintained|reiterates?|reiterated|raises?|raised|lowers?|lowered|lifts?|lifted|boosts?|boosted|cuts?|cut|trims?|trimmed|slashes?|slashed|hikes?|hiked|upgrades?|upgraded|downgrades?|downgraded|initiates?|initiated|rates?|rated|assigns?|assigned|adjusts?|adjusted|revises?|revised|updates?|updated|sets?|set|writes?";

/** Verbs that assign a rating; narrower than ACTION to avoid verb false-positives. */
const STANCE_ACTION =
  "maintains?|maintained|reiterates?|reiterated|raises?|raised|lowers?|lowered|lifts?|lifted|boosts?|boosted|upgrades?|upgraded|downgrades?|downgraded|initiates?|initiated|rates?|rated|moves?|moved";

const TARGET = "(?:price|profit|upside|downside)\\s+target|target\\s+price";
const AMOUNT = "\\$?\\d+(?:\\.\\d+)?";

/** Ordered rewrites; each one removes or neutralises a real advisory form. */
const NEUTRALISE_RULES = [
  // "$105 price target [cut to $X]" -> neutral estimate (leading verb kept)
  [new RegExp(`(?<![\\w$])${AMOUNT}\\s+(?:${TARGET})\\b(?:\\s+(?:${ACTION}\\s+)?(?:of|to|at)\\s*${AMOUNT})?`, "gi"), "estimate"],
  // "price target [cut to $X]" -> neutral estimate (leading verb kept)
  [new RegExp(`\\b(?:${TARGET})\\b(?:\\s+(?:${ACTION}\\s+)?(?:of|to|at)\\s*${AMOUNT})?`, "gi"), "estimate"],
  // "maintains Buy", "upgrade to Buy", "maintained a Buy rating" -> neutral action
  [new RegExp(`\\b(?:${ACTION})\\s+(?:its\\s+|a\\s+|an\\s+|the\\s+|to\\s+)?(?:strong\\s+)?(?:${RATING})(?:\\s+rating)?\\b`, "gi"), "updated its rating"],
  // "upgraded the stock to Buy" / "downgraded NVDA to Sell" -> neutral action
  [new RegExp(`\\b(${STANCE_ACTION})\\b((?:\\s+(?:the|this|that|its|their|a|an|stock|shares|name|coverage|[A-Z]{1,10})){0,3})\\s+to\\s+(?:strong\\s+)?(?:${RATING})\\b`, "gi"), "$1$2 to its updated rating"],
  // "Buy rating" / "Sell rating" / "Hold rating" -> plain rating noun
  [new RegExp(`\\b(?:strong\\s+)?(?:${RATING})(?:\\s+rating)\\b`, "gi"), "rating"],
  // "analyst has a Buy" / "initiated coverage with a Buy" -> coverage
  [/\b(?:analyst|analysts|firm|desk|brokerage)s?\s+(?:has\s+|initiated\s+coverage\s+with\s+|with\s+|sees\s+|says\s+|said\s+)?(?:a\s+|an\s+)?(?:strong\s+)?(?:buy|sell|hold|outperform|underperform|overweight|underweight|neutral|accumulate|reduce)\b/gi, "analyst coverage"],
  // "analyst recommends buying" / "recommendation" -> neutral view
  [/\b(?:analyst|analysts|firm|desk|brokerage)s?\s+recommend(?:s|ed|ation|ations)?(?:\s+(?:buy|sell|hold)(?:ing)?)?\b/gi, "analyst coverage on"],
  [/\brecommend(?:s|ed|ation|ations)?\b/gi, "analyst view"],
  // trade instructions -> descriptive language
  [/\btake\s+profit\b/gi, "a target level"],
  [/\b(?:re-?)?enter\s+at\b/gi, "trading at"],
  [/\bbuy\s+the\s+dip\b/gi, "see recent weakness"],
  [/\bgo(?:ing)?\s+long\b/gi, "a positive view"],
  [/\bgo(?:ing)?\s+short\b/gi, "a negative view"],
];

/** Last-resort sweep: guarantee the guard words are gone even in odd phrasing. */
function residualSweep(text) {
  return text
    .replace(/\btarget\s+price\b/gi, "estimate")
    .replace(/\bbuy\b/gi, "purchase")
    .replace(/\bsell\b/gi, "sale")
    .replace(/\brecommend(?:ation)?s?\b/gi, "analyst view")
    .replace(/\btake\s+profit\b/gi, "target level")
    .replace(/\benter\s+at\b/gi, "trading at");
}

/** Repairs the spacing/punctuation debris left by removing a clause. */
function tidy(text) {
  return text
    .replace(/\(\s*\)/g, " ")
    .replace(/\ba\s+estimate\b/gi, "an estimate")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([,;:])(?:\s*[,;:])+/g, "$1")
    .replace(/\b(?:and|or|but|with|on|at|to|for|of|from|by|its|a|an|the)\s*(?=[,.;:!?]|$)/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/^[\s,;:.\-]+/, "")
    .replace(/[\s,;:]+$/, "")
    .trim();
}

/**
 * Removes or rewrites advisory fragments so the text contains no trading
 * recommendation. Idempotent: `neutralize(neutralize(x)) === neutralize(x)`.
 */
export function neutralizeAdviceLanguage(text) {
  if (typeof text !== "string" || text.length === 0) {
    return "";
  }
  let out = text;
  for (const [pattern, replacement] of NEUTRALISE_RULES) {
    out = out.replace(pattern, replacement);
  }
  out = tidy(out);
  // If any guard token survived the structured rewrites, neutralise it too.
  if (ADVICE_LANGUAGE_PATTERN.test(out)) {
    out = tidy(residualSweep(out));
  }
  return out;
}
