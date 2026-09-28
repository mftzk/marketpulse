import { notFound } from "next/navigation";

import { CatalystPill } from "@/components/CatalystPill";
import { ErrorState } from "@/components/ErrorState";
import { ImpactBadge } from "@/components/ImpactBadge";
import { ImpactBreakdown } from "@/components/ImpactBreakdown";
import { IntradayChart } from "@/components/IntradayChart";
import { MacroTable } from "@/components/MacroTable";
import { MOVEMENT_TEXT, movementTone } from "@/components/movement";
import { Panel } from "@/components/Panel";
import { PriceCell } from "@/components/PriceCell";
import { RegimeChip } from "@/components/RegimeChip";
import { SessionPill } from "@/components/SessionPill";
import { SourceBadge } from "@/components/SourceBadge";
import { SourceList } from "@/components/SourceList";
import { Timeline } from "@/components/Timeline";
import { COPY } from "@/lib/copy";
import {
  formatAge,
  formatNumberCompact,
  formatPercent,
  formatPrice,
  formatRvol,
  formatSignedPp,
} from "@/lib/format";
import { getEventDetail } from "@/lib/services/events";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function Row({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-hairline py-1.5 last:border-0">
      <span className="text-[11px] uppercase tracking-wide text-muted">{label}</span>
      <span className={`font-mono text-xs ${tone ?? "text-ink"}`}>{value}</span>
    </div>
  );
}

function SectionPanel({ title, children }: { title: string; children: React.ReactNode }) {
  return <Panel title={title}>{children}</Panel>;
}

