import type { QualityLabel } from "@/lib/core/dto";

export interface SourceBadgeProps {
  name: string;
  tier: number;
  qualityLabel: QualityLabel;
}

const QUALITY_TONE: Record<QualityLabel, string> = {
  high: "text-accent",
  medium: "text-ink",
  low: "text-muted",
};

/** Source name + tier + quality label. */
export function SourceBadge({ name, tier, qualityLabel }: SourceBadgeProps) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-[11px] text-muted">
      <span className="truncate text-ink">{name}</span>
      <span className="font-mono">T{tier}</span>
      <span className={`uppercase tracking-wide ${QUALITY_TONE[qualityLabel]}`}>
        {qualityLabel}
      </span>
    </span>
  );
}
