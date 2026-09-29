import {
  ADVICE_LANGUAGE_PATTERN as coreAdviceLanguagePattern,
  findAdviceLanguage as coreFindAdviceLanguage,
  neutralizeAdviceLanguage as coreNeutralizeAdviceLanguage,
} from "./advice-lexicon.mjs";

/**
 * Typed facade over the shared, dependency-free lexicon in `advice-lexicon.mjs`.
 *
 * The `.mjs` module is the single source of truth because `scripts/smoke.mjs`
 * (a plain `node` script) imports it directly — the same constant the pipeline
 * neutralises with is the one the acceptance harness asserts against, so the
 * two can never drift apart.
 *
 * This app imports the facade so the lexicon participates in the TypeScript
 * build and so tests can import `@/lib/analysis/advice-lexicon` the normal way.
 */

export const ADVICE_LANGUAGE_PATTERN: RegExp = coreAdviceLanguagePattern;

/** Returns the offending advisory substring, or `null` when the text is clean. */
export function findAdviceLanguage(text: string): string | null {
  return coreFindAdviceLanguage(text);
}

/**
 * Removes or rewrites advisory fragments (ratings, price targets, trade
 * instructions) so the text carries no recommendation. Idempotent.
 */
export function neutralizeAdviceLanguage(text: string): string {
  return coreNeutralizeAdviceLanguage(text);
}