export default async function EventDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let result: Awaited<ReturnType<typeof getEventDetail>>;
  try {
    result = await getEventDetail(id);
  } catch {
    return <ErrorState />;
  }
  if (!result) {
    notFound();
  }

  const { event, detail } = result;
  const reaction = detail.price_reaction;

  return (
    <div className="space-y-3">
      <a href="/" className="inline-block text-[11px] uppercase tracking-wide text-muted hover:text-accent">
        ← {COPY.detail.backToFeed}
      </a>

      <Panel bodyClassName="p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-base font-semibold text-ink">
                {detail.overview.ticker ?? "—"}
              </span>
              {detail.overview.company_name ? (
                <span className="text-sm text-muted">{detail.overview.company_name}</span>
              ) : null}
              {detail.overview.sector ? (
                <span className="border border-hairline px-1 text-[10px] uppercase tracking-wide text-muted">
                  {detail.overview.sector}
                </span>
              ) : null}
            </div>
            <h1 className="mt-2 max-w-4xl text-lg leading-snug text-ink">
              {detail.overview.headline}
            </h1>
            <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-muted">
              <span className="text-ink">{detail.overview.event_type_label}</span>
              <CatalystPill direction={detail.overview.catalyst_direction ?? "neutral"} />
              <span>
                Sentiment{" "}
                <span className="font-mono text-ink">
                  {detail.overview.sentiment >= 0 ? "+" : ""}
                  {detail.overview.sentiment.toFixed(2)}
                </span>
              </span>
              <SessionPill session={detail.overview.session} />
              <span className="font-mono">{formatAge(event.news_age_minutes)}</span>
              {detail.overview.source ? (
                <SourceBadge
                  name={detail.overview.source.name}
                  tier={detail.overview.source.tier}
                  qualityLabel={detail.overview.source.quality_label}
                />
              ) : null}
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2">
            <ImpactBadge score={event.impact.score} band={event.impact.band} />
            <PriceCell
              price={event.price.last}
              changePct={event.price.change_pct_since_publication}
              label={COPY.eventCard.sincePublication}
            />
          </div>
        </div>
      </Panel>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <SectionPanel title={COPY.detail.whatHappened}>
          <p className="text-sm leading-relaxed text-ink">{detail.what_happened}</p>
        </SectionPanel>

        <SectionPanel title={COPY.detail.whyItMatters}>
          <p className="text-sm leading-relaxed text-muted">{detail.why_it_matters}</p>
        </SectionPanel>

        <SectionPanel title={COPY.detail.expectationVsActual}>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted">Metric</div>
              <div className="mt-1 space-y-1 text-xs text-ink">
                <div>EPS</div>
                <div>Revenue</div>
                <div>Guidance</div>
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted">{COPY.detail.expected}</div>
              <div className="mt-1 space-y-1 font-mono text-xs text-muted">
                <div>{formatPrice(detail.expectation_vs_actual.expected.eps)}</div>
                <div>{formatPrice(detail.expectation_vs_actual.expected.revenue, 0)}</div>
                <div>{formatPrice(detail.expectation_vs_actual.expected.guidance)}</div>
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted">{COPY.detail.actual}</div>
              <div className="mt-1 space-y-1 font-mono text-xs text-ink">
                <div>{formatPrice(detail.expectation_vs_actual.actual.eps)}</div>
                <div>{formatPrice(detail.expectation_vs_actual.actual.revenue, 0)}</div>
                <div>{formatPrice(detail.expectation_vs_actual.actual.guidance)}</div>
              </div>
            </div>
          </div>
          <div className="mt-3 space-y-1">
            <Row label="EPS surprise" value={formatPercent(detail.expectation_vs_actual.eps_surprise_pct)} />
            <Row label="Revenue surprise" value={formatPercent(detail.expectation_vs_actual.revenue_surprise_pct)} />
            <Row label="Guidance surprise" value={formatPercent(detail.expectation_vs_actual.guidance_surprise_pct)} />
          </div>
          <p className="mt-2 text-[11px] text-muted">{detail.expectation_vs_actual.note}</p>
        </SectionPanel>

        <SectionPanel title={COPY.detail.priceReaction}>
          <div className="space-y-0">
            <Row label={COPY.detail.atPublication} value={formatPrice(reaction.at_publication)} />
            <Row label="1 minute" value={formatPercent(reaction.reaction_1m)} tone={MOVEMENT_TEXT[movementTone(reaction.reaction_1m)]} />
            <Row label="5 minutes" value={formatPercent(reaction.reaction_5m)} tone={MOVEMENT_TEXT[movementTone(reaction.reaction_5m)]} />
            <Row label="15 minutes" value={formatPercent(reaction.reaction_15m)} tone={MOVEMENT_TEXT[movementTone(reaction.reaction_15m)]} />
            <Row label="30 minutes" value={formatPercent(reaction.reaction_30m)} tone={MOVEMENT_TEXT[movementTone(reaction.reaction_30m)]} />
            <Row label="60 minutes" value={formatPercent(reaction.reaction_60m)} tone={MOVEMENT_TEXT[movementTone(reaction.reaction_60m)]} />
            <Row label={COPY.detail.daily} value={formatPercent(reaction.reaction_daily)} tone={MOVEMENT_TEXT[movementTone(reaction.reaction_daily)]} />
            <Row label={COPY.detail.peak} value={formatPercent(reaction.peak_60m)} tone={MOVEMENT_TEXT[movementTone(reaction.peak_60m)]} />
            <Row label={COPY.detail.trough} value={formatPercent(reaction.trough_60m)} tone={MOVEMENT_TEXT[movementTone(reaction.trough_60m)]} />
            <Row label={COPY.detail.volume} value={formatNumberCompact(reaction.volume)} />
            <Row label={COPY.detail.rvol} value={formatRvol(reaction.rvol)} />
            <Row label={COPY.detail.vwap} value={formatPrice(reaction.vwap)} />
            <Row label={COPY.detail.atr} value={formatPercent(reaction.atr_pct)} />
            <Row label={COPY.detail.gap} value={formatPercent(reaction.gap_pct)} tone={MOVEMENT_TEXT[movementTone(reaction.gap_pct)]} />
          </div>
        </SectionPanel>

        <SectionPanel title={COPY.detail.volumeReaction}>
          <Row label={COPY.detail.cumulative} value={formatNumberCompact(detail.volume_reaction.cumulative)} />
          <Row label={COPY.detail.expectedToDate} value={formatNumberCompact(detail.volume_reaction.expected_to_date)} />
          <Row label={COPY.detail.rvol} value={formatRvol(detail.volume_reaction.rvol)} />
          <Row label={COPY.detail.profile} value={detail.volume_reaction.profile} />
        </SectionPanel>

        <SectionPanel title={COPY.detail.sectorReaction}>
          <Row label={COPY.detail.sectorEtf} value={detail.sector_reaction.sector_etf ?? "—"} />
          <Row
            label={COPY.detail.etfChange}
            value={formatPercent(detail.sector_reaction.etf_change_pct)}
            tone={MOVEMENT_TEXT[movementTone(detail.sector_reaction.etf_change_pct)]}
          />
          <Row label={COPY.detail.stockVsEtf} value={formatSignedPp(detail.sector_reaction.stock_vs_etf_pp)} />
          <div className="mt-3">
            <div className="text-[10px] uppercase tracking-wide text-muted">{COPY.detail.peers}</div>
            {detail.sector_reaction.peers.length === 0 ? (
              <p className="mt-1 text-xs text-muted">No peers recorded.</p>
            ) : (
              <ul className="mt-1 space-y-1">
                {detail.sector_reaction.peers.map((peer) => (
                  <li key={peer.ticker} className="flex items-center justify-between text-xs">
                    <span className="font-mono text-ink">{peer.ticker}</span>
                    <span className={`font-mono ${MOVEMENT_TEXT[movementTone(peer.change_pct)]}`}>
                      {formatPercent(peer.change_pct)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </SectionPanel>

        <SectionPanel title={COPY.detail.relatedStocks}>
          {detail.related_stocks.length === 0 ? (
            <p className="text-xs text-muted">No related stocks recorded.</p>
          ) : (
            <ul className="space-y-1">
              {detail.related_stocks.map((stock) => (
                <li key={stock.ticker} className="flex items-center justify-between gap-2 text-xs">
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-ink">{stock.ticker}</span>
                    <span className="border border-hairline px-1 text-[10px] uppercase tracking-wide text-muted">
                      {stock.is_direct ? COPY.detail.direct : COPY.detail.correlated}
                    </span>
                    <span className="text-[10px] text-muted">{stock.relation}</span>
                  </span>
                  <span className={`font-mono ${MOVEMENT_TEXT[movementTone(stock.change_pct)]}`}>
                    {formatPercent(stock.change_pct)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SectionPanel>

        <SectionPanel title={COPY.detail.technicalContext}>
          <div className="grid grid-cols-2 gap-x-4">
            <Row label="VWAP" value={formatPrice(detail.technical.vwap)} />
            <Row label="SMA20" value={formatPrice(detail.technical.sma20)} />
            <Row label="SMA50" value={formatPrice(detail.technical.sma50)} />
            <Row label="EMA9" value={formatPrice(detail.technical.ema9)} />
            <Row label="ATR14" value={formatPrice(detail.technical.atr14)} />
            <Row label="RSI14" value={formatPrice(detail.technical.rsi14)} />
            <Row label="Prev day high" value={formatPrice(detail.technical.prev_day_high)} />
            <Row label="Prev day low" value={formatPrice(detail.technical.prev_day_low)} />
            <Row label="Day high" value={formatPrice(detail.technical.day_high)} />
            <Row label="Day low" value={formatPrice(detail.technical.day_low)} />
            <Row label="From 52w high" value={formatPercent(detail.technical.dist_from_52w_high_pct)} />
            <Row label="Gap" value={formatPercent(detail.technical.gap_pct)} />
          </div>
          <div className="mt-3 flex flex-wrap gap-1">
            {detail.technical.conditions.length === 0 ? (
              <span className="text-xs text-muted">{COPY.detail.noConditions}</span>
            ) : (
              detail.technical.conditions.map((condition) => (
                <span
                  key={condition}
                  className="border border-hairline px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-accent"
                >
                  {condition.replaceAll("_", " ")}
                </span>
              ))
            )}
          </div>
        </SectionPanel>

        <SectionPanel title={COPY.detail.macroContext}>
          <RegimeChip regime={detail.regime} showDescription />
          <div className="mt-3">
            <MacroTable macro={detail.macro} />
          </div>
        </SectionPanel>

        <SectionPanel title={COPY.detail.optionsContext}>
          {detail.options ? (
            <div className="space-y-0">
              <Row label={COPY.detail.iv} value={formatPercent(detail.options.implied_volatility)} />
              <Row label={COPY.detail.ivChange} value={formatPercent(detail.options.iv_change)} />
              <Row label={COPY.detail.putCall} value={formatPrice(detail.options.put_call_ratio, 2)} />
              <Row
                label={COPY.detail.unusual}
                value={detail.options.unusual_activity ? "flagged" : "none"}
                tone={detail.options.unusual_activity ? "text-accent" : "text-ink"}
              />
            </div>
          ) : (
            <p className="text-xs text-muted">{COPY.detail.optionsUnavailable}</p>
          )}
        </SectionPanel>

        <SectionPanel title={COPY.detail.timeline}>
          <Timeline items={detail.timeline} />
        </SectionPanel>

        <SectionPanel title={COPY.detail.sources}>
          <SourceList sources={detail.sources} />
        </SectionPanel>

        <SectionPanel title={COPY.detail.impactBreakdown}>
          <ImpactBreakdown
            components={detail.impact_breakdown}
            algorithmVersion={event.impact.algorithm_version}
          />
        </SectionPanel>
      </div>

      <SectionPanel title={COPY.detail.intraday}>
        <IntradayChart
          bars={detail.intraday.bars}
          markers={detail.intraday.markers}
          ticker={event.ticker}
          height={420}
        />
      </SectionPanel>
    </div>
  );
}
