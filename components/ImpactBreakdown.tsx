import type { ImpactComponentDTO } from "@/lib/core/dto";
import { formatClockEt, formatDate, formatScore } from "@/lib/format";

import { ScoreBar } from "./ScoreBar";

export interface ImpactBreakdownProps {
  components: ImpactComponentDTO[];
  algorithmVersion?: string;
  computedAt?: string | null;
  initialScore?: number | null;
  initialComputedAt?: string | null;
}

function rawDisplay(raw: number | null, key: string): string {
  if (raw === null) return "unavailable";
  if (key === "freshness") {
    return `${Math.round(raw)}m`;
  }
  return raw.toFixed(2);
}

/** Horizontal bar list: raw → normalized, weight, points and explanation. */
export function ImpactBreakdown({ components, algorithmVersion, computedAt, initialScore, initialComputedAt }: ImpactBreakdownProps) {
  if (components.length === 0) {
    return <p className="text-xs text-muted">No component detail recorded for this score.</p>;
  }
  return (
    <div className="space-y-2">
      <div className="border-b border-hairline pb-2 text-[11px] text-muted">
        <div>Current score {computedAt ? `recalculated ${formatDate(computedAt)} ${formatClockEt(computedAt)}` : "calculation time unavailable"}</div>
        <div>Initial score {initialScore === null || initialScore === undefined ? "unavailable" : formatScore(initialScore)}
          {initialComputedAt ? ` · ${formatDate(initialComputedAt)} ${formatClockEt(initialComputedAt)}` : ""}
        </div>
        <div className="mt-1">Impact is an event-impact score, not the probability that price will rise. Catalyst direction and observed price reaction are separate.</div>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2">
        {components.map((c) => (
          <div key={c.key} className="col-span-2 grid grid-cols-[minmax(0,1.1fr)_minmax(0,2fr)_auto] items-center gap-3">
            <div className="min-w-0">
              <div className="truncate text-xs text-ink">{c.label}</div>
              <div className="font-mono text-[11px] text-muted">
                {rawDisplay(c.raw, c.key)} → {c.normalized === null ? "unavailable" : c.normalized.toFixed(2)}
              </div>
            </div>
            {c.normalized === null ? <span className="text-[10px] text-muted">unavailable</span> : <ScoreBar value={c.normalized} />}
            <div className="text-right">
              <div className="font-mono text-xs text-ink">{formatScore(c.points)}</div>
              <div className="font-mono text-[10px] text-muted">w {c.weight === null ? "—" : c.weight.toFixed(1)}</div>
            </div>
            <p className="col-span-3 -mt-1 text-[11px] text-muted">{c.explanation}</p>
          </div>
        ))}
      </div>
      {algorithmVersion ? (
        <p className="pt-1 text-[10px] uppercase tracking-wide text-muted">
          algorithm {algorithmVersion}
        </p>
      ) : null}
    </div>
  );
}
