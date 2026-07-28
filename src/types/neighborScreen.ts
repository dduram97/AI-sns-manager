/** Neighbor screen view types — safe for client `import type`. */

import type { NeighborPolicy } from "@/domain/policy/neighborPolicy";
import type { NeighborRelationStatus } from "@/domain/neighbor/relationStatus";

export type NeighborExclusion = {
  blog_id: string;
  blog_name: string | null;
  blog_url: string | null;
  note: string | null;
  excluded_at: string;
};

export type NeighborCandidate = {
  personId: string;
  blogId: string;
  blogName: string;
  nickname: string;
  blogUrl: string | null;
  category: string;
  lastPostAt: string | null;
  lastActivityLabel: string;
  keywordMatchRate: number;
  adScore: number;
  recommendScore: number;
  recommendReasons: string[];
  hasOpenApproval: boolean;
  alreadyRequested: boolean;
};

export type NeighborSettingsView = NeighborPolicy & {
  daily_request_limit: number;
  /** Successful neighbor_request (status=executed) today */
  today_executed: number;
  /** Failed neighbor_request today — not counted toward quota used */
  today_failed: number;
  /** Soft-excluded (button missing / already neighbor) — not fail, not quota */
  today_excluded: number;
  today_remaining: number;
};

export type NeighborCompletedItem = {
  approvalId: string;
  personId: string;
  personName: string;
  blogId: string | null;
  blogUrl: string | null;
  resolvedAt: string;
  success: boolean;
  draftBody: string;
  relationStatus: NeighborRelationStatus;
  statusCheckedAt: string | null;
  errorMessage: string | null;
};

export type NeighborCompletedStatusFilter =
  | "accepted"
  | "requested"
  | "failed"
  | null;

export type NeighborCompletedPage = {
  items: NeighborCompletedItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  /** @deprecated use todayAcceptedCount + todayRequestedCount */
  successCount: number;
  todaySuccessCount: number;
  todayAcceptedCount: number;
  todayRequestedCount: number;
  todayFailedCount: number;
  rangeAcceptedCount: number;
  rangeRequestedCount: number;
  rangeFailedCount: number;
  rangeLabel: string;
  statusFilter: NeighborCompletedStatusFilter;
};
