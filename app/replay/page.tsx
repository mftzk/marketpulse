import { ReplayView } from "@/components/ReplayView";
import type { ListPage } from "@/lib/core/dto";
import { safeCall } from "@/lib/safe";
import { listEvents } from "@/lib/services/events";
import { getReplay } from "@/lib/services/replay";
import type { ReplayView as ReplayData } from "@/lib/view-types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const EMPTY_PAGE: ListPage = {
  limit: 1,
  offset: 0,
  next_offset: null,
  has_more: false,
  total: 0,
};

export default async function ReplayPage() {
  const latest = await safeCall(
    "replay.latest",
    () => listEvents({ limit: 1, offset: 0, sort: "published_desc" }),
    { data: [], page: EMPTY_PAGE, hidden: 0 },
  );

  const detectedDate = latest.data[0]?.published_at
    ? latest.data[0].published_at.slice(0, 10)
    : null;
  const defaultDate = detectedDate ?? new Date().toISOString().slice(0, 10);

  const initialData = await safeCall<ReplayData>(
    "replay.page",
    () => getReplay(defaultDate) as unknown as Promise<ReplayData>,
    { date: defaultDate, session_windows: [], timeline: [], series: {} },
  );

  return <ReplayView initialDate={defaultDate} initialData={initialData} />;
}
