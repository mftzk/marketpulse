import { formatPercent, formatPrice } from "@/lib/format";
import type { MarketIndexView } from "@/lib/view-types";

import { MOVEMENT_TEXT, movementTone } from "./movement";

export interface MacroStripProps {
  indices: MarketIndexView[];
}

/** Compact index strip (SPY / QQQ / SOXX / VIX). */
export function MacroStrip({ indices }: MacroStripProps) {
  if (indices.length === 0) {
    return <span className="text-[11px] text-muted">Indices unavailable</span>;
  }
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {indices.map((index) => {
        const change = index.change_pct ?? index.change ?? null;
        const level = index.price ?? index.value ?? null;
        const tone = movementTone(change);
        return (
          <div key={index.symbol} className="flex items-baseline gap-1.5">
            <span className="font-mono text-[11px] text-muted">{index.symbol}</span>
            <span className="font-mono text-xs text-ink">{formatPrice(level, 2)}</span>
            <span className={`font-mono text-[11px] ${MOVEMENT_TEXT[tone]}`}>
              {formatPercent(change)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
