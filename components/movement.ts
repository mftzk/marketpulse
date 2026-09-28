/**
 * Green/red are reserved for measured positive/negative market movement.
 * This helper is the single mapping from a signed number to a text tone.
 */
export type MovementTone = "up" | "down" | "flat";

export function movementTone(value: number | null | undefined): MovementTone {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "flat";
  }
  if (value > 0) {
    return "up";
  }
  if (value < 0) {
    return "down";
  }
  return "flat";
}

export const MOVEMENT_TEXT: Record<MovementTone, string> = {
  up: "text-positive",
  down: "text-negative",
  flat: "text-muted",
};

export const MOVEMENT_LABEL: Record<MovementTone, string> = {
  up: "positive movement",
  down: "negative movement",
  flat: "no net movement",
};
