import { CATALYST_DIRECTION_LABELS, type CatalystDirection } from "@/lib/core/catalyst";

export interface CatalystPillProps {
  direction: CatalystDirection | null;
}

/**
 * Catalyst-direction chip. Green/red are reserved for measured price movement,
 * so a classification is shown in amber/muted rather than as an action colour.
 */
export function CatalystPill({ direction }: CatalystPillProps) {
  const value = direction ?? "neutral";
  const label = CATALYST_DIRECTION_LABELS[value];
  const tone = value === "neutral" ? "text-muted" : "text-accent";
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] ${tone}`}>
      <span className="text-[9px] uppercase tracking-wide text-muted">Catalyst</span>
      <span className="font-mono">{label}</span>
    </span>
  );
}
