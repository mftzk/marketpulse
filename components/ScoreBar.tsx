export interface ScoreBarProps {
  /** Normalized value 0..1. */
  value: number;
  className?: string;
  tone?: "accent" | "muted";
}

/** Thin normalized 0..1 bar used in impact breakdowns and score cells. */
export function ScoreBar({ value, className, tone = "accent" }: ScoreBarProps) {
  const pct = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)) * 100;
  const fill = tone === "accent" ? "bg-accent" : "bg-muted";
  return (
    <div
      className={`h-[3px] w-full overflow-hidden bg-hairline ${className ?? ""}`}
      role="img"
      aria-label={`normalized ${pct.toFixed(0)} percent`}
    >
      <div className={`h-full ${fill}`} style={{ width: `${pct}%` }} />
    </div>
  );
}
