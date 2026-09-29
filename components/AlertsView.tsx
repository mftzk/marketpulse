"use client";

import { useEffect, useState } from "react";

import { CATALYST_DIRECTIONS, CATALYST_DIRECTION_LABELS } from "@/lib/core/catalyst";
import type { AlertEventDTO, AlertRuleDTO } from "@/lib/core/detail";
import { EVENT_TYPES, EVENT_TYPE_LABELS } from "@/lib/core/event-types";
import { COPY } from "@/lib/copy";
import { formatAge } from "@/lib/format";
import { formatClockEt, formatDate } from "@/lib/format";

import { Panel } from "./Panel";

export interface AlertsViewProps {
  initialRules: AlertRuleDTO[];
  initialEvents: AlertEventDTO[];
}

const CHANNELS = ["log", "webhook", "telegram", "discord", "slack", "email"] as const;
const DIRECTIONS = CATALYST_DIRECTIONS;
const CHANGE_MODES = ["up", "down", "absolute"] as const;

function matchedConditionLabel(key: string): string {
  const labels: Record<string, string> = {
    impact_score_gte: "event impact ≥",
    impact_score_lte: "event impact ≤",
    news_age_minutes_lt: "news age <",
    rvol_gte: "relative volume ≥",
    change_pct_gte: "price rise since publication ≥",
    change_pct_lte: "price fall since publication ≥",
    change_pct_abs_gte: "absolute price move since publication ≥",
    tickers: "ticker",
    event_types: "event type",
    catalyst_direction: "catalyst direction",
    sectors: "sector",
  };
  return labels[key] ?? key;
}

const inputClass =
  "w-full border border-hairline bg-panel-alt px-2 py-1 text-xs text-ink outline-none focus:border-accent";

function summarize(conditions: Record<string, unknown>): string {
  const parts: string[] = [];
  const num = (key: string) => (typeof conditions[key] === "number" ? (conditions[key] as number) : null);
  if (num("impact_score_gte") !== null) parts.push(`event impact at least ${num("impact_score_gte")}`);
  if (num("impact_score_lte") !== null) parts.push(`event impact at most ${num("impact_score_lte")}`);
  if (num("news_age_minutes_lt") !== null) parts.push(`news younger than ${num("news_age_minutes_lt")} minutes`);
  if (num("rvol_gte") !== null) parts.push(`relative volume at least ${num("rvol_gte")}×`);
  if (num("change_pct_gte") !== null) parts.push(`price change since publication at least +${num("change_pct_gte")}%`);
  if (num("change_pct_lte") !== null) parts.push(`price change since publication at most ${num("change_pct_lte")}%`);
  if (num("change_pct_abs_gte") !== null) parts.push(`absolute price move since publication at least ${num("change_pct_abs_gte")}%`);
  const list = (key: string) => (Array.isArray(conditions[key]) ? (conditions[key] as string[]) : []);
  if (list("tickers").length) parts.push(`tickers ${list("tickers").join(", ")}`);
  if (list("event_types").length) parts.push(`types ${list("event_types").join(", ")}`);
  if (list("catalyst_direction").length) parts.push(`direction ${list("catalyst_direction").join(", ")}`);
  if (list("sectors").length) parts.push(`sectors ${list("sectors").join(", ")}`);
  return parts.join(" · ") || COPY.alerts.conditionSummaryEmpty;
}

