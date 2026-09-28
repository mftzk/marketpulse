"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

export interface RefresherProps {
  intervalMs?: number;
}

/**
 * Headless polling wrapper for server-rendered pages: periodically calls
 * `router.refresh()` so server components re-read the database. Renders
 * nothing. Failures are swallowed (the page keeps its last good data).
 */
export function Refresher({ intervalMs = 15_000 }: RefresherProps) {
  const router = useRouter();

  useEffect(() => {
    const timer = setInterval(() => {
      router.refresh();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [router, intervalMs]);

  return null;
}
