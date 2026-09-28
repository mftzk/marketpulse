import { WatchlistsView } from "@/components/WatchlistsView";
import { safeCall } from "@/lib/safe";
import { listWatchlists } from "@/lib/services/watchlists";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function WatchlistsPage() {
  const lists = await safeCall("watchlists.page", () => listWatchlists(), []);
  return <WatchlistsView initialLists={lists} />;
}
