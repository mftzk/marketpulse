"use client";

import { useEffect, useMemo, useState } from "react";

import { TICKER_PATTERN } from "@/lib/core/filters";
import type { EventCardDTO, ListPage } from "@/lib/core/dto";
import type { AlertEventDTO, AlertRuleDTO, WatchlistDTO } from "@/lib/core/detail";
import { sessionFor } from "@/lib/core/session";
import { COPY } from "@/lib/copy";
import { formatAge, formatClockEt, formatPercent } from "@/lib/format";
import type {
  DashboardFilters,
  EventsEnvelope,
  HealthView,
  MacroValueView,
  MarketContextView,
} from "@/lib/view-types";

import { EmptyState } from "./EmptyState";
import { ErrorState } from "./ErrorState";
import { EventCard } from "./EventCard";
import { FilterBar } from "./FilterBar";
import { LoadingRows } from "./LoadingRows";
import { MacroStrip } from "./MacroStrip";
import { MacroTable } from "./MacroTable";
import { MOVEMENT_TEXT, movementTone } from "./movement";
import { Panel } from "./Panel";
import { RegimeChip } from "./RegimeChip";
import { SessionPill } from "./SessionPill";
import { WatchlistTable } from "./WatchlistTable";

export interface DashboardViewProps {
  initialEvents: EventCardDTO[];
  initialPage: ListPage;
  health: HealthView | null;
  context: MarketContextView | null;
  watchlists: WatchlistDTO[];
  alertRules: AlertRuleDTO[];
  alertEvents: AlertEventDTO[];
}

const EMPTY_FILTERS: DashboardFilters = {
  ticker: "",
  sector: "",
  event_type: "",
  catalyst_direction: "",
  min_impact: "",
  max_age_minutes: "",
  sort: "impact_desc",
};

function buildQuery(filters: DashboardFilters): string {
  const params = new URLSearchParams();
  const ticker = filters.ticker.trim().toUpperCase();
  if (ticker && TICKER_PATTERN.test(ticker)) {
    params.set("ticker", ticker);
  }
  if (filters.sector) params.set("sector", filters.sector);
  if (filters.event_type) params.set("event_type", filters.event_type);
  if (filters.catalyst_direction) params.set("catalyst_direction", filters.catalyst_direction);
  if (filters.min_impact) params.set("min_impact", filters.min_impact);
  if (filters.max_age_minutes) params.set("max_age_minutes", filters.max_age_minutes);
  params.set("sort", filters.sort);
  params.set("limit", "30");
  return params.toString();
}

