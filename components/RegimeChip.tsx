import type { RegimeView } from "@/lib/view-types";

export interface RegimeChipProps {
  regime: RegimeView | null;
  showDescription?: boolean;
}

export function RegimeChip({ regime, showDescription = false }: RegimeChipProps) {
  if (!regime) {
    return (
      <span className="border border-hairline px-2 py-1 text-[11px] text-muted">
        Regime — unknown
      </span>
    );
  }
  return (
    <div className="min-w-0">
      <span className="inline-flex items-center gap-1.5 border border-hairline px-2 py-1 text-[11px] text-ink">
        <span className="text-[10px] uppercase tracking-wide text-muted">Regime</span>
        <span className="font-mono text-accent">{regime.label}</span>
      </span>
      {showDescription ? (
        <p className="mt-1 text-xs text-muted">{regime.description}</p>
      ) : null}
    </div>
  );
}
