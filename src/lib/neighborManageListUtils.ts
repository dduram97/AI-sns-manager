/** Client-safe neighbor manage list filter/sort/enrich (no Supabase / server deps). */

import type {
  NeighborCareStatus,
  NeighborManageFilter,
  NeighborManageListItem,
  NeighborManageRecommendedAction,
  NeighborManageWeeklyReport,
} from "@/types/neighborManage";

export type NeighborManageSort = "last_touch" | "temperature" | "last_post";

export type NeighborManageListItemBase = Omit<
  NeighborManageListItem,
  | "daysSinceVisit"
  | "daysSinceLike"
  | "daysSinceComment"
  | "daysSinceTouch"
  | "daysSincePost"
  | "needsVisit"
  | "hasRecentPost"
  | "carePriorityScore"
  | "recommendedAction"
  | "openFeedApprovalId"
  | "openFeedPostTitle"
  | "careStatus"
  | "careDoneLabels"
  | "careDoneOn"
  | "careDoneAt"
  | "careSnoozeOn"
>;

const VISIT_NEGLECT_DAYS = 7;
const LIKE_NEGLECT_DAYS = 7;
const COMMENT_NEGLECT_DAYS = 14;
const RECENT_POST_DAYS = 7;
/** Daily care queue size / progress goal. */
export const TODAY_CARE_GOAL = 5;
const TODAY_CARE_LIMIT = TODAY_CARE_GOAL;
/** First-screen "지금 할 일" cap (subset of today's care queue). */
export const NOW_TODO_LIMIT = 3;

export function daysSince(
  iso: string | null | undefined,
  now = Date.now(),
): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((now - t) / 86_400_000);
}

export function formatDaysAgoKo(days: number | null): string {
  if (days === null) return "기록 없음";
  if (days <= 0) return "오늘";
  if (days === 1) return "1일 전";
  return `${days}일 전`;
}

function computeCarePriorityScore(input: {
  daysSinceVisit: number | null;
  daysSinceLike: number | null;
  daysSinceComment: number | null;
  daysSincePost: number | null;
}): number {
  let score = 0;

  if (
    input.daysSinceVisit === null ||
    input.daysSinceVisit >= VISIT_NEGLECT_DAYS
  ) {
    score += 30;
    if (input.daysSinceVisit != null) {
      score += Math.min(input.daysSinceVisit, 30);
    } else {
      score += 30;
    }
  }

  if (
    input.daysSinceLike === null ||
    input.daysSinceLike >= LIKE_NEGLECT_DAYS
  ) {
    score += 20;
  }

  if (
    input.daysSinceComment === null ||
    input.daysSinceComment >= COMMENT_NEGLECT_DAYS
  ) {
    score += 25;
  }

  if (
    input.daysSincePost !== null &&
    input.daysSincePost <= RECENT_POST_DAYS
  ) {
    score += 40;
  }

  return score;
}

function computeRecommendedAction(input: {
  hasRecentPost: boolean;
  needsVisit: boolean;
  daysSinceComment: number | null;
}): NeighborManageRecommendedAction {
  if (input.hasRecentPost) return "새글 확인";
  if (input.needsVisit) return "방문 권장";
  if (
    input.daysSinceComment === null ||
    input.daysSinceComment >= COMMENT_NEGLECT_DAYS
  ) {
    return "댓글 확인";
  }
  return null;
}

export function resolveCareStatus(input: {
  careDoneOn: string | null;
  careSnoozeOn: string | null;
  todayYmd: string;
  careDoneLabels: string[];
  hasOpenFeedApproval: boolean;
}): NeighborCareStatus {
  if (input.careDoneOn === input.todayYmd) return "done_today";
  if (input.careDoneLabels.length > 0) return "done_today";
  if (input.careSnoozeOn === input.todayYmd) return "snoozed_today";
  if (input.hasOpenFeedApproval) return "in_progress";
  return "todo";
}

export function careStatusLabel(status: NeighborCareStatus): string {
  switch (status) {
    case "done_today":
      return "오늘 완료";
    case "snoozed_today":
      return "나중에";
    case "in_progress":
      return "처리 중";
    default:
      return "대기";
  }
}