function useClientNow(): Date | null {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

type MobileTab = "feed" | "context" | "alerts";

export function DashboardView({
  initialEvents,
  initialPage,
  health,
  context,
  watchlists,
  alertRules,
  alertEvents,
}: DashboardViewProps) {
  const now = useClientNow();
  const [filters, setFilters] = useState<DashboardFilters>(EMPTY_FILTERS);
  const [events, setEvents] = useState<EventCardDTO[]>(initialEvents);
  const [page, setPage] = useState<ListPage>(initialPage);
  const [loading, setLoading] = useState(initialEvents.length === 0);
  const [stale, setStale] = useState(false);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState<MobileTab>("feed");
  const [selectedListId, setSelectedListId] = useState<string | null>(
    watchlists[0]?.id ?? null,
  );
  const [liveContext, setLiveContext] = useState<MarketContextView | null>(context);
  const [liveHealth, setLiveHealth] = useState<HealthView | null>(health);

  const query = useMemo(() => buildQuery(filters), [filters]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    async function load() {
      try {
        const response = await fetch(`/api/events?${query}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`status ${response.status}`);
        }
        const json = (await response.json()) as EventsEnvelope;
        if (!active) return;
        setEvents(json.data);
        setPage(json.page);
        setStale(false);
        setFailed(false);
      } catch {
        if (!active) return;
        setStale(true);
        setFailed(true);
      } finally {
        if (active) setLoading(false);
      }
    }

    setLoading(true);
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => {
      active = false;
      clearInterval(timer);
      controller.abort();
    };
  }, [query]);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const [h, c] = await Promise.all([
          fetch("/api/health", { cache: "no-store" }).then((r) => r.json()),
          fetch("/api/market/context", { cache: "no-store" }).then((r) => r.json()),
        ]);
        if (!active) return;
        setLiveHealth(h as HealthView);
        setLiveContext((c as { data: MarketContextView }).data);
      } catch {
        // keep last good
      }
    }
    const timer = setInterval(() => void load(), 30_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  const selectedList =
    watchlists.find((w) => w.id === selectedListId) ?? watchlists[0] ?? null;
  const sectors = liveContext?.sectors ?? [];
  const macro: Record<string, MacroValueView> = liveContext?.macro ?? {};
  const session = now ? sessionFor(now) : null;
  const clock = now ? formatClockEt(now) : "--:--:--";
  const scheduler = liveHealth?.pipeline.scheduler;
  const pipelineTick = liveHealth?.pipeline.last_run_at;
  const dbOk = liveHealth?.database.ok;
  const healthDot = dbOk === undefined ? "bg-hairline" : dbOk ? "bg-accent" : "bg-negative";

  const header = (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border border-hairline bg-panel px-3 py-2">
      <span className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wide text-muted">{COPY.dashboard.session}</span>
        <SessionPill session={session} />
      </span>
      <span className="font-mono text-xs text-muted">{clock}</span>
      <span className="flex items-center gap-2 text-[11px] text-muted">
        <span className="text-[10px] uppercase tracking-wide">{COPY.dashboard.pipelineTick}</span>
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${healthDot}`} />
        <span>{pipelineTick ? formatClockEt(pipelineTick) : "—"}</span>
        {scheduler ? <span>· {scheduler.interval_seconds}s</span> : null}
      </span>
      <RegimeChip regime={liveContext?.regime ?? null} />
      <div className="ml-auto">
        <MacroStrip indices={liveContext?.indices ?? []} />
      </div>
    </div>
  );

  const feed = (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-sm text-ink">{COPY.dashboard.title}</h2>
          <p className="text-[11px] text-muted">{COPY.dashboard.subtitle}</p>
        </div>
        <div className="flex items-center gap-2">
          {stale ? (
            <span className="border border-hairline px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-accent">
              {COPY.common.stale}
            </span>
          ) : (
            <span className="text-[10px] uppercase tracking-wide text-muted">{COPY.common.live}</span>
          )}
          <span className="font-mono text-[11px] text-muted">{page.total} total</span>
        </div>
      </div>

      {loading && events.length === 0 ? (
        <LoadingRows rows={5} />
      ) : failed && events.length === 0 ? (
        <ErrorState />
      ) : events.length === 0 ? (
        <EmptyState title="No events match these filters." body="Try widening the filters or resetting them." />
      ) : (
        <div className="space-y-2">
          {events.map((event) => (
            <EventCard key={event.id} event={event} />
          ))}
        </div>
      )}
    </div>
  );

  const leftRail = (
    <div className="space-y-3">
      <Panel title={COPY.dashboard.watchlist}>
        {watchlists.length > 0 ? (
          <select
            className="w-full border border-hairline bg-panel-alt px-2 py-1 text-xs text-ink outline-none focus:border-accent"
            value={selectedList?.id ?? ""}
            onChange={(e) => setSelectedListId(e.target.value)}
          >
            {watchlists.map((list) => (
              <option key={list.id} value={list.id}>
                {list.name}
              </option>
            ))}
          </select>
        ) : (
          <p className="text-xs text-muted">No watchlists yet.</p>
        )}
      </Panel>

      <Panel title={COPY.dashboard.sectors}>
        <ul className="space-y-1">
          <li>
            <button
              type="button"
              onClick={() => setFilters((f) => ({ ...f, sector: "" }))}
              className={`w-full border px-2 py-1 text-left text-xs ${
                filters.sector === ""
                  ? "border-accent text-accent"
                  : "border-transparent text-muted hover:border-hairline hover:text-ink"
              }`}
            >
              All sectors
            </button>
          </li>
          {sectors.map((sector) => (
            <li key={sector.slug}>
              <button
                type="button"
                onClick={() => setFilters((f) => ({ ...f, sector: sector.slug }))}
                className={`flex w-full items-center justify-between border px-2 py-1 text-left text-xs ${
                  filters.sector === sector.slug
                    ? "border-accent text-accent"
                    : "border-transparent text-muted hover:border-hairline hover:text-ink"
                }`}
              >
                <span>{sector.name}</span>
                <span className={`font-mono ${MOVEMENT_TEXT[movementTone(sector.change_pct)]}`}>
                  {formatPercent(sector.change_pct)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title={COPY.dashboard.macro}>
        <MacroTable macro={macro} limit={5} />
      </Panel>
    </div>
  );

  const rightRail = (
    <div className="space-y-3">
      <Panel
        title={selectedList ? selectedList.name : COPY.dashboard.watchlist}
        action={
          <span className="font-mono text-[10px] text-muted">
            {selectedList ? `${selectedList.stocks.length} tickers` : ""}
          </span>
        }
      >
        {selectedList && selectedList.stocks.length > 0 ? (
          <WatchlistTable stocks={selectedList.stocks} />
        ) : (
          <p className="text-xs text-muted">No tickers in this watchlist.</p>
        )}
      </Panel>

      <Panel title={COPY.dashboard.alerts}>
        {alertEvents.length === 0 ? (
          <p className="text-xs text-muted">{COPY.alerts.emptyTriggers}</p>
        ) : (
          <ul className="space-y-2">
            {alertEvents.slice(0, 6).map((alert) => (
              <li key={alert.id} className="border-b border-hairline pb-2 last:border-0 last:pb-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs text-ink">{alert.title ?? "Alert"}</span>
                  <span className="font-mono text-[10px] text-muted">
                    {alert.triggered_at && now
                      ? formatAge(Math.max(0, (now.getTime() - new Date(alert.triggered_at).getTime()) / 60_000))
                      : "—"}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted">
                  <span className="uppercase tracking-wide">{alert.status}</span>
                  <span>{alert.delivered_channels.join(", ") || "no channel"}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Rules">
        <ul className="space-y-1">
          {alertRules.length === 0 ? (
            <li className="text-xs text-muted">{COPY.alerts.empty}</li>
          ) : (
            alertRules.map((rule) => (
              <li key={rule.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="truncate text-ink">{rule.name}</span>
                <span className="font-mono text-[10px] text-muted">{rule.match_count}×</span>
              </li>
            ))
          )}
        </ul>
      </Panel>
    </div>
  );

  return (
    <div className="space-y-3">
      {header}

      <Panel>
        <FilterBar
          value={filters}
          onChange={setFilters}
          sectors={sectors.map((s) => ({ slug: s.slug, name: s.name }))}
          resultCount={page.total}
        />
      </Panel>

      {/* Mobile tabs */}
      <div className="flex gap-1 xl:hidden">
        {(
          [
            ["feed", COPY.dashboard.title],
            ["context", COPY.dashboard.sectors],
            ["alerts", COPY.dashboard.alerts],
          ] as [MobileTab, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`border px-2 py-1 text-[11px] ${
              tab === key ? "border-accent text-accent" : "border-hairline text-muted"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="hidden gap-3 xl:grid xl:grid-cols-[280px_minmax(0,1fr)_320px]">
        {leftRail}
        <div className="min-w-0">{feed}</div>
        {rightRail}
      </div>

      <div className="space-y-3 xl:hidden">
        {tab === "feed" ? feed : null}
        {tab === "context" ? leftRail : null}
        {tab === "alerts" ? rightRail : null}
      </div>
    </div>
  );
}
