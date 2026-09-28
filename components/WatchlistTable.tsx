import type { WatchlistStockDTO } from "@/lib/core/detail";
import { formatAge, formatPercent, formatPrice, formatRvol } from "@/lib/format";
import { bandForScore } from "@/lib/scoring/impact";

import { MOVEMENT_TEXT, movementTone } from "./movement";
import { ScoreBar } from "./ScoreBar";

export interface WatchlistTableProps {
  stocks: WatchlistStockDTO[];
  onRemove?: (ticker: string) => void;
  busyTicker?: string | null;
}

export function WatchlistTable({ stocks, onRemove, busyTicker }: WatchlistTableProps) {
  if (stocks.length === 0) {
    return <p className="text-xs text-muted">No tickers in this watchlist.</p>;
  }
  return (
    <div className="min-w-0 overflow-x-auto">
      <table className="w-full min-w-[560px] border-collapse text-left text-xs">
        <thead>
          <tr className="border-b border-hairline text-[10px] uppercase tracking-wide text-muted">
            <th className="py-1.5 pr-3 font-medium">Ticker</th>
            <th className="py-1.5 pr-3 text-right font-medium">Price</th>
            <th className="py-1.5 pr-3 text-right font-medium">Day</th>
            <th className="py-1.5 pr-3 text-right font-medium">RVOL</th>
            <th className="py-1.5 pr-3 font-medium">Latest catalyst</th>
            <th className="py-1.5 pr-3 text-right font-medium">Impact</th>
            {onRemove ? <th className="py-1.5 font-medium" /> : null}
          </tr>
        </thead>
        <tbody>
          {stocks.map((stock) => {
            const score = stock.impact_score;
            const band = score === null ? null : bandForScore(score);
            const tone = movementTone(stock.change_pct);
            return (
              <tr key={stock.ticker} className="border-b border-hairline last:border-0">
                <td className="py-2 pr-3 font-mono text-ink">
                  <a href={`/stocks/${stock.ticker}`} className="hover:text-accent">
                    {stock.ticker}
                  </a>
                </td>
                <td className="py-2 pr-3 text-right font-mono text-ink">
                  {formatPrice(stock.price)}
                </td>
                <td className={`py-2 pr-3 text-right font-mono ${MOVEMENT_TEXT[tone]}`}>
                  {formatPercent(stock.change_pct)}
                </td>
                <td className="py-2 pr-3 text-right font-mono text-muted">
                  {formatRvol(stock.rvol)}
                </td>
                <td className="max-w-[240px] py-2 pr-3">
                  <div className="truncate text-ink">
                    {stock.latest_catalyst ?? "No catalyst recorded"}
                  </div>
                  {stock.catalyst_age_minutes !== null ? (
                    <div className="text-[10px] text-muted">
                      {formatAge(stock.catalyst_age_minutes)}
                    </div>
                  ) : null}
                </td>
                <td className="py-2 pr-3 text-right">
                  {score === null ? (
                    <span className="font-mono text-muted">—</span>
                  ) : (
                    <div className="ml-auto w-20">
                      <div className="flex items-center justify-between font-mono text-[11px]">
                        <span className="text-ink">{score.toFixed(1)}</span>
                        <span className="text-muted">{band}</span>
                      </div>
                      <ScoreBar value={score / 100} />
                    </div>
                  )}
                </td>
                {onRemove ? (
                  <td className="py-2 text-right">
                    <button
                      type="button"
                      onClick={() => onRemove(stock.ticker)}
                      disabled={busyTicker === stock.ticker}
                      className="border border-hairline px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted hover:border-negative hover:text-negative disabled:opacity-50"
                    >
                      Remove
                    </button>
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