/** Enrich list row with days-since signals and care priority (read-only). */
export function enrichNeighborManageItem(
  base: NeighborManageListItemBase,
  now = Date.now(),
): NeighborManageListItem {
  const daysSinceVisit = daysSince(base.lastVisitAt, now);
  const daysSinceLike = daysSince(base.lastLikeAt, now);
  const daysSinceComment = daysSince(base.lastCommentAt, now);
  const daysSinceTouch = daysSince(base.lastTouchAt, now);
  const daysSincePost = daysSince(base.lastPostAt, now);

  const needsVisit =
    daysSinceVisit === null || daysSinceVisit >= VISIT_NEGLECT_DAYS;
  const hasRecentPost =
    daysSincePost !== null && daysSincePost <= RECENT_POST_DAYS;

  return {
    ...base,
    daysSinceVisit,
    daysSinceLike,
    daysSinceComment,
    daysSinceTouch,
    daysSincePost,
    needsVisit,
    hasRecentPost,
    carePriorityScore: computeCarePriorityScore({
      daysSinceVisit,
      daysSinceLike,
      daysSinceComment,
      daysSincePost,
    }),
    recommendedAction: computeRecommendedAction({
      hasRecentPost,
      needsVisit,
      daysSinceComment,
    }),
    openFeedApprovalId: null,
    openFeedPostTitle: null,
    careStatus: "todo",
    careDoneLabels: [],
    careDoneOn: null,
    careDoneAt: null,
    careSnoozeOn: null,
  };
}

/**
 * Today's care queue: priority > 0 and not already done today.
 */
export function selectTodayCareNeighbors(
  items: NeighborManageListItem[],
  limit = TODAY_CARE_LIMIT,
): NeighborManageListItem[] {
  return [...items]
    .filter(
      (item) =>
        item.carePriorityScore > 0 &&
        item.careStatus !== "done_today" &&
        item.careStatus !== "snoozed_today",
    )
    .sort((a, b) => {
      if (b.carePriorityScore !== a.carePriorityScore) {
        return b.carePriorityScore - a.carePriorityScore;
      }
      const at = a.lastTouchAt ? new Date(a.lastTouchAt).getTime() : 0;
      const bt = b.lastTouchAt ? new Date(b.lastTouchAt).getTime() : 0;
      return at - bt;
    })
    .slice(0, limit);
}

/** Top incomplete care neighbors for the first-screen "지금 할 일" block. */
export function selectNowTodoNeighbors(
  items: NeighborManageListItem[],
  limit = NOW_TODO_LIMIT,
): NeighborManageListItem[] {
  return selectTodayCareNeighbors(items, limit);
}

/** Completed-today items that would have been in the care queue. */
export function selectTodayCareDoneNeighbors(
  items: NeighborManageListItem[],
): NeighborManageListItem[] {
  return [...items]
    .filter(
      (item) => item.carePriorityScore > 0 && item.careStatus === "done_today",
    )
    .sort((a, b) => {
      const at = a.careDoneAt
        ? new Date(a.careDoneAt).getTime()
        : a.lastTouchAt
          ? new Date(a.lastTouchAt).getTime()
          : 0;
      const bt = b.careDoneAt
        ? new Date(b.careDoneAt).getTime()
        : b.lastTouchAt
          ? new Date(b.lastTouchAt).getTime()
          : 0;
      return bt - at;
    });
}

/** Today's care progress vs fixed daily goal. */
export function getTodayCareProgress(items: NeighborManageListItem[]): {
  completed: number;
  goal: number;
  pending: number;
  percent: number;
} {
  const pending = selectTodayCareNeighbors(items).length;
  const completedRaw = selectTodayCareDoneNeighbors(items).length;
  const goal = TODAY_CARE_GOAL;
  const completed = Math.min(completedRaw, goal);
  const percent = Math.round((completed / goal) * 100);
  return { completed, goal, pending, percent };
}

/** Ops result summary for manage top card (no new tables). */
export function getTodayOpsSummary(
  items: NeighborManageListItem[],
  todayActions: { visit: number; like: number; comment: number },
): {
  completed: number;
  total: number;
  pending: number;
  visit: number;
  like: number;
  comment: number;
} {
  const pending = selectTodayCareNeighbors(items).length;
  const completed = selectTodayCareDoneNeighbors(items).length;
  return {
    completed,
    pending,
    total: completed + pending,
    visit: todayActions.visit,
    like: todayActions.like,
    comment: todayActions.comment,
  };
}

