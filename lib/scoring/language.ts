import type { CatalystDirection } from "@/lib/core/catalyst";

/**
 * Language guard: the product presents evidence, never investment advice.
 * `assertNoAdvice` is run over every generated interpretation and every
 * dataset string (headlines, summaries, reasoning, interpretations) before
 * anything is persisted or rendered.
 */

export const ADVICE_PATTERNS: readonly RegExp[] = [
  /\bbuy\b/i,
  /\bsell\b/i,
  /\bgo long\b/i,
  /\bgo short\b/i,
  /\bshorting\b/i,
  /\bshort the (stock|position)\b/i,
  /\btake profit\b/i,
  /\bstop[- ]?loss\b/i,
  /\btarget price\b/i,
  /\bprice target\b/i,
  /\bprofit target\b/i,
  /\brecommend(?:ed|s|ation)?\b/i,
  /\bshould (buy|sell|hold|trade)\b/i,
  /\benter at\b/i,
  /\bentry point\b/i,
  /\bupside target\b/i,
  /\bdownside target\b/i,
  /\bbuy signal\b/i,
  /\bsell signal\b/i,
  /\baccumulate\b/i,
  /\bexit (?:your )?position\b/i,
  /\btrim (?:your )?position\b/i,
  /\badd to (?:your )?position\b/i,
  /\bbuy the dip\b/i,
  /\bstrong buy\b/i,
  /\bstrong sell\b/i,
  /\binitiate (?:a )?(?:long|short) position\b/i,
];

/** Returns the offending substring if advice language is found, else `null`. */
export function findAdvice(text: string): string | null {
  for (const pattern of ADVICE_PATTERNS) {
    const match = pattern.exec(text);
    if (match !== null) {
      return match[0];
    }
  }
  return null;
}

/** Throws if the text contains advice language. */
export function assertNoAdvice(text: string): void {
  const match = findAdvice(text);
  if (match !== null) {
    throw new Error(`Advice language detected (${JSON.stringify(match)}) in: ${JSON.stringify(text)}`);
  }
}

export interface InterpretationInput {
  direction: CatalystDirection;
  eventTypeLabel?: string | null;
  surpriseLabel?: string | null;
  surprisePct?: number | null;
  rvol?: number | null;
  relativeStrengthPp?: number | null;
  benchmarkSymbol?: string | null;
}

const DIRECTION_WORD: Record<CatalystDirection, string> = {
  positive: "Positive",
  negative: "Negative",
  neutral: "Neutral",
  mixed: "Mixed",
};

function formatPct(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  const sign = rounded >= 0 ? "+" : "";
  return `${sign}${rounded.toFixed(1)}%`;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Builds a 1–2 sentence, evidence-only interpretation string (see §6.1). The
 * output is guaranteed to pass `assertNoAdvice`.
 */
export function buildInterpretation(input: InterpretationInput): string {
  const dirWord = DIRECTION_WORD[input.direction] ?? "Neutral";
  const surpriseLabel = input.surpriseLabel ?? "surprise";
  const typeLabel = input.eventTypeLabel ?? "event";

  const parts: string[] = [];

  if (isFiniteNumber(input.surprisePct)) {
    parts.push(`${dirWord} ${surpriseLabel} surprise (${formatPct(input.surprisePct)} vs consensus)`);
  } else {
    parts.push(`${dirWord} ${typeLabel.toLowerCase()}`);
  }

  if (isFiniteNumber(input.rvol)) {
    const prefix = input.rvol >= 1.5 ? "elevated " : "";
    parts.push(`${prefix}relative volume (${input.rvol.toFixed(1)}x)`);
  }

  if (isFiniteNumber(input.relativeStrengthPp)) {
    const bench = input.benchmarkSymbol ? ` versus ${input.benchmarkSymbol}` : "";
    const direction = input.relativeStrengthPp >= 0 ? "outperformance" : "underperformance";
    parts.push(`${direction} of ${Math.abs(input.relativeStrengthPp).toFixed(1)}pp${bench}`);
  }

  const opening = parts.shift() ?? `${dirWord} ${typeLabel.toLowerCase()}`;
  let sentence = opening;
  if (parts.length === 1) {
    sentence += ` accompanied by ${parts[0]}`;
  } else if (parts.length >= 2) {
    sentence += ` accompanied by ${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  }
  sentence += ".";

  assertNoAdvice(sentence);
  return sentence;
}
