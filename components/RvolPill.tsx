import { formatRvol } from "@/lib/format";

export interface RvolPillProps {
  value: number | null;
}

/** Relative-volume chip. Amber when volume is unusually elevated (>= 2x). */
export function RvolPill({ value }: RvolPillProps) {
  if (value === null || !Number.isFinite(value)) {
    return <span className="font-mono text-xs text-muted">RVOL —</span>;
  }
  const elevated = value >= 2;
  return (
    <span
      className={`font-mono text-xs ${elevated ? "text-accent" : "text-muted"}`}
      title="Relative volume versus the expected volume to this time of day"
    >
      RVOL {formatRvol(value)}
    </span>
  );
}
