import { AlertsView } from "@/components/AlertsView";
import { safeCall } from "@/lib/safe";
import { listAlerts } from "@/lib/services/alerts";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function AlertsPage() {
  const alerts = await safeCall("alerts.page", () => listAlerts(), { rules: [], events: [] });
  return <AlertsView initialRules={alerts.rules} initialEvents={alerts.events} />;
}
