import type { WatchlistStockDTO } from "@/lib/core/detail";
import { formatAge, formatClockEt, formatDate, formatNumberCompact, formatPercent, formatPrice, formatRvol } from "@/lib/format";
import { bandForScore } from "@/lib/scoring/impact";

import { MOVEMENT_TEXT, movementTone } from "./movement";
import { ScoreBar } from "./ScoreBar";

export interface WatchlistTableProps {
  stocks: WatchlistStockDTO[];
  onRemove?: (ticker: string) => void;
  busyTicker?: string | null;
  /**
   * `full` renders the wide table used on the watchlists page; `rail` renders a
   * fixed-column template that never overflows the narrow dashboard right rail.
   */
  variant?: "full" | "rail";
}

export function WatchlistTable({
  stocks,
  onRemove,
  busyTicker,
  variant = "full",
}: WatchlistTableProps) {
  if (stocks.length === 0) {
    return <p className="text-xs text-muted">No tickers in this watchlist.</p>;
  }
  const rail = variant === "rail";
  const headPad = rail ? "pr-1" : "pr-3";
  const cellPad = rail ? "pr-1" : "pr-3";

  return (
    <div className={rail ? "min-w-0" : "min-w-0 overflow-x-auto"}>
      <table
        className={
          rail
            ? "w-full table-fixed border-collapse text-left text-xs"
            : "w-full min-w-[560px] border-collapse text-left text-xs"
        }
      >
        {rail ? (
          <colgroup>
            <col className="w-[42px]" />
            <col className="w-[54px]" />
            <col className="w-[46px]" />
            <col className="w-[34px]" />
            <col />
            <col className="w-[46px]" />
          </colgroup>
        ) : null}
        <thead>
          <tr className="border-b border-hairline text-[10px] uppercase tracking-wide text-muted">
            <th className={`py-1.5 ${headPad} font-medium`}>Ticker</th>
            <th className={`py-1.5 ${headPad} text-right font-medium`}>Price</th>
            <th className={`py-1.5 ${headPad} text-right font-medium`}>Day</th>
            <th className={`py-1.5 ${headPad} text-right font-medium`}>RVOL</th>
            <th className={`py-1.5 ${headPad} font-medium`}>
              {rail ? "Catalyst" : "Latest catalyst"}
            </th>
            <th className={`py-1.5 ${rail ? "" : headPad} text-right font-medium`}>Impact</th>
            {onRemove && !rail ? <th className="py-1.5 font-medium" /> : null}
          </tr>
        </thead>
        <tbody>
          {stocks.map((stock) => {
            const score = stock.impact_score;
            const band = score === null ? null : bandForScore(score);
            const tone = movementTone(stock.change_pct);
            const catalyst = stock.latest_catalyst ?? "No catalyst recorded";
            return (
              <tr key={stock.ticker} className="border-b border-hairline last:border-0">
                <td className={`py-2 ${cellPad} font-mono text-ink`}>
                  <a href={`/stocks/${stock.ticker}`} className="hover:text-accent">
                    {stock.ticker}
                  </a>
                </td>
                <td className={`py-2 ${cellPad} text-right font-mono text-ink`}>
                  {formatPrice(stock.price)}
                </td>
                <td className={`py-2 ${cellPad} text-right font-mono ${MOVEMENT_TEXT[tone]}`}>
                  {formatPercent(stock.change_pct)}
                </td>
                <td className={`py-2 ${cellPad} text-right font-mono text-muted`} title={`Session: ${stock.rvol_session ?? "unavailable"}; actual cumulative volume: ${formatNumberCompact(stock.rvol_volume)}; expected at same session time: ${formatNumberCompact(stock.rvol_expected_volume)} from ${stock.rvol_sample_count === null ? "unavailable" : `${stock.rvol_sample_count}/20`} matching sessions; measured: ${stock.rvol_as_of ? `${formatDate(stock.rvol_as_of)} ${formatClockEt(stock.rvol_as_of)}` : "unavailable"}; feed: ${stock.rvol_data_status}`}>
                  <div>{formatRvol(stock.rvol, 1)}</div>
                  {!rail ? <div className="text-[9px] leading-tight">{stock.rvol_session ?? "session —"} · {stock.rvol_sample_count === null ? "—/20" : `${stock.rvol_sample_count}/20`}</div> : null}
                </td>
                <td className={`min-w-0 overflow-hidden py-2 ${cellPad}`}>
                  <div className="truncate text-ink" title={catalyst}>
                    {catalyst}
                  </div>
                  {stock.catalyst_age_minutes !== null ? (
                    <div className="truncate text-[10px] text-muted">
                      {formatAge(stock.catalyst_age_minutes)}
                    </div>
                  ) : null}
                </td>
                <td className="py-2 text-right">
                  {score === null ? (
                    <span className="font-mono text-muted">—</span>
                  ) : rail ? (
                    <div className="ml-auto w-[42px]">
                      <span className="font-mono text-[11px] text-ink">{score.toFixed(1)}</span>
                      <ScoreBar value={score / 100} />
                    </div>
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
                {onRemove && !rail ? (
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