/** Pick the longest-untouched accepted neighbor (relationship timestamps). */
export function selectMostNeglectedNeighbor(
  items: NeighborManageListItem[],
): NeighborManageListItem | null {
  let best: NeighborManageListItem | null = null;
  for (const item of items) {
    if (!best) {
      best = item;
      continue;
    }
    const d = item.daysSinceTouch;
    const bd = best.daysSinceTouch;
    if (d === null && bd !== null) {
      best = item;
    } else if (d !== null && bd !== null && d > bd) {
      best = item;
    }
  }
  return best;
}

export function emptyNeighborWeeklyReport(): NeighborManageWeeklyReport {
  return {
    neighborCount: 0,
    visit: 0,
    like: 0,
    comment: 0,
    recentOrActive: null,
    neglected: null,
  };
}

/** Compact label for done cards, e.g. "방문 완료". */
export function formatCareDoneSummary(item: NeighborManageListItem): string {
  const actionLabels = item.careDoneLabels.filter((l) => l !== "수동 완료");
  if (actionLabels.length === 0) {
    return item.careDoneLabels.includes("수동 완료") ? "수동 완료" : "완료";
  }
  if (actionLabels.length === 1) return `${actionLabels[0]} 완료`;
  return `${actionLabels.join("·")} 완료`;
}

export function formatCareTimeKo(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  return new Date(iso).toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Care-card CTA visibility from P0 signals (no new scoring). */
export function getNeighborCareCtas(item: NeighborManageListItem): {
  showBlog: boolean;
  showLike: boolean;
  showComment: boolean;
} {
  if (
    item.careStatus === "done_today" ||
    item.careStatus === "snoozed_today"
  ) {
    return { showBlog: false, showLike: false, showComment: false };
  }
  const showLike = item.hasRecentPost;
  const showComment =
    item.hasRecentPost || item.recommendedAction === "댓글 확인";
  const showBlog = item.hasRecentPost || item.needsVisit;
  return { showBlog, showLike, showComment };
}

/**
 * Single top headline for now-todo cards (display priority only).
 * Reuses hasRecentPost / needsVisit / neglect day thresholds — no new scoring.
 */
export type CarePrimaryHeadline = {
  emoji: string;
  text: string;
};

export function getCarePrimaryHeadline(
  item: NeighborManageListItem,
): CarePrimaryHeadline | null {
  if (item.hasRecentPost) {
    if (item.daysSincePost != null) {
      return {
        emoji: "🔥",
        text: `새글 작성 ${formatDaysAgoKo(item.daysSincePost)} → 방문 추천`,
      };
    }
    return { emoji: "🔥", text: "새글이 올라와 방문 추천" };
  }

  if (item.needsVisit) {
    if (item.daysSinceVisit === null) {
      return { emoji: "⚠️", text: "방문 기록이 없는 이웃" };
    }
    return {
      emoji: "⚠️",
      text: `${item.daysSinceVisit}일 이상 방문하지 않은 이웃`,
    };
  }

  if (
    item.daysSinceComment === null ||
    item.daysSinceComment >= COMMENT_NEGLECT_DAYS ||
    item.recommendedAction === "댓글 확인"
  ) {
    return { emoji: "💬", text: "댓글 교류가 오래된 이웃" };
  }

  if (
    item.daysSinceLike === null ||
    item.daysSinceLike >= LIKE_NEGLECT_DAYS
  ) {
    return { emoji: "💛", text: "공감 교류가 오래된 이웃" };
  }

  const fallback = getCareReasonSentences(item)[0];
  if (fallback) return { emoji: "👉", text: fallback };
  return null;
}

/**
 * Factual "why today" lines for care cards (N일 전 / 기록 없음).
 * Max 4 — scannable, not a full CRM dump.
 */
export function getCareWhyTodayLines(item: NeighborManageListItem): string[] {
  const lines: string[] = [];

  if (item.daysSincePost != null) {
    lines.push(`새글 작성 ${formatDaysAgoKo(item.daysSincePost)}`);
  }

  if (item.daysSinceVisit === null) {
    lines.push("마지막 방문 기록 없음");
  } else if (item.needsVisit || item.daysSinceVisit > 0) {
    lines.push(`마지막 방문 ${formatDaysAgoKo(item.daysSinceVisit)}`);
  }

  if (item.daysSinceComment === null) {
    lines.push("마지막 댓글 기록 없음");
  } else if (
    item.daysSinceComment >= COMMENT_NEGLECT_DAYS ||
    item.recommendedAction === "댓글 확인"
  ) {
    lines.push(`마지막 댓글 ${formatDaysAgoKo(item.daysSinceComment)}`);
  }

  if (item.daysSinceTouch === null) {
    lines.push("최근 교류 없음");
  } else if (item.daysSinceTouch >= VISIT_NEGLECT_DAYS) {
    lines.push(`최근 교류 ${formatDaysAgoKo(item.daysSinceTouch)}`);
  }

  return lines.slice(0, 4);
}

/** Human-readable recommendation sentences for care cards (max 3). */
export function getCareReasonSentences(item: NeighborManageListItem): string[] {
  const reasons: string[] = [];

  if (item.hasRecentPost) {
    reasons.push("새 글이 올라와 방문 추천");
  }
  if (item.needsVisit) {
    if (item.daysSinceVisit === null) {
      reasons.push("방문 기록이 없어 오늘 방문이 필요해요");
    } else {
      reasons.push("7일 이상 방문하지 않은 이웃");
    }
  }
  if (
    item.daysSinceComment === null ||
    item.daysSinceComment >= COMMENT_NEGLECT_DAYS ||
    item.recommendedAction === "댓글 확인"
  ) {
    reasons.push("댓글 교류가 오래되었습니다");
  }
  if (
    !item.hasRecentPost &&
    !item.needsVisit &&
    item.recommendedAction === "새글 확인"
  ) {
    reasons.push("새 글 확인이 필요해요");
  }

  return reasons.slice(0, 3);
}

/** Alias used by list views — same sentences as care cards. */
export function getCareReasonLabels(item: NeighborManageListItem): string[] {
  return getCareReasonSentences(item);
}

/**
 * Deep link into existing neighbor-feed Approval Inbox.
 * Prefers approvalId when an open feed approval exists for the person.
 */
export function buildNeighborFeedDeepLink(
  item: NeighborManageListItem,
  mode?: "like" | "comment",
): string {
  const params = new URLSearchParams();
  params.set("tab", "feed");
  if (item.openFeedApprovalId) {
    params.set("approvalId", item.openFeedApprovalId);
  } else {
    params.set("personId", item.personId);
  }
  if (mode) params.set("mode", mode);
  return `/neighbors?${params.toString()}`;
}

export function matchesNeighborManageFilter(
  item: NeighborManageListItem,
  filter: NeighborManageFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "recent_post") return item.hasRecentPost;
  const visitNeglected =
    item.daysSinceVisit === null || item.daysSinceVisit >= VISIT_NEGLECT_DAYS;
  const touchNeglected =
    item.daysSinceTouch === null || item.daysSinceTouch >= VISIT_NEGLECT_DAYS;
  return visitNeglected || touchNeglected;
}

