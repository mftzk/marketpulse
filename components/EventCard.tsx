import type { EventCardDTO } from "@/lib/core/dto";
import { COPY } from "@/lib/copy";
import { formatAge, formatPercent, formatPrice, formatRvol, formatScore } from "@/lib/format";

import { CatalystPill } from "./CatalystPill";
import { ImpactBadge } from "./ImpactBadge";
import { MOVEMENT_TEXT, movementTone } from "./movement";
import { ScoreBar } from "./ScoreBar";
import { SessionPill } from "./SessionPill";
import { SourceBadge } from "./SourceBadge";

export interface EventCardProps {
  event: EventCardDTO;
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className="text-[10px] uppercase tracking-wide text-muted">{label}</span>
      <span className={`font-mono text-[11px] ${tone ?? "text-ink"}`}>{value}</span>
    </span>
  );
}

/** Ranked event card. Every field is derived from the frozen EventCardDTO. */
export function EventCard({ event }: EventCardProps) {
  const moveTone = movementTone(event.price.change_pct_since_publication);
  const sectorEtf = event.market.sector_etf;

  return (
    <article className="border border-hairline bg-panel transition-colors hover:border-accent/40">
      <a href={`/events/${event.id}`} className="block p-3">
        <header className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm font-semibold text-ink">
                {event.ticker ?? "—"}
              </span>
              {event.company_name ? (
                <span className="truncate text-xs text-muted">{event.company_name}</span>
              ) : null}
              {event.sector ? (
                <span className="border border-hairline px-1 text-[10px] uppercase tracking-wide text-muted">
                  {event.sector}
                </span>
              ) : null}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted">
              <span className="text-ink">{event.event_type_label}</span>
              <CatalystPill direction={event.catalyst_direction} />
              <span>
                {COPY.eventCard.sentiment}{" "}
                <span className="font-mono text-ink">
                  {event.sentiment >= 0 ? "+" : ""}
                  {event.sentiment.toFixed(2)}
                </span>
              </span>
              <span>
                {COPY.eventCard.relevance}{" "}
                <span className="font-mono text-ink">{event.relevance_score.toFixed(2)}</span>
              </span>
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <ImpactBadge score={event.impact.score} band={event.impact.band} size="sm" />
            <span className="font-mono text-[10px] text-muted">
              {formatAge(event.news_age_minutes)}
            </span>
          </div>
        </header>

        <h3 className="mt-2 text-sm leading-snug text-ink">{event.headline}</h3>
        {event.summary ? (
          <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-muted">{event.summary}</p>
        ) : null}

        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="inline-flex items-baseline gap-1.5">
            <span className="text-[10px] uppercase tracking-wide text-muted">Price</span>
            <span className="font-mono text-sm text-ink">{formatPrice(event.price.last)}</span>
            <span className={`font-mono text-[11px] ${MOVEMENT_TEXT[moveTone]}`}>
              {formatPercent(event.price.change_pct_since_publication)}
              <span className="ml-1 text-muted">{COPY.eventCard.sincePublication}</span>
            </span>
          </span>
          <SessionPill session={event.price.session} />
          <Metric label="RVOL" value={formatRvol(event.price.rvol)} tone={event.price.rvol !== null && event.price.rvol >= 2 ? "text-accent" : "text-ink"} />
          {sectorEtf ? (
            <span className="inline-flex items-baseline gap-1">
              <span className="font-mono text-[10px] text-muted">{sectorEtf.symbol}</span>
              <span className={`font-mono text-[11px] ${MOVEMENT_TEXT[movementTone(sectorEtf.change_pct)]}`}>
                {formatPercent(sectorEtf.change_pct)}
              </span>
            </span>
          ) : null}
          {event.market.sp500_change_pct !== null ? (
            <span className="inline-flex items-baseline gap-1">
              <span className="font-mono text-[10px] text-muted">SPY</span>
              <span className={`font-mono text-[11px] ${MOVEMENT_TEXT[movementTone(event.market.sp500_change_pct)]}`}>
                {formatPercent(event.market.sp500_change_pct)}
              </span>
            </span>
          ) : null}
          {event.market.nasdaq_change_pct !== null ? (
            <span className="inline-flex items-baseline gap-1">
              <span className="font-mono text-[10px] text-muted">QQQ</span>
              <span className={`font-mono text-[11px] ${MOVEMENT_TEXT[movementTone(event.market.nasdaq_change_pct)]}`}>
                {formatPercent(event.market.nasdaq_change_pct)}
              </span>
            </span>
          ) : null}
          <div className="inline-flex items-center gap-1.5">
            <span className="text-[10px] uppercase tracking-wide text-muted">Impact</span>
            <span className="font-mono text-[11px] text-ink">{formatScore(event.impact.score)}</span>
            <span className="inline-block w-12 align-middle">
              <ScoreBar value={event.impact.score / 100} />
            </span>
          </div>
        </div>

        <p className="mt-2 text-xs leading-relaxed text-muted">{event.interpretation}</p>

        <footer className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-hairline pt-2">
          <SourceBadge
            name={event.source.name}
            tier={event.source.tier}
            qualityLabel={event.source.quality_label}
          />
          <span className="font-mono text-[10px] text-muted">
            {event.article_count} {COPY.eventCard.articles}
            {" · "}
            {event.published_at.slice(11, 16)} UTC
          </span>
        </footer>
      </a>
    </article>
  );
}
