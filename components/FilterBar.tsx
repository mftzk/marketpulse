"use client";

import { CATALYST_DIRECTIONS, CATALYST_DIRECTION_LABELS } from "@/lib/core/catalyst";
import { EVENT_TYPES, EVENT_TYPE_LABELS } from "@/lib/core/event-types";
import type { DashboardFilters } from "@/lib/view-types";

export interface FilterBarProps {
  value: DashboardFilters;
  onChange: (next: DashboardFilters) => void;
  sectors: { slug: string; name: string }[];
  resultCount?: number;
}

const inputClass =
  "w-full border border-hairline bg-panel-alt px-2 py-1 font-mono text-xs text-ink outline-none focus:border-accent";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wide text-muted">{label}</span>
      {children}
    </label>
  );
}

export function FilterBar({ value, onChange, sectors, resultCount }: FilterBarProps) {
  function update<K extends keyof DashboardFilters>(key: K, next: DashboardFilters[K]) {
    onChange({ ...value, [key]: next });
  }

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
        <Field label="Ticker">
          <input
            className={inputClass}
            value={value.ticker}
            placeholder="NVDA"
            onChange={(e) => update("ticker", e.target.value.toUpperCase())}
          />
        </Field>
        <Field label="Sector">
          <select
            className={inputClass}
            value={value.sector}
            onChange={(e) => update("sector", e.target.value)}
          >
            <option value="">All sectors</option>
            {sectors.map((sector) => (
              <option key={sector.slug} value={sector.slug}>
                {sector.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Event type">
          <select
            className={inputClass}
            value={value.event_type}
            onChange={(e) => update("event_type", e.target.value)}
          >
            <option value="">All types</option>
            {EVENT_TYPES.map((type) => (
              <option key={type} value={type}>
                {EVENT_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Catalyst">
          <select
            className={inputClass}
            value={value.catalyst_direction}
            onChange={(e) => update("catalyst_direction", e.target.value)}
          >
            <option value="">Any direction</option>
            {CATALYST_DIRECTIONS.map((direction) => (
              <option key={direction} value={direction}>
                {CATALYST_DIRECTION_LABELS[direction]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Min impact">
          <select
            className={inputClass}
            value={value.min_impact}
            onChange={(e) => update("min_impact", e.target.value)}
          >
            <option value="">Any score</option>
            {[20, 40, 60, 80].map((score) => (
              <option key={score} value={String(score)}>
                {score}+
              </option>
            ))}
          </select>
        </Field>
        <Field label="Max age">
          <select
            className={inputClass}
            value={value.max_age_minutes}
            onChange={(e) => update("max_age_minutes", e.target.value)}
          >
            <option value="">Any time</option>
            <option value="60">1 hour</option>
            <option value="240">4 hours</option>
            <option value="1440">24 hours</option>
            <option value="4320">3 days</option>
          </select>
        </Field>
      </div>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wide text-muted">Sort</span>
          <select
            className={inputClass}
            value={value.sort}
            onChange={(e) => update("sort", e.target.value as DashboardFilters["sort"])}
          >
            <option value="impact_desc">Impact (high to low)</option>
            <option value="impact_asc">Impact (low to high)</option>
            <option value="published_desc">Newest first</option>
          </select>
        </div>
        <div className="flex items-center gap-3">
          {typeof resultCount === "number" ? (
            <span className="font-mono text-[11px] text-muted">{resultCount} events</span>
          ) : null}
          <button
            type="button"
            onClick={() =>
              onChange({
                ticker: "",
                sector: "",
                event_type: "",
                catalyst_direction: "",
                min_impact: "",
                max_age_minutes: "",
                sort: "impact_desc",
              })
            }
            className="border border-hairline px-2 py-1 text-[11px] uppercase tracking-wide text-muted hover:border-accent hover:text-accent"
          >
            Reset
          </button>
        </div>
      </div>
    </div>
  );
}
