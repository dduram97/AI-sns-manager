import type { NeighborCompletedPage } from "@/types/neighborScreen";

/** Placeholder before deferred completed-tab data loads. */
export function emptyNeighborCompletedPage(): NeighborCompletedPage {
  return {
    items: [],
    total: 0,
    page: 1,
    pageSize: 15,
    totalPages: 0,
    successCount: 0,
    todaySuccessCount: 0,
    todayAcceptedCount: 0,
    todayRequestedCount: 0,
    todayFailedCount: 0,
    rangeAcceptedCount: 0,
    rangeRequestedCount: 0,
    rangeFailedCount: 0,
    rangeLabel: "최근 7일",
    statusFilter: null,
  };
}