export function AlertsView({ initialRules, initialEvents }: AlertsViewProps) {
  const [rules, setRules] = useState<AlertRuleDTO[]>(initialRules);
  const [events] = useState<AlertEventDTO[]>(initialEvents);
  const [message, setMessage] = useState<string | null>(null);
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
  }, []);

  const [name, setName] = useState("");
  const [minImpact, setMinImpact] = useState("70");
  const [maxAge, setMaxAge] = useState("");
  const [minRvol, setMinRvol] = useState("");
  const [changePct, setChangePct] = useState("");
  const [changeMode, setChangeMode] = useState<(typeof CHANGE_MODES)[number]>("up");
  const [tickers, setTickers] = useState("");
  const [sectors, setSectors] = useState("");
  const [directions, setDirections] = useState<string[]>([]);
  const [eventTypes, setEventTypes] = useState<string[]>([]);
  const [channels, setChannels] = useState<string[]>(["log"]);
  const [cooldown, setCooldown] = useState("30");
  const [preview, setPreview] = useState<{ scanned: number; total_available: number; matches: { event_id: string; ticker: string | null; headline: string; impact_score: number | null; rvol: number | null; change_pct: number | null; matched: string[] }[] } | null>(null);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const currentPreviewKey = JSON.stringify(buildConditions());
  const previewIsCurrent = previewKey !== null && previewKey === currentPreviewKey;

  function toggle(list: string[], value: string, setter: (next: string[]) => void) {
    setter(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  }

  function buildConditions(): Record<string, unknown> | null {
    const conditions: Record<string, unknown> = {};
    const addNumber = (key: string, value: string) => {
      if (value.trim() !== "" && Number.isFinite(Number(value))) {
        conditions[key] = Number(value);
      }
    };
    addNumber("impact_score_gte", minImpact);
    addNumber("news_age_minutes_lt", maxAge);
    addNumber("rvol_gte", minRvol);
    const threshold = Number(changePct);
    if (changePct.trim() !== "" && Number.isFinite(threshold)) {
      if (changeMode === "up") conditions.change_pct_gte = Math.abs(threshold);
      if (changeMode === "down") conditions.change_pct_lte = -Math.abs(threshold);
      if (changeMode === "absolute") conditions.change_pct_abs_gte = Math.abs(threshold);
    }
    if (tickers.trim()) {
      conditions.tickers = tickers
        .split(",")
        .map((t) => t.trim().toUpperCase())
        .filter(Boolean);
    }
    if (sectors.trim()) {
      conditions.sectors = sectors
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
    if (directions.length) conditions.catalyst_direction = directions;
    if (eventTypes.length) conditions.event_types = eventTypes;
    return Object.keys(conditions).length > 0 ? conditions : null;
  }

  async function previewRule() {
    setMessage(null);
    const conditions = buildConditions();
    if (!conditions) { setMessage("Add at least one condition before previewing."); return; }
    const key = JSON.stringify(conditions);
    setPreviewLoading(true);
    try {
      const response = await fetch("/api/alerts/preview", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ conditions }),
      });
      const json = (await response.json()) as { data?: typeof preview; error?: string };
      if (!response.ok || !json.data) { setMessage(json.error ?? "Could not preview matching events."); return; }
      setPreview(json.data);
      setPreviewKey(key);
    } catch {
      setMessage("Could not preview matching events.");
    } finally {
      setPreviewLoading(false);
    }
  }

  async function createRule() {
    setMessage(null);
    if (!name.trim()) {
      setMessage("A rule name is required.");
      return;
    }
    const conditions = buildConditions();
    if (!conditions) {
      setMessage("At least one condition is required.");
      return;
    }
    if (previewKey !== JSON.stringify(conditions)) {
      setMessage("Preview the matching events after your latest rule change before saving.");
      return;
    }
    if (channels.length === 0) {
      setMessage("Select at least one channel.");
      return;
    }
    try {
      const response = await fetch("/api/alerts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          conditions,
          channels,
          cooldown_minutes: Number(cooldown) || 30,
        }),
      });
      const json = (await response.json()) as { data?: AlertRuleDTO; error?: string };
      if (!response.ok || !json.data) {
        setMessage(json.error ?? "Could not create rule");
        return;
      }
      setRules((prev) => [json.data as AlertRuleDTO, ...prev]);
      setName("");
    } catch {
      setMessage("Could not create rule");
    }
  }

  async function toggleEnabled(rule: AlertRuleDTO) {
    try {
      const response = await fetch(`/api/alerts/${rule.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !rule.enabled }),
      });
      const json = (await response.json()) as { data?: AlertRuleDTO; error?: string };
      if (!response.ok || !json.data) {
        setMessage(json.error ?? "Could not update rule");
        return;
      }
      setRules((prev) => prev.map((r) => (r.id === rule.id ? (json.data as AlertRuleDTO) : r)));
    } catch {
      setMessage("Could not update rule");
    }
  }

  async function deleteRule(rule: AlertRuleDTO) {
    try {
      const response = await fetch(`/api/alerts/${rule.id}`, { method: "DELETE" });
      if (response.ok || response.status === 204) {
        setRules((prev) => prev.filter((r) => r.id !== rule.id));
      } else {
        setMessage("Could not delete rule");
      }
    } catch {
      setMessage("Could not delete rule");
    }
  }

  return (
    <div className="space-y-3">
      <h1 className="text-sm text-ink">{COPY.alerts.title}</h1>
      {message ? <p className="text-[11px] text-accent">{message}</p> : null}

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Panel title={COPY.alerts.create}>
          <div className="space-y-3">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wide text-muted">{COPY.alerts.namePlaceholder}</span>
              <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
            </label>

            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-1">
                <span className="text-[10px] uppercase tracking-wide text-muted">{COPY.alerts.minImpact}</span>
                <input className={inputClass} value={minImpact} onChange={(e) => setMinImpact(e.target.value)} />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] uppercase tracking-wide text-muted">{COPY.alerts.maxAge}</span>
                <input className={inputClass} value={maxAge} onChange={(e) => setMaxAge(e.target.value)} />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] uppercase tracking-wide text-muted">{COPY.alerts.minRvol}</span>
                <input className={inputClass} value={minRvol} onChange={(e) => setMinRvol(e.target.value)} />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] uppercase tracking-wide text-muted">Price move since publication</span>
                <select className={inputClass} value={changeMode} onChange={(e) => setChangeMode(e.target.value as typeof changeMode)}>
                  <option value="up">Rise by at least</option>
                  <option value="down">Fall by at least</option>
                  <option value="absolute">Move either way by at least</option>
                </select>
                <input aria-label="Price move threshold percent" className={inputClass} value={changePct} onChange={(e) => setChangePct(e.target.value)} />
                <span className="text-[10px] text-muted">Up/down use signed change; “either way” uses absolute movement.</span>
              </label>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-1">
                <span className="text-[10px] uppercase tracking-wide text-muted">{COPY.alerts.tickers}</span>
                <input className={inputClass} value={tickers} onChange={(e) => setTickers(e.target.value.toUpperCase())} />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] uppercase tracking-wide text-muted">{COPY.alerts.sectors}</span>
                <input className={inputClass} value={sectors} onChange={(e) => setSectors(e.target.value)} />
              </label>
            </div>

            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted">{COPY.alerts.direction}</div>
              <div className="mt-1 flex flex-wrap gap-2">
                {DIRECTIONS.map((direction) => (
                  <label key={direction} className="flex items-center gap-1 text-[11px] text-muted">
                    <input
                      type="checkbox"
                      checked={directions.includes(direction)}
                      onChange={() => toggle(directions, direction, setDirections)}
                    />
                    {CATALYST_DIRECTION_LABELS[direction]}
                  </label>
                ))}
              </div>
            </div>

            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted">{COPY.alerts.eventTypes}</div>
              <div className="mt-1 grid max-h-40 grid-cols-2 gap-1 overflow-auto border border-hairline p-2">
                {EVENT_TYPES.map((type) => (
                  <label key={type} className="flex items-center gap-1 text-[11px] text-muted">
                    <input
                      type="checkbox"
                      checked={eventTypes.includes(type)}
                      onChange={() => toggle(eventTypes, type, setEventTypes)}
                    />
                    {EVENT_TYPE_LABELS[type]}
                  </label>
                ))}
              </div>
            </div>

            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted">{COPY.alerts.channels}</div>
              <div className="mt-1 flex flex-wrap gap-2">
                {CHANNELS.map((channel) => (
                  <label key={channel} className="flex items-center gap-1 text-[11px] text-muted">
                    <input
                      type="checkbox"
                      checked={channels.includes(channel)}
                      onChange={() => toggle(channels, channel, setChannels)}
                    />
                    {channel}
                  </label>
                ))}
              </div>
            </div>

            <label className="flex w-40 flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wide text-muted">{COPY.alerts.cooldown}</span>
              <input className={inputClass} value={cooldown} onChange={(e) => setCooldown(e.target.value)} />
            </label>

            <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void previewRule()}
              disabled={previewLoading}
              className="border border-hairline px-3 py-1 text-[11px] uppercase tracking-wide text-ink disabled:opacity-50"
            >
              {previewLoading ? "Previewing…" : "Preview matching events"}
            </button>
            <button
              type="button"
              onClick={() => void createRule()}
              className="border border-accent px-3 py-1 text-[11px] uppercase tracking-wide text-accent"
            >
              {COPY.alerts.create}
            </button>
            </div>
            {preview ? (
              <div className="border border-hairline bg-panel-alt p-2 text-[11px]" aria-live="polite">
                <div className="text-ink">{previewIsCurrent ? "Current preview" : "Preview is out of date — preview again after changing the rule."}: {preview.matches.length} matches in {preview.scanned} of {preview.total_available} available events.</div>
                {preview.matches.length === 0 ? <p className="mt-1 text-muted">No current events match this rule.</p> : (
                  <ul className="mt-1 max-h-40 space-y-1 overflow-auto">
                    {preview.matches.slice(0, 12).map((match) => (
                      <li key={match.event_id} className="truncate text-muted">
                        <span className="font-mono text-ink">{match.ticker ?? "Market"}</span> · {match.headline} · impact {match.impact_score === null ? "unavailable" : match.impact_score.toFixed(1)}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : null}
          </div>
        </Panel>

        <Panel title={COPY.alerts.rules}>
          {rules.length === 0 ? (
            <p className="text-xs text-muted">{COPY.alerts.empty}</p>
          ) : (
            <ul className="space-y-2">
              {rules.map((rule) => (
                <li key={rule.id} className="border border-hairline p-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-xs text-ink">{rule.name}</div>
                      <div className="mt-0.5 text-[11px] text-muted">{summarize(rule.conditions)}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void toggleEnabled(rule)}
                      className={`border px-2 py-0.5 text-[10px] uppercase tracking-wide ${
                        rule.enabled ? "border-accent text-accent" : "border-hairline text-muted"
                      }`}
                    >
                      {rule.enabled ? COPY.alerts.disable : COPY.alerts.enable}
                    </button>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted">
                    <span>channels: {rule.channels.join(", ") || "—"}</span>
                    <span>cooldown: {rule.cooldown_minutes}m</span>
                    <span>
                      {COPY.alerts.lastTriggered}:{" "}
                      {rule.last_triggered_at && now
                        ? formatAge(Math.max(0, (now.getTime() - new Date(rule.last_triggered_at).getTime()) / 60_000))
                        : COPY.alerts.never}
                    </span>
                    <span>
                      {rule.match_count} {COPY.alerts.matches}
                    </span>
                    <button
                      type="button"
                      onClick={() => void deleteRule(rule)}
                      className="border border-hairline px-1.5 py-0.5 uppercase hover:border-negative hover:text-negative"
                    >
                      {COPY.watchlists.delete}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel title={COPY.alerts.recent}>
        {events.length === 0 ? (
          <p className="text-xs text-muted">{COPY.alerts.emptyTriggers}</p>
        ) : (
          <div className="min-w-0 overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-hairline text-[10px] uppercase tracking-wide text-muted">
                  <th className="py-1.5 pr-3 font-medium">{COPY.alerts.triggeredAt}</th>
                  <th className="py-1.5 pr-3 font-medium">Alert</th>
                  <th className="py-1.5 pr-3 font-medium">{COPY.alerts.matchedConditions}</th>
                  <th className="py-1.5 pr-3 font-medium">{COPY.alerts.channels}</th>
                  <th className="py-1.5 font-medium">{COPY.alerts.status}</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id} className="border-b border-hairline last:border-0">
                    <td className="py-2 pr-3 font-mono text-muted">
                      {formatDate(event.triggered_at)} {formatClockEt(event.triggered_at)}
                    </td>
                    <td className="py-2 pr-3">
                      <a href={`/events/${event.event_id}`} className="text-ink hover:text-accent">
                        {event.title ?? "Alert"}
                      </a>
                      {event.material_reason ? <span className="mt-0.5 block text-[10px] text-muted">Why sent: {event.material_reason}</span> : null}
                    </td>
                    <td className="py-2 pr-3 text-muted">{event.matched_conditions.map(matchedConditionLabel).join(", ") || "—"}</td>
                    <td className="py-2 pr-3 text-muted">{event.delivered_channels.join(", ") || "—"}</td>
                    <td className="py-2">
                      <span className="border border-hairline px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                        {event.status}
                      </span>
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
