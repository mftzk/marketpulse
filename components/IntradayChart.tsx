"use client";

import { useEffect, useRef, useState } from "react";
import type {
  IChartApi,
  ISeriesApi,
  SeriesMarkerBar,
  Time,
  UTCTimestamp,
} from "lightweight-charts";

import type { IntradayBarDTO, IntradayMarkerDTO } from "@/lib/core/detail";

export interface IntradayChartProps {
  bars: IntradayBarDTO[];
  markers?: IntradayMarkerDTO[];
  height?: number;
  ticker?: string | null;
}

function nearestBarTime(barTimes: number[], target: number): number {
  if (barTimes.length === 0) {
    return target;
  }
  let best = barTimes[0];
  let bestDelta = Math.abs(best - target);
  for (const time of barTimes) {
    const delta = Math.abs(time - target);
    if (delta < bestDelta) {
      best = time;
      bestDelta = delta;
    }
  }
  return best;
}

/**
 * Intraday candlestick chart with vertical event markers. `lightweight-charts`
 * is imported dynamically inside `useEffect` so the server build never touches
 * `window`.
 */
export function IntradayChart({ bars, markers = [], height = 360, ticker }: IntradayChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (bars.length === 0 || !containerRef.current) {
      return;
    }
    let disposed = false;
    let teardown: (() => void) | undefined;

    void (async () => {
      try {
        const LWC = await import("lightweight-charts");
        const container = containerRef.current;
        if (disposed || !container) {
          return;
        }

        const chart: IChartApi = LWC.createChart(container, {
          height,
          // An explicit locale is required: without it the library falls back to
          // `navigator.language`, and on hosts reporting a POSIX-suffixed tag
          // ("en-US@posix") `Intl` throws `Invalid language tag` on every render.
          localization: {
            locale: "en-US",
            priceFormatter: (price: number) => price.toFixed(2),
          },
          layout: {
            background: { color: "transparent" },
            textColor: "#8fa1bb",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: 11,
          },
          grid: {
            vertLines: { color: "#141d2c" },
            horzLines: { color: "#141d2c" },
          },
          rightPriceScale: { borderColor: "#1b2434" },
          timeScale: { borderColor: "#1b2434", timeVisible: true, secondsVisible: false },
          crosshair: { horzLine: { color: "#ffb000" }, vertLine: { color: "#ffb000" } },
        });

        const candle: ISeriesApi<"Candlestick", Time> = chart.addSeries(LWC.CandlestickSeries, {
          upColor: "#3ddc84",
          downColor: "#ff5c5c",
          borderVisible: false,
          wickUpColor: "#3ddc84",
          wickDownColor: "#ff5c5c",
        });

        const sorted = [...bars].sort((a, b) => a.time - b.time);
        candle.setData(
          sorted.map((bar) => ({
            time: bar.time as UTCTimestamp,
            open: bar.open,
            high: bar.high,
            low: bar.low,
            close: bar.close,
          })),
        );

        const volume: ISeriesApi<"Histogram", Time> = chart.addSeries(LWC.HistogramSeries, {
          priceScaleId: "",
          priceFormat: { type: "volume" },
          color: "#1b2434",
        });
        volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
        volume.setData(
          sorted.map((bar) => ({
            time: bar.time as UTCTimestamp,
            value: bar.volume,
            color: bar.close >= bar.open ? "rgba(61,220,132,0.35)" : "rgba(255,92,92,0.35)",
          })),
        );

        const barTimes = sorted.map((bar) => bar.time);
        const markerData: SeriesMarkerBar<Time>[] = markers
          .map((marker) => {
            const time = nearestBarTime(barTimes, marker.time) as UTCTimestamp;
            const negative = marker.catalyst_direction === "negative";
            const positive = marker.catalyst_direction === "positive";
            return {
              time,
              position: negative ? "aboveBar" : "belowBar",
              color: positive ? "#3ddc84" : negative ? "#ff5c5c" : "#ffb000",
              shape: positive ? "arrowUp" : negative ? "arrowDown" : "circle",
              text: `${marker.label}${marker.impact_score ? ` ${marker.impact_score.toFixed(0)}` : ""}`,
            } satisfies SeriesMarkerBar<Time>;
          })
          .sort((a, b) => (a.time as number) - (b.time as number));
        if (markerData.length > 0) {
          LWC.createSeriesMarkers(candle, markerData);
        }

        chart.timeScale().fitContent();

        const resize = new ResizeObserver(() => {
          chart.applyOptions({ width: container.clientWidth });
        });
        resize.observe(container);

        teardown = () => {
          resize.disconnect();
          chart.remove();
        };
      } catch {
        if (!disposed) {
          setFailed(true);
        }
      }
    })();

    return () => {
      disposed = true;
      teardown?.();
    };
  }, [bars, markers, height]);

  if (bars.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center border border-dashed border-hairline text-xs text-muted">
        No intraday bars available
      </div>
    );
  }

  return (
    <div className="min-w-0">
      <div ref={containerRef} style={{ height }} className="w-full" aria-label={ticker ? `${ticker} intraday chart` : "intraday chart"} />
      {failed ? (
        <p className="mt-1 text-[11px] text-muted">Chart failed to render.</p>
      ) : null}
    </div>
  );
}
