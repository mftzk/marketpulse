"use client";

import { useEffect, useState } from "react";

import type { IntradayMarkerDTO } from "@/lib/core/detail";
import { COPY } from "@/lib/copy";
import { formatClockEt, formatDate, formatScore } from "@/lib/format";
import type { ReplayView as ReplayData } from "@/lib/view-types";

import { EmptyState } from "./EmptyState";
import { IntradayChart } from "./IntradayChart";
import { Panel } from "./Panel";

export interface ReplayViewProps {
  initialDate: string;
  initialData: ReplayData;
}

export function ReplayView({ initialDate, initialData }: ReplayViewProps) {
  const [date, setDate] = useState(initialDate);
  const [data, setData] = useState<ReplayData>(initialData);
  const [cursor, setCursor] = useState(initialData.timeline.length);
  const [ticker, setTicker] = useState<string>(Object.keys(initialData.series)[0] ?? "");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      try {
        const response = await fetch(`/api/replay?date=${encodeURIComponent(date)}`, {
          cache: "no-store",
        });
        if (!response.ok) return;
        const json = (await response.json()) as { data: ReplayData };
        if (!active) return;
        setData(json.data);
        setCursor(json.data.timeline.length);
        setTicker(Object.keys(json.data.series)[0] ?? "");
      } catch {
        // keep last good
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [date]);

  const revealed = data.timeline.slice(0, cursor);
  const seriesKeys = Object.keys(data.series);
  const bars = ticker ? data.series[ticker] ?? [] : [];
  const markers: IntradayMarkerDTO[] = revealed
    .filter((item) => item.ts)
    .map((item) => ({
      time: Math.floor(new Date(item.ts as string).getTime() / 1000),
      label: item.label,
      event_id: item.event_id,
      impact_score: item.impact_score ?? 0,
      catalyst_direction: null,
    }));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-sm text-ink">{COPY.replay.title}</h1>
        <span className="border border-hairline px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">REPLAY</span>
        <label className="flex items-center gap-2 text-[11px] text-muted">
          {COPY.replay.date}
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="border border-hairline bg-panel-alt px-2 py-1 font-mono text-xs text-ink outline-none focus:border-accent"
          />
        </label>
        {loading ? <span className="text-[11px] text-accent">{COPY.common.loading}…</span> : null}
      </div>

      <Panel title={COPY.replay.scrubber}>
        <div className="space-y-2">
          <input
            type="range"
            min={0}
            max={data.timeline.length}
            value={Math.min(cursor, data.timeline.length)}
            onChange={(e) => setCursor(Number(e.target.value))}
            className="w-full accent-[#ffb000]"
            aria-label={COPY.replay.scrubber}
          />
          <div className="flex items-center justify-between font-mono text-[11px] text-muted">
            <span>
              {revealed.length} / {data.timeline.length} events
            </span>
            <span>{revealed.length > 0 ? `${formatDate(revealed[revealed.length - 1].ts)} ${formatClockEt(revealed[revealed.length - 1].ts)}` : "—"}</span>
          </div>
          {data.session_windows.length > 0 ? (
            <div className="flex gap-2 text-[10px] uppercase tracking-wide text-muted">
              {data.session_windows.map((w) => (
                <span key={w.name} className="border border-hairline px-1.5 py-0.5">
                  {w.name.replaceAll("_", " ")}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </Panel>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Panel
          title={COPY.replay.ticker}
          action={
            seriesKeys.length > 0 ? (
              <select
                value={ticker}
                onChange={(e) => setTicker(e.target.value)}
                className="border border-hairline bg-panel-alt px-2 py-1 font-mono text-xs text-ink outline-none focus:border-accent"
              >
                {seriesKeys.map((key) => (
                  <option key={key} value={key}>
                    {key}
                  </option>
                ))}
              </select>
            ) : null
          }
        >
          {bars.length > 0 ? (
            <IntradayChart bars={bars} markers={markers} ticker={ticker} height={420} />
          ) : (
            <EmptyState title="No price series for this date." />
          )}
        </Panel>

        <Panel title={COPY.replay.events}>
          {revealed.length === 0 ? (
            <p className="text-xs text-muted">{COPY.replay.empty}</p>
          ) : (
            <ol className="max-h-[520px] space-y-2 overflow-auto">
              {revealed
                .slice()
                .reverse()
                .map((item) => (
                  <li key={`${item.event_id}-${item.ts}`} className="border border-hairline p-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[11px] text-muted">
                        {formatDate(item.ts)} {formatClockEt(item.ts)}
                      </span>
                      <span className="font-mono text-[11px] text-ink">
                        {formatScore(item.impact_score)}
                      </span>
                    </div>
                    <a
                      href={`/events/${item.event_id}`}
                      className="mt-1 block text-xs text-ink hover:text-accent"
                    >
                      {item.label}
                    </a>
                  </li>
                ))}
            </ol>
          )}
        </Panel>
      </div>
    </div>
  );
}
