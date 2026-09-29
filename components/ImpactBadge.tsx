import type { ImpactBand } from "@/lib/core/dto";
import { formatScore } from "@/lib/format";

export interface ImpactBadgeProps {
  score: number | null;
  band: ImpactBand | null;
  size?: "sm" | "md";
}

const BAND_TONE: Record<ImpactBand, string> = {
  high: "border-accent text-accent",
  elevated: "border-accent/60 text-accent/90",
  moderate: "border-hairline text-ink",
  low: "border-hairline text-muted",
  minimal: "border-hairline text-muted",
};

const BAND_TEXT: Record<ImpactBand, string> = {
  high: "High impact",
  elevated: "Elevated",
  moderate: "Moderate",
  low: "Low",
  minimal: "Minimal",
};

/** Uppercase impact badge derived from the computed band. */
export function ImpactBadge({ score, band, size = "md" }: ImpactBadgeProps) {
  const tone = band ? BAND_TONE[band] : "border-hairline text-muted";
  return (
    <span
      className={`inline-flex items-center gap-1.5 border px-1.5 py-0.5 font-mono uppercase tracking-wide ${
        size === "sm" ? "text-[10px]" : "text-[11px]"
      } ${tone}`}
    >
      <span>{band ? BAND_TEXT[band] : "Unavailable"}</span>
      <span className="text-muted">·</span>
      <span>{formatScore(score)}</span>
    </span>
  );
}
