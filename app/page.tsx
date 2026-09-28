import { DashboardView } from "@/components/DashboardView";
import type { ListPage } from "@/lib/core/dto";
import { safeCall } from "@/lib/safe";
import { listAlerts } from "@/lib/services/alerts";
import { listEvents } from "@/lib/services/events";
import { getHealth } from "@/lib/services/health";
import { getMarketContext } from "@/lib/services/market-context";
import { listWatchlists } from "@/lib/services/watchlists";
import type { HealthView, MarketContextView } from "@/lib/view-types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// The SSR shell only needs the top of the feed; the client `Refresher` polls
// `/api/events?limit=30` for the full live list, so rendering 15 here keeps the
// server render cheap without changing what the user eventually sees.
const SSR_EVENT_LIMIT = 15;

const EMPTY_PAGE: ListPage = {
  limit: SSR_EVENT_LIMIT,
  offset: 0,
  next_offset: null,
  has_more: false,
  total: 0,
};

export default async function DashboardPage() {
  const events = await safeCall(
    "dashboard.events",
    () => listEvents({ limit: SSR_EVENT_LIMIT, offset: 0, sort: "impact_desc" }),
    { data: [], page: EMPTY_PAGE },
  );

  const health = await safeCall<HealthView | null>(
    "dashboard.health",
    () => getHealth() as unknown as Promise<HealthView>,
    null,
  );

  const context = await safeCall<MarketContextView | null>(
    "dashboard.context",
    () => getMarketContext() as unknown as Promise<MarketContextView>,
    null,
  );

  const watchlists = await safeCall("dashboard.watchlists", () => listWatchlists(), []);
  const alerts = await safeCall(
    "dashboard.alerts",
    () => listAlerts(),
    { rules: [], events: [] },
  );

  return (
    <DashboardView
      initialEvents={events.data}
      initialPage={events.page}
      health={health}
      context={context}
      watchlists={watchlists}
      alertRules={alerts.rules}
      alertEvents={alerts.events}
    />
  );
}
