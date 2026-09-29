import type { QualityLabel } from "@/lib/core/dto";

export interface SourceBadgeProps {
  name: string | null;
  tier: number | null;
  qualityScore: number | null;
  qualityLabel: QualityLabel | null;
  ingestProvider?: string | null;
}

const QUALITY_TONE: Record<QualityLabel | "unavailable", string> = {
  high: "text-accent",
  medium: "text-ink",
  low: "text-muted",
  unavailable: "text-muted",
};

/** Source name + tier + quality label. */
export function SourceBadge({ name, tier, qualityScore, qualityLabel, ingestProvider }: SourceBadgeProps) {
  const quality = qualityLabel ?? "unavailable";
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-[11px] text-muted">
      <span className="truncate text-ink">{name ?? "Source unavailable"}</span>
      {tier !== null ? <span className="font-mono">T{tier}</span> : null}
      <span className="font-mono">quality {qualityScore === null ? "unavailable" : qualityScore.toFixed(2)}</span>
      {ingestProvider ? <span>via {ingestProvider}</span> : null}
      <span className={`uppercase tracking-wide ${QUALITY_TONE[quality]}`}>
        {quality}
      </span>
    </span>
  );
}
