import type { ImpactComponentDTO } from "@/lib/core/dto";
import { formatScore } from "@/lib/format";

import { ScoreBar } from "./ScoreBar";

export interface ImpactBreakdownProps {
  components: ImpactComponentDTO[];
  algorithmVersion?: string;
}

function rawDisplay(raw: number, key: string): string {
  if (key === "freshness") {
    return `${Math.round(raw)}m`;
  }
  return raw.toFixed(2);
}

/** Horizontal bar list: raw → normalized, weight, points and explanation. */
export function ImpactBreakdown({ components, algorithmVersion }: ImpactBreakdownProps) {
  if (components.length === 0) {
    return <p className="text-xs text-muted">No component detail recorded for this score.</p>;
  }
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2">
        {components.map((c) => (
          <div key={c.key} className="col-span-2 grid grid-cols-[minmax(0,1.1fr)_minmax(0,2fr)_auto] items-center gap-3">
            <div className="min-w-0">
              <div className="truncate text-xs text-ink">{c.label}</div>
              <div className="font-mono text-[11px] text-muted">
                {rawDisplay(c.raw, c.key)} → {c.normalized.toFixed(2)}
              </div>
            </div>
            <ScoreBar value={c.normalized} />
            <div className="text-right">
              <div className="font-mono text-xs text-ink">{formatScore(c.points)}</div>
              <div className="font-mono text-[10px] text-muted">w {c.weight}</div>
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
