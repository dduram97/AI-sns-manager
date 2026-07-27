/** Neighbor manage tab view types — safe for client `import type`. */

import type { Person, RelationshipState, Workflow } from "@/workers/types";
import type { NeighborRelationStatus } from "@/domain/neighbor/relationStatus";

export type NeighborManageFilter = "all" | "neglected" | "recent_post";

export type NeighborManageRecommendedAction =
  | "새글 확인"
  | "방문 권장"
  | "댓글 확인"
  | null;

/** Daily care queue status (KST day). */
export type NeighborCareStatus =
  | "todo"
  | "in_progress"
  | "done_today"
  | "snoozed_today";

export type NeighborCareActionType = "visit" | "like" | "comment";

/** Executed visit/like/comment from action_jobs (ops history). */
export type NeighborCareActionRecord = {
  id: string;
  actionType: NeighborCareActionType;
  label: string;
  executedAt: string | null;
};

export type NeighborManageListItem = {
  personId: string;
  displayName: string;
  blogName: string | null;
  nickname: string | null;
  blogUrl: string | null;
  relationStatus: NeighborRelationStatus;
  stage: string;
  temperature: number;
  score: number;
  lastVisitAt: string | null;
  lastLikeAt: string | null;
  lastCommentAt: string | null;
  lastTouchAt: string | null;
  lastPostAt: string | null;
  lastPostTitle: string | null;
  recentActivityLabel: string;
  recentActivityAt: string | null;
  /** Days since last visit; null if no timestamp. */
  daysSinceVisit: number | null;
  daysSinceLike: number | null;
  daysSinceComment: number | null;
  daysSinceTouch: number | null;
  daysSincePost: number | null;
  /** Visit missing or ≥7 days. */
  needsVisit: boolean;
  /** last_post_at within last 7 days. */
  hasRecentPost: boolean;
  /** Rule-based priority for "오늘 돌볼 이웃". */
  carePriorityScore: number;
  recommendedAction: NeighborManageRecommendedAction;
  /**
   * Open neighbor_feed Approval for this person (if any).
   * Enables deep link into feed inbox without creating new jobs.
   */
  openFeedApprovalId: string | null;
  openFeedPostTitle: string | null;
  /** Today's care processing status. */
  careStatus: NeighborCareStatus;
  /** What happened today (방문/공감/댓글/수동완료). */
  careDoneLabels: string[];
  /** Manual complete marker (discover_meta.neighbor_care_done_on, KST YMD). */
  careDoneOn: string | null;
  /** Latest today care completion / action time (ISO), if known. */
  careDoneAt: string | null;
  /** Snooze marker (discover_meta.neighbor_care_snooze_on, KST YMD). */
  careSnoozeOn: string | null;
};

/** Today's executed visit/like/comment counts (action_jobs, KST day). */
export type NeighborManageTodayActions = {
  visit: number;
  like: number;
  comment: number;
};

/** Highlight neighbor for weekly ops report. */
export type NeighborManageWeeklyHighlight = {
  personId: string;
  name: string;
  /** e.g. "방금 전 관리" / "이번 주 5회 교류" */
  detail: string;
};

export type NeighborManageWeeklyNeglected = {
  personId: string;
  name: string;
  daysSinceTouch: number | null;
};

/** KST last-7-day ops summary (action_jobs + relationship). */
export type NeighborManageWeeklyReport = {
  neighborCount: number;
  visit: number;
  like: number;
  comment: number;
  recentOrActive: NeighborManageWeeklyHighlight | null;
  neglected: NeighborManageWeeklyNeglected | null;
};

export type NeighborManageListPayload = {
  items: NeighborManageListItem[];
  todayActions: NeighborManageTodayActions;
  weeklyReport: NeighborManageWeeklyReport;
};

export type NeighborManageDetailView = {
  person: Person;
  relationship: RelationshipState;
  activeWorkflow: Workflow | null;
  openApprovalCount: number;
  blogName: string | null;
  nickname: string | null;
  blogUrl: string | null;
  relationStatus: NeighborRelationStatus;
  lastPostAt: string | null;
  lastPostTitle: string | null;
  /** Recent executed visit/like/comment jobs. */
  recentCareActions: NeighborCareActionRecord[];
  /** Relationship stage changes only (no decision/workflow CRM). */
  relationChanges: Array<{
    id: string;
    summary: string;
    createdAt: string;
  }>;
};