export function filterAndSortNeighborManageItems(
  items: NeighborManageListItem[],
  opts: {
    q?: string;
    sort?: NeighborManageSort;
    filter?: NeighborManageFilter;
  },
): NeighborManageListItem[] {
  let next = [...items];
  const filter = opts.filter ?? "all";
  if (filter !== "all") {
    next = next.filter((item) => matchesNeighborManageFilter(item, filter));
  }

  const q = opts.q?.trim().toLowerCase();
  if (q) {
    next = next.filter((item) => {
      const haystack = [
        item.displayName,
        item.blogName,
        item.nickname,
        item.blogUrl,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }

  const sort = opts.sort ?? "last_touch";
  next.sort((a, b) => {
    if (sort === "temperature") {
      return b.temperature - a.temperature;
    }
    if (sort === "last_post") {
      const at = a.lastPostAt ? new Date(a.lastPostAt).getTime() : 0;
      const bt = b.lastPostAt ? new Date(b.lastPostAt).getTime() : 0;
      return bt - at;
    }
    const at = a.lastTouchAt ? new Date(a.lastTouchAt).getTime() : 0;
    const bt = b.lastTouchAt ? new Date(b.lastTouchAt).getTime() : 0;
    return bt - at;
  });

  return next;
}

/** Detail ops health — rule-based from relationship timestamps (no Agent). */
export type NeighborOpsHealth = "활발한 이웃" | "관리 필요";

export function getNeighborOpsHealth(input: {
  lastVisitAt: string | null;
  lastLikeAt: string | null;
  lastCommentAt: string | null;
  lastTouchAt: string | null;
  lastPostAt: string | null;
  now?: number;
}): NeighborOpsHealth {
  const now = input.now ?? Date.now();
  const dVisit = daysSince(input.lastVisitAt, now);
  const dComment = daysSince(input.lastCommentAt, now);
  const dTouch = daysSince(input.lastTouchAt, now);
  const dPost = daysSince(input.lastPostAt, now);

  const needsCare =
    dVisit === null ||
    dVisit >= VISIT_NEGLECT_DAYS ||
    dComment === null ||
    dComment >= COMMENT_NEGLECT_DAYS ||
    dTouch === null ||
    dTouch >= VISIT_NEGLECT_DAYS ||
    (dPost !== null && dPost <= RECENT_POST_DAYS);

  return needsCare ? "관리 필요" : "활발한 이웃";
}

export type NeighborNextActionRec = {
  action: string;
  reasons: string[];
};

/** Next-action recommendation from last_* only (no Agent). */
export function getNeighborNextActionRec(input: {
  lastVisitAt: string | null;
  lastLikeAt: string | null;
  lastCommentAt: string | null;
  lastPostAt: string | null;
  now?: number;
}): NeighborNextActionRec {
  const now = input.now ?? Date.now();
  const dVisit = daysSince(input.lastVisitAt, now);
  const dLike = daysSince(input.lastLikeAt, now);
  const dComment = daysSince(input.lastCommentAt, now);
  const dPost = daysSince(input.lastPostAt, now);
  const hasRecentPost = dPost !== null && dPost <= RECENT_POST_DAYS;
  const needsVisit = dVisit === null || dVisit >= VISIT_NEGLECT_DAYS;
  const needsComment =
    dComment === null || dComment >= COMMENT_NEGLECT_DAYS;

  const reasons: string[] = [];

  if (hasRecentPost) {
    reasons.push(`새 글 작성 ${formatDaysAgoKo(dPost)}`);
    if (needsComment) {
      reasons.push(
        dComment === null
          ? "댓글 교류 기록 없음"
          : `댓글 교류 ${formatDaysAgoKo(dComment)}`,
      );
    } else if (needsVisit) {
      reasons.push(
        dVisit === null
          ? "방문 기록 없음"
          : `마지막 방문 ${formatDaysAgoKo(dVisit)}`,
      );
    }
    return {
      action: "최근 글 방문 추천",
      reasons: reasons.slice(0, 3),
    };
  }

  if (needsVisit) {
    reasons.push(
      dVisit === null
        ? "방문 기록 없음"
        : `마지막 방문 ${formatDaysAgoKo(dVisit)}`,
    );
    if (needsComment) {
      reasons.push(
        dComment === null
          ? "댓글 교류 기록 없음"
          : `댓글 교류 ${formatDaysAgoKo(dComment)}`,
      );
    }
    return {
      action: "관계 유지 방문 추천",
      reasons: reasons.slice(0, 3),
    };
  }

  if (needsComment) {
    reasons.push(
      dComment === null
        ? "댓글 교류 기록 없음"
        : `댓글 교류 ${formatDaysAgoKo(dComment)}`,
    );
    if (dLike === null || dLike >= LIKE_NEGLECT_DAYS) {
      reasons.push(
        dLike === null
          ? "공감 기록 없음"
          : `마지막 공감 ${formatDaysAgoKo(dLike)}`,
      );
    }
    return {
      action: "댓글 교류 추천",
      reasons: reasons.slice(0, 3),
    };
  }

  reasons.push(`마지막 방문 ${formatDaysAgoKo(dVisit)}`);
  if (dLike != null) reasons.push(`마지막 공감 ${formatDaysAgoKo(dLike)}`);
  return {
    action: "관계 유지 방문 추천",
    reasons: reasons.slice(0, 3),
  };
}

/** Feed inbox deep link for a person (existing feed tab). */
export function buildNeighborFeedPersonLink(personId: string): string {
  const params = new URLSearchParams();
  params.set("tab", "feed");
  params.set("personId", personId);
  return `/neighbors?${params.toString()}`;
}

