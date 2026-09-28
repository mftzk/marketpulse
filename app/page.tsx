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

const EMPTY_PAGE: ListPage = {
  limit: 30,
  offset: 0,
  next_offset: null,
  has_more: false,
  total: 0,
};

export default async function DashboardPage() {
  const events = await safeCall(
    "dashboard.events",
    () => listEvents({ limit: 30, offset: 0, sort: "impact_desc" }),
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
