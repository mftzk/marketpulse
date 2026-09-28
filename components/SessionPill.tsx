import { MARKET_SESSION_LABELS, type MarketSession } from "@/lib/core/session";

export interface SessionPillProps {
  session: MarketSession | null;
}

/** Compact session label (pre-market / regular / after-hours / closed). */
export function SessionPill({ session }: SessionPillProps) {
  const label = session ? MARKET_SESSION_LABELS[session] : "—";
  const live = session === "regular" || session === "pre_market" || session === "after_hours";
  return (
    <span className="inline-flex items-center gap-1.5 border border-hairline px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
      <span
        className={`inline-block h-1.5 w-1.5 rounded-full ${live ? "bg-accent" : "bg-hairline"}`}
        aria-hidden="true"
      />
      {label}
    </span>
  );
}
