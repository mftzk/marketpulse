"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { sessionFor } from "@/lib/core/session";
import { COPY } from "@/lib/copy";
import type { HealthView } from "@/lib/view-types";

import { SessionPill } from "./SessionPill";

const LINKS: { href: string; label: string }[] = [
  { href: "/", label: COPY.nav.dashboard },
  { href: "/watchlists", label: COPY.nav.watchlists },
  { href: "/alerts", label: COPY.nav.alerts },
  { href: "/macro", label: COPY.nav.macro },
  { href: "/replay", label: COPY.nav.replay },
  { href: "/about", label: COPY.nav.about },
];

export function NavBar() {
  const pathname = usePathname();
  const [now, setNow] = useState<Date | null>(null);
  const [health, setHealth] = useState<HealthView | null>(null);

  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const response = await fetch("/api/health", { cache: "no-store" });
        const json = (await response.json()) as HealthView;
        if (active) {
          setHealth(json);
        }
      } catch {
        // keep the last known state
      }
    }
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  const session = now ? sessionFor(now) : null;
  const clock = now
    ? new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      }).format(now)
    : "--:--:--";
  const dbOk = health?.database.ok ?? false;
  const dbKnown = health?.database.configured ?? false;

  return (
    <header className="sticky top-0 z-20 border-b border-hairline bg-page/95 backdrop-blur">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2">
        <Link href="/" className="flex items-baseline gap-2">
          <span className="font-mono text-sm font-semibold tracking-tight text-ink">
            {COPY.appName}
          </span>
          <span className="hidden text-[10px] uppercase tracking-[0.18em] text-muted sm:inline">
            {COPY.principle}
          </span>
        </Link>

        <nav className="flex flex-wrap items-center gap-1">
          {LINKS.map((link) => {
            const active = link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                className={`border px-2 py-1 text-xs ${
                  active
                    ? "border-accent text-accent"
                    : "border-transparent text-muted hover:border-hairline hover:text-ink"
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          <span className="font-mono text-xs text-muted">{clock} ET</span>
          <SessionPill session={session} />
          <span
            className="inline-flex items-center gap-1.5 text-[11px] text-muted"
            title={dbKnown ? `database ${health?.status ?? "unknown"}` : "database not configured"}
          >
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                dbOk ? "bg-accent" : dbKnown ? "bg-negative" : "bg-hairline"
              }`}
              aria-hidden="true"
            />
            {health?.status ?? "unknown"}
          </span>
        </div>
      </div>
    </header>
  );
}
