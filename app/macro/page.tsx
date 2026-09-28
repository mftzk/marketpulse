import { Panel } from "@/components/Panel";
import { Refresher } from "@/components/Refresher";
import { RegimeChip } from "@/components/RegimeChip";
import { EmptyState } from "@/components/EmptyState";
import { MOVEMENT_TEXT, movementTone } from "@/components/movement";
import { COPY } from "@/lib/copy";
import { formatClockEt, formatPercent } from "@/lib/format";
import { safeCall } from "@/lib/safe";
import { getMarketContext } from "@/lib/services/market-context";
import type { MarketContextView } from "@/lib/view-types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const EMPTY: MarketContextView = {
  as_of: "",
  session: "closed",
  indices: [],
  sectors: [],
  macro: {},
  regime: null,
  breadth: { advancers: 0, decliners: 0 },
};

export default async function MacroPage() {
  const context = await safeCall<MarketContextView>(
    "macro.page",
    () => getMarketContext() as unknown as Promise<MarketContextView>,
    EMPTY,
  );

  const seriesKeys = Object.keys(context.macro).sort();
  const totalBreadth = context.breadth.advancers + context.breadth.decliners;
  const advancePct = totalBreadth > 0 ? (context.breadth.advancers / totalBreadth) * 100 : 0;

  return (
    <div className="space-y-3">
      <Refresher intervalMs={30_000} />
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-sm text-ink">{COPY.macro.title}</h1>
        <span className="font-mono text-[11px] text-muted">
          as of {formatClockEt(context.as_of)}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Panel title={COPY.macro.series}>
          {seriesKeys.length === 0 ? (
            <EmptyState title="No macro series available." />
          ) : (
            <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-4">
              {seriesKeys.map((key) => {
                const entry = context.macro[key];
                return (
                  <div key={key} className="border border-hairline bg-panel-alt p-2">
                    <div className="font-mono text-[10px] uppercase tracking-wide text-muted">
                      {key}
                    </div>
                    <div className="mt-1 font-mono text-base text-ink">
                      {entry.value.toFixed(Math.abs(entry.value) >= 100 ? 1 : 2)}
                      {entry.unit ? (
                        <span className="ml-1 text-[11px] text-muted">{entry.unit}</span>
                      ) : null}
                    </div>
                    <div className={`font-mono text-[11px] ${MOVEMENT_TEXT[movementTone(entry.change)]}`}>
                      {formatPercent(entry.change)}
                    </div>
                    <div className="mt-0.5 font-mono text-[10px] text-muted">
                      prev {entry.previous === null ? "—" : entry.previous.toFixed(2)}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>

        <div className="space-y-3">
          <Panel title={COPY.macro.regime}>
            <RegimeChip regime={context.regime} showDescription />
            {context.regime ? (
              <ul className="mt-3 list-disc space-y-1 pl-4 text-xs text-muted">
                {context.regime.evidence.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-xs text-muted">No regime evidence available.</p>
            )}
          </Panel>

          <Panel title={COPY.macro.breadth}>
            <div className="flex items-center justify-between text-[11px] text-muted">
              <span>{COPY.macro.advancers}</span>
              <span>{COPY.macro.decliners}</span>
            </div>
            <div className="mt-1 flex h-2 w-full overflow-hidden bg-hairline">
              <div className="h-full bg-positive" style={{ width: `${advancePct}%` }} />
              <div className="h-full bg-negative" style={{ width: `${100 - advancePct}%` }} />
            </div>
            <div className="mt-1 flex items-center justify-between font-mono text-xs">
              <span className="text-positive">{context.breadth.advancers}</span>
              <span className="text-negative">{context.breadth.decliners}</span>
            </div>
          </Panel>
        </div>
      </div>

      <Panel title={COPY.macro.heatmap}>
        {context.sectors.length === 0 ? (
          <EmptyState title="No sector data available." />
        ) : (
          <div className="min-w-0 overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-hairline text-[10px] uppercase tracking-wide text-muted">
                  <th className="py-1.5 pr-3 font-medium">Sector</th>
                  <th className="py-1.5 pr-3 font-medium">ETF</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Change</th>
                  <th className="py-1.5 pr-3 text-right font-medium">{COPY.macro.advancers}</th>
                  <th className="py-1.5 pr-3 text-right font-medium">{COPY.macro.decliners}</th>
                  <th className="py-1.5 font-medium">{COPY.macro.topEvent}</th>
                </tr>
              </thead>
              <tbody>
                {context.sectors.map((sector) => (
                  <tr key={sector.slug} className="border-b border-hairline last:border-0">
                    <td className="py-2 pr-3 text-ink">{sector.name}</td>
                    <td className="py-2 pr-3 font-mono text-muted">{sector.etf_symbol ?? "—"}</td>
                    <td className={`py-2 pr-3 text-right font-mono ${MOVEMENT_TEXT[movementTone(sector.change_pct)]}`}>
                      {formatPercent(sector.change_pct)}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono text-positive">
                      {sector.advancers}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono text-negative">
                      {sector.decliners}
                    </td>
                    <td className="py-2">
                      {sector.top_event ? (
                        <a
                          href={`/events/${sector.top_event.event_id}`}
                          className="line-clamp-1 text-muted hover:text-accent"
                        >
                          {sector.top_event.headline}
                        </a>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
