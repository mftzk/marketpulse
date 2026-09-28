export const CATALYST_DIRECTIONS = ["positive", "negative", "neutral", "mixed"] as const;

export type CatalystDirection = (typeof CATALYST_DIRECTIONS)[number];

export const CATALYST_DIRECTION_LABELS: Record<CatalystDirection, string> = {
  positive: "Positive",
  negative: "Negative",
  neutral: "Neutral",
  mixed: "Mixed",
};

export function isCatalystDirection(value: string): value is CatalystDirection {
  return (CATALYST_DIRECTIONS as readonly string[]).includes(value);
}
