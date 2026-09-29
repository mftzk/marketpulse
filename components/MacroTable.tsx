import { formatClockEt, formatDate, formatMacroChange, formatPrice } from "@/lib/format";
import { macroSeriesKind } from "@/lib/market/macro";
import type { MacroValueView } from "@/lib/view-types";

import { MOVEMENT_TEXT, movementTone } from "./movement";

export interface MacroTableProps {
  macro: Record<string, MacroValueView>;
  /** Optional series ordering; unknown series are appended. */
  order?: string[];
  limit?: number;
}

function seriesOrder(macro: Record<string, MacroValueView>, order?: string[]): string[] {
  const keys = Object.keys(macro);
  if (!order) {
    return keys.sort();
  }
  const known = order.filter((key) => key in macro);
  const rest = keys.filter((key) => !known.includes(key)).sort();
  return [...known, ...rest];
}

/** Compact macro series table used on the dashboard and the macro page. */
export function MacroTable({ macro, order, limit }: MacroTableProps) {
  const keys = seriesOrder(macro, order);
  const shown = typeof limit === "number" ? keys.slice(0, limit) : keys;

  if (shown.length === 0) {
    return <p className="text-xs text-muted">No macro series available.</p>;
  }

  return (
    <div className="min-w-0 overflow-x-auto">
      <table className="w-full min-w-[320px] border-collapse text-left text-xs">
        <thead>
          <tr className="border-b border-hairline text-[10px] uppercase tracking-wide text-muted">
            <th className="py-1.5 pr-3 font-medium">Series</th>
            <th className="py-1.5 pr-3 text-right font-medium">Value</th>
            <th className="py-1.5 pr-3 text-right font-medium">Change</th>
            <th className="py-1.5 text-right font-medium">As of</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((key) => {
            const entry = macro[key];
            const digits = entry.value !== null && Math.abs(entry.value) >= 100 ? 1 : 2;
            const showUnit = macroSeriesKind(key) === "rate" && Boolean(entry.unit);
            return (
              <tr key={key} className="border-b border-hairline last:border-0">
                <td className="py-1.5 pr-3 font-mono text-muted">{key}</td>
                <td className="py-1.5 pr-3 text-right font-mono text-ink">
                  {formatPrice(entry.value, digits)}
                  {showUnit ? <span className="ml-1 text-muted">{entry.unit}</span> : null}
                </td>
                <td className={`py-1.5 pr-3 text-right font-mono ${MOVEMENT_TEXT[movementTone(entry.change)]}`}>
                  {formatMacroChange(key, entry.change, entry.unit)}
                </td>
                <td className="py-1.5 text-right font-mono text-[10px] text-muted">
                  {entry.as_of ? `${formatDate(entry.as_of)} ${formatClockEt(entry.as_of)}` : "—"}
                  {entry.data_status ? <span className="ml-2">{entry.data_status}</span> : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
