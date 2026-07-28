"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { markNeighborCareDoneTodayAction, snoozeNeighborCareTodayAction } from "@/app/actions/neighbors";
import { ReplyVisitSummaryCard } from "@/components/neighbor/ReplyVisitSummaryCard";
import { kstTodayYmd } from "@/lib/completedRange";
import type { ReplyVisitSummary } from "@/services/replyVisitTaskService";
import {
  careStatusLabel,
  daysSince,
  emptyNeighborWeeklyReport,
  filterAndSortNeighborManageItems,
  formatCareDoneSummary,
  formatCareTimeKo,
  formatDaysAgoKo,
  buildNeighborFeedDeepLink,
  getCarePrimaryHeadline,
  getCareReasonSentences,
  getCareWhyTodayLines,
  getNeighborCareCtas,
  getTodayOpsSummary,
  selectNowTodoNeighbors,
  selectTodayCareDoneNeighbors,
  selectTodayCareNeighbors,
  type NeighborManageSort,
} from "@/lib/neighborManageListUtils";
import { neighborRelationStatusLabel } from "@/domain/neighbor/relationStatus";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  NeighborCareStatus,
  NeighborManageFilter,
  NeighborManageListItem,
  NeighborManageTodayActions,
  NeighborManageWeeklyReport,
} from "@/types/neighborManage";

function displayTitle(item: NeighborManageListItem): string {
  return item.blogName ?? item.nickname ?? item.displayName;
}

function CareStatusBadge({ status }: { status: NeighborCareStatus }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium",
        status === "done_today" &&
          "bg-emerald-500/15 text-emerald-800 dark:text-emerald-200",
        status === "snoozed_today" &&
          "bg-amber-500/15 text-amber-800 dark:text-amber-200",
        status === "in_progress" &&
          "bg-sky-500/15 text-sky-800 dark:text-sky-200",
        status === "todo" && "bg-amber-500/15 text-amber-800 dark:text-amber-200",
      )}
    >
      {careStatusLabel(status)}
    </span>
  );
}

function SignalBadges({ item }: { item: NeighborManageListItem }) {
  if (!item.needsVisit && !item.hasRecentPost && !item.openFeedApprovalId) {
    return null;
  }
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {item.needsVisit ? (
        <span className="rounded-md bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:text-amber-200">
          방문 필요
        </span>
      ) : null}
      {item.hasRecentPost ? (
        <span className="rounded-md bg-sky-500/15 px-2 py-0.5 text-[11px] font-medium text-sky-800 dark:text-sky-200">
          새글 있음
        </span>
      ) : null}
      {item.openFeedApprovalId ? (
        <span className="rounded-md bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-800 dark:text-emerald-200">
          승인 대기
        </span>
      ) : null}
    </div>
  );
}

function RecentPostBlock({ item }: { item: NeighborManageListItem }) {
  const title =
    item.openFeedPostTitle?.trim() ||
    item.lastPostTitle?.trim() ||
    null;
  if (!title && item.daysSincePost == null) return null;
  return (
    <div className="mt-3 rounded-lg bg-secondary/50 px-3 py-2.5">
      <p className="text-[11px] font-medium text-muted-foreground">📌 최신글</p>
      <p className="mt-1 line-clamp-2 text-sm font-medium leading-snug text-foreground/90">
        {title ? `"${title}"` : "제목 없음"}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        🕒 {formatDaysAgoKo(item.daysSincePost)} 작성
      </p>
    </div>
  );
}

function CareReasons({ item }: { item: NeighborManageListItem }) {
  const reasons = getCareReasonSentences(item);
  if (reasons.length === 0 && !item.recommendedAction) return null;
  return (
    <div className="mt-2 space-y-1">
      <p className="text-[11px] font-medium text-muted-foreground">추천</p>
      {reasons.map((r) => (
        <p key={r} className="text-xs text-foreground/85">
          · {r}
        </p>
      ))}
      {item.recommendedAction &&
      !reasons.some((r) => r.includes(item.recommendedAction!)) ? (
        <p className="text-xs font-medium text-foreground/80">
          · {item.recommendedAction}
        </p>
      ) : null}
    </div>
  );
}

function CareDoneLabels({ item }: { item: NeighborManageListItem }) {
  if (item.careDoneLabels.length === 0 && !item.careDoneAt) return null;
  const time = formatCareTimeKo(item.careDoneAt);
  return (
    <div className="mt-2 space-y-1.5">
      {item.careDoneLabels.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {item.careDoneLabels.map((label) => (
            <span
              key={label}
              className="rounded-md bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-800 dark:text-emerald-200"
            >
              {label}
            </span>
          ))}
        </div>
      ) : null}
      {time ? (
        <p className="text-[11px] text-muted-foreground">완료 {time}</p>
      ) : null}
    </div>
  );
}

function TodayOpsSummaryCard({
  completed,
  total,
  pending,
  visit,
  like,
  comment,
}: {
  completed: number;
  total: number;
  pending: number;
  visit: number;
  like: number;
  comment: number;
}) {
  return (
    <section className="rounded-xl border border-border/70 bg-card px-3.5 py-3">
      <p className="text-sm font-semibold tracking-tight">오늘 돌봄</p>
      <div className="mt-1.5 border-t border-border/50 pt-2">
        <p className="text-sm font-semibold tabular-nums">
          완료 {completed}명
          <span className="font-normal text-muted-foreground">
            {" "}
            / 전체 {total}명
          </span>
        </p>
      </div>
      <div className="mt-2.5 flex items-end justify-between gap-3">
        <div>
          <p className="text-[11px] font-medium text-muted-foreground">행동</p>
          <p className="mt-0.5 text-xs tabular-nums text-foreground/90">
            방문 {visit}
            <span className="text-muted-foreground"> · </span>
            공감 {like}
            <span className="text-muted-foreground"> · </span>
            댓글 {comment}
          </p>
        </div>
        <p className="shrink-0 text-xs font-medium tabular-nums text-muted-foreground">
          남은 대상 {pending}명
        </p>
      </div>
    </section>
  );
}

function WeeklyOpsReportCard({
  report,
  onSelect,
}: {
  report: NeighborManageWeeklyReport;
  onSelect: (personId: string) => void;
}) {
  const hasActions =
    report.neighborCount > 0 ||
    report.visit + report.like + report.comment > 0;

  return (
    <section className="rounded-xl border border-border/70 bg-card px-3.5 py-3">
      <p className="text-sm font-semibold tracking-tight">이번 주 운영</p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">최근 7일 · KST</p>

      <div className="mt-2 border-t border-border/50 pt-2 space-y-1.5">
        {hasActions ? (
          <>
            <p className="text-sm font-medium leading-snug">
              이번 주{" "}
              <span className="tabular-nums font-semibold">
                {report.neighborCount}명
              </span>
              의 이웃을 관리했어요
            </p>
            <p className="text-xs tabular-nums text-foreground/85">
              댓글 {report.comment}회
              <span className="text-muted-foreground"> · </span>
              공감 {report.like}회
              <span className="text-muted-foreground"> · </span>
              방문 {report.visit}회
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            이번 주 아직 관리 기록이 없어요
          </p>
        )}

        {report.recentOrActive ? (
          <button
            type="button"
            onClick={() => onSelect(report.recentOrActive!.personId)}
            className="block w-full truncate text-left text-xs text-foreground/85 hover:text-foreground"
          >
            활발한 이웃 · {report.recentOrActive.name}
            <span className="text-muted-foreground">
              {" "}
              ({report.recentOrActive.detail})
            </span>
          </button>
        ) : null}

        {report.neglected ? (
          <button
            type="button"
            onClick={() => onSelect(report.neglected!.personId)}
            className="block w-full truncate text-left text-xs text-foreground/85 hover:text-foreground"
          >
            가장 오래 확인하지 않은 이웃: {report.neglected.name}
            <span className="text-muted-foreground">
              {" "}
              ({formatDaysAgoKo(report.neglected.daysSinceTouch)})
            </span>
          </button>
        ) : null}
      </div>
    </section>
  );
}

function CareDoneRow({
  item,
  onSelect,
}: {
  item: NeighborManageListItem;
  onSelect: (personId: string) => void;
}) {
  const time = formatCareTimeKo(item.careDoneAt);
  const summary = formatCareDoneSummary(item);
  return (
    <button
      type="button"
      onClick={() => onSelect(item.personId)}
      className="flex w-full items-start gap-2 rounded-xl border border-border/50 bg-secondary/20 px-3 py-2.5 text-left transition-colors hover:bg-secondary/40"
    >
      <span className="mt-0.5 text-sm" aria-hidden>
        ✅
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold tracking-tight">
          {displayTitle(item)}
        </p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {summary}
          {time ? ` · ${time}` : ""}
        </p>
      </div>
    </button>
  );
}

/** Compact first-screen card: why → action → CTA. */
function NowTodoCard({
  item,
  onSelect,
  onComplete,
  onSnooze,
  exiting = null,
  locked = false,
}: {
  item: NeighborManageListItem;
  onSelect: (personId: string) => void;
  onComplete: (personId: string) => Promise<void>;
  onSnooze: (personId: string) => Promise<void>;
  exiting?: "done" | "snooze" | null;
  locked?: boolean;
}) {
  const why = getCareWhyTodayLines(item).slice(0, 3);
  const headline = getCarePrimaryHeadline(item);
  const hasRecentPost = item.hasRecentPost;

  if (exiting === "done") {
    return (
      <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-left transition-opacity duration-300">
        <p className="truncate text-sm font-semibold tracking-tight">
          ✅ {displayTitle(item)}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">오늘 돌봄 완료</p>
      </div>
    );
  }

  if (exiting === "snooze") {
    return (
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-left transition-opacity duration-300">
        <p className="truncate text-sm font-semibold tracking-tight">
          ⏰ {displayTitle(item)}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">내일 다시 확인</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-primary/25 bg-primary/[0.03] p-3 text-left transition-opacity duration-200">
      <button
        type="button"
        onClick={() => onSelect(item.personId)}
        className="flex w-full items-start justify-between gap-2 text-left"
      >
        <p className="min-w-0 truncate font-semibold tracking-tight">
          {displayTitle(item)}
        </p>
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          {hasRecentPost ? (
            <span className="rounded-md bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-medium text-sky-800 dark:text-sky-200">
              새글
            </span>
          ) : null}
          {item.needsVisit ? (
            <span className="rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:text-amber-200">
              방문
            </span>
          ) : null}
          <CareStatusBadge status={item.careStatus} />
        </div>
      </button>

      {headline ? (
        <p className="mt-2 text-sm font-semibold leading-snug text-foreground">
          <span aria-hidden>{headline.emoji} </span>
          {headline.text}
        </p>
      ) : null}

      {why.length > 0 ? (
        <div className="mt-2 space-y-0.5">
          <p className="text-[11px] font-medium text-muted-foreground">
            왜 오늘 볼까요
          </p>
          {why.map((line) => (
            <p key={line} className="text-xs leading-snug text-foreground/85">
              · {line}
            </p>
          ))}
        </div>
      ) : null}

      {hasRecentPost && (item.openFeedPostTitle || item.lastPostTitle) ? (
        <p className="mt-1.5 truncate text-[11px] text-muted-foreground">
          📌 {item.openFeedPostTitle?.trim() || item.lastPostTitle}
        </p>
      ) : null}

      <CareActionRow
        item={item}
        onComplete={onComplete}
        onSnooze={onSnooze}
        compact
        locked={locked}
      />
    </div>
  );
}

function CareActionRow({
  item,
  onComplete,
  onSnooze,
  compact = false,
  locked = false,
}: {
  item: NeighborManageListItem;
  onComplete: (personId: string) => Promise<void>;
  onSnooze?: (personId: string) => Promise<void>;
  compact?: boolean;
  locked?: boolean;
}) {
  const router = useRouter();
  const [navigating, setNavigating] = useState<"like" | "comment" | null>(
    null,
  );
  const [completing, setCompleting] = useState(false);
  const [snoozing, setSnoozing] = useState(false);
  const [completeError, setCompleteError] = useState<string | null>(null);
  const ctas = getNeighborCareCtas(item);
  const isDone =
    item.careStatus === "done_today" || item.careStatus === "snoozed_today";

  function goToFeed(mode: "like" | "comment") {
    setNavigating(mode);
    router.push(buildNeighborFeedDeepLink(item, mode));
  }

  async function handleComplete() {
    if (locked || completing || snoozing) return;
    setCompleting(true);
    setCompleteError(null);
    try {
      await onComplete(item.personId);
    } catch (err) {
      setCompleteError(
        err instanceof Error ? err.message : "완료 처리에 실패했습니다.",
      );
      setCompleting(false);
    }
  }

  async function handleSnooze() {
    if (!onSnooze || locked || completing || snoozing) return;
    setSnoozing(true);
    setCompleteError(null);
    try {
      await onSnooze(item.personId);
    } catch (err) {
      setCompleteError(
        err instanceof Error ? err.message : "나중에 보기 처리에 실패했습니다.",
      );
      setSnoozing(false);
    }
  }

  if (isDone) return null;

  const busy = locked || navigating != null || completing || snoozing;
  const feedPrimary = ctas.showComment || ctas.showLike;
  const showBlogCta = ctas.showBlog && Boolean(item.blogUrl) && !item.hasRecentPost;

  return (
    <div
      className={cn("space-y-1", compact ? "mt-2" : "mt-3")}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="flex flex-wrap gap-2">
        {ctas.showComment ? (
          <Button
            type="button"
            size="sm"
            variant="default"
            className="h-9 min-w-[4.25rem] px-3 text-xs"
            disabled={busy}
            onClick={() => goToFeed("comment")}
          >
            {navigating === "comment" ? "이동 중…" : "댓글"}
          </Button>
        ) : null}
        {ctas.showLike ? (
          <Button
            type="button"
            size="sm"
            variant={ctas.showComment ? "outline" : "default"}
            className="h-9 min-w-[4.25rem] px-3 text-xs"
            disabled={busy}
            onClick={() => goToFeed("like")}
          >
            {navigating === "like" ? "이동 중…" : "좋아요"}
          </Button>
        ) : null}
        {showBlogCta ? (
          <Button
            asChild
            size="sm"
            variant={feedPrimary ? "outline" : "default"}
            className="h-9 min-w-[4.25rem] px-3 text-xs"
          >
            <a href={item.blogUrl!} target="_blank" rel="noopener noreferrer">
              블로그
            </a>
          </Button>
        ) : null}
        {item.hasRecentPost && item.blogUrl ? (
          <Button
            asChild
            size="sm"
            variant="outline"
            className="h-9 min-w-[4.25rem] px-3 text-xs"
          >
            <a href={item.blogUrl} target="_blank" rel="noopener noreferrer">
              글 보기
            </a>
          </Button>
        ) : null}
        {onSnooze ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-9 min-w-[4.25rem] px-3 text-xs"
            disabled={busy}
            onClick={() => void handleSnooze()}
          >
            {snoozing ? "처리 중…" : "나중에"}
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="h-9 min-w-[4.25rem] px-3 text-xs"
          disabled={busy}
          onClick={() => void handleComplete()}
        >
          {completing ? "처리 중…" : "완료"}
        </Button>
      </div>
      {completeError ? (
        <p className="text-[11px] text-destructive">{completeError}</p>
      ) : null}
    </div>
  );
}

function NeighborManageCard({
  item,
  onSelect,
  onComplete,
  variant = "list",
}: {
  item: NeighborManageListItem;
  onSelect: (personId: string) => void;
  onComplete?: (personId: string) => Promise<void>;
  variant?: "list" | "care" | "care_done";
}) {
  const rel = neighborRelationStatusLabel(item.relationStatus);
  const isCare = variant === "care" || variant === "care_done";
  const isCareDone = variant === "care_done";

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(item.personId)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(item.personId);
        }
      }}
      className={cn(
        "block w-full cursor-pointer rounded-xl border border-border/70 bg-card p-4 text-left transition-colors hover:bg-secondary/40",
        variant === "care" && "border-primary/25 bg-primary/[0.03]",
        isCareDone && "border-border/50 bg-secondary/20 opacity-90",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold tracking-tight">{displayTitle(item)}</p>
          {item.nickname && item.blogName !== item.nickname ? (
            <p className="mt-0.5 text-xs text-muted-foreground">
              닉네임 · {item.nickname}
            </p>
          ) : null}
          {!isCare && item.blogUrl ? (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {item.blogUrl}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {isCare ? <CareStatusBadge status={item.careStatus} /> : null}
          <span className="rounded-md bg-secondary px-2 py-0.5 text-[11px] font-medium">
            {rel.shortLabel}
          </span>
        </div>
      </div>

      {!isCareDone ? <SignalBadges item={item} /> : null}

      {variant === "care" ? <CareReasons item={item} /> : null}

      {variant === "care" ? <RecentPostBlock item={item} /> : null}

      {isCare ? <CareDoneLabels item={item} /> : null}

      {!isCare && item.recommendedAction ? (
        <p className="mt-2 text-xs font-medium text-foreground/80">
          추천 · {item.recommendedAction}
        </p>
      ) : null}

      {isCareDone ? null : (
        <p className="mt-2 text-xs text-muted-foreground">
          {item.stage}
          {item.recentActivityAt
            ? ` · ${item.recentActivityLabel} ${formatDaysAgoKo(daysSince(item.recentActivityAt))}`
            : ""}
        </p>
      )}

      {!isCareDone ? (
        <>
          <dl className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
            <div className="rounded-md bg-secondary/60 py-2">
              <dt className="text-muted-foreground">Temp</dt>
              <dd className="mt-0.5 font-semibold tabular-nums">
                {item.temperature}
              </dd>
            </div>
            <div className="rounded-md bg-secondary/60 py-2">
              <dt className="text-muted-foreground">Score</dt>
              <dd className="mt-0.5 font-semibold tabular-nums">{item.score}</dd>
            </div>
            <div className="rounded-md bg-secondary/60 py-2">
              <dt className="text-muted-foreground">교류</dt>
              <dd className="mt-0.5 font-semibold">
                {formatDaysAgoKo(item.daysSinceTouch)}
              </dd>
            </div>
          </dl>

          <div className="mt-2 grid grid-cols-3 gap-2 text-[10px] text-muted-foreground">
            <span>방문 {formatDaysAgoKo(item.daysSinceVisit)}</span>
            <span>공감 {formatDaysAgoKo(item.daysSinceLike)}</span>
            <span>댓글 {formatDaysAgoKo(item.daysSinceComment)}</span>
          </div>
        </>
      ) : null}

      {!isCare && item.lastPostTitle ? (
        <p className="mt-2 truncate text-[11px] text-muted-foreground">
          최근 글 · {item.lastPostTitle}
          {item.daysSincePost != null
            ? ` · ${formatDaysAgoKo(item.daysSincePost)}`
            : ""}
        </p>
      ) : null}

      {variant === "care" && onComplete ? (
        <CareActionRow item={item} onComplete={onComplete} />
      ) : null}
    </div>
  );
}

export function NeighborManageList({
  items,
  todayActions = { visit: 0, like: 0, comment: 0 },
  weeklyReport = emptyNeighborWeeklyReport(),
  replyVisitSummary = null,
  replyVisitSummaryLoading = false,
  onSelect,
  onListRefresh,
}: {
  items: NeighborManageListItem[];
  todayActions?: NeighborManageTodayActions;
  weeklyReport?: NeighborManageWeeklyReport;
  replyVisitSummary?: ReplyVisitSummary | null;
  replyVisitSummaryLoading?: boolean;
  onSelect: (personId: string) => void;
  onListRefresh?: () => Promise<void>;
}) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<NeighborManageSort>("last_touch");
  const [filter, setFilter] = useState<NeighborManageFilter>("all");
  const [localItems, setLocalItems] = useState(items);
  const [exiting, setExiting] = useState<{
    id: string;
    kind: "done" | "snooze";
  } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    kind: "done" | "snooze";
    name: string;
    remaining: number;
  } | null>(null);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setLocalItems(items);
  }, [items]);

  useEffect(() => {
    return () => {
      if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    };
  }, []);

  const exitingId = exiting?.id ?? null;

  const nowTodo = useMemo(() => {
    const todos = selectNowTodoNeighbors(localItems);
    if (exitingId && !todos.some((t) => t.personId === exitingId)) {
      const exitingItem = localItems.find((i) => i.personId === exitingId);
      if (exitingItem) return [exitingItem, ...todos].slice(0, 3);
    }
    return todos;
  }, [localItems, exitingId]);

  const pendingAll = useMemo(
    () => selectTodayCareNeighbors(localItems),
    [localItems],
  );
  const todayCareDone = useMemo(
    () => selectTodayCareDoneNeighbors(localItems),
    [localItems],
  );
  const opsSummary = useMemo(
    () => getTodayOpsSummary(localItems, todayActions),
    [localItems, todayActions],
  );

  const filtered = useMemo(
    () => filterAndSortNeighborManageItems(localItems, { q, sort, filter }),
    [localItems, q, sort, filter],
  );

  const hasLastPostData = localItems.some((i) => i.lastPostAt);
  const morePending = Math.max(
    0,
    pendingAll.filter((p) => p.personId !== exitingId).length -
      nowTodo.filter((t) => t.personId !== exitingId).length,
  );

  async function handleComplete(personId: string) {
    if (busyId || exiting) return;
    setBusyId(personId);
    try {
      await markNeighborCareDoneTodayAction(personId);

      const target = localItems.find((i) => i.personId === personId);
      const name = target ? displayTitle(target) : "이웃";
      setExiting({ id: personId, kind: "done" });

      await new Promise((r) => setTimeout(r, 380));

      const doneAt = new Date().toISOString();
      const doneOn = kstTodayYmd();
      const next = localItems.map((item) => {
        if (item.personId !== personId) return item;
        const labels = item.careDoneLabels.includes("수동 완료")
          ? item.careDoneLabels
          : [...item.careDoneLabels, "수동 완료"];
        return {
          ...item,
          careStatus: "done_today" as const,
          careDoneOn: doneOn,
          careDoneAt: doneAt,
          careDoneLabels: labels,
        };
      });
      const remaining = selectTodayCareNeighbors(next).length;
      setLocalItems(next);
      setExiting(null);
      setFeedback({ kind: "done", name, remaining });

      if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
      feedbackTimer.current = setTimeout(() => setFeedback(null), 2800);

      void onListRefresh?.();
    } finally {
      setBusyId(null);
    }
  }

  async function handleSnooze(personId: string) {
    if (busyId || exiting) return;
    setBusyId(personId);
    try {
      await snoozeNeighborCareTodayAction(personId);

      const target = localItems.find((i) => i.personId === personId);
      const name = target ? displayTitle(target) : "이웃";
      setExiting({ id: personId, kind: "snooze" });

      await new Promise((r) => setTimeout(r, 380));

      const snoozeOn = kstTodayYmd();
      const next = localItems.map((item) => {
        if (item.personId !== personId) return item;
        return {
          ...item,
          careStatus: "snoozed_today" as const,
          careSnoozeOn: snoozeOn,
        };
      });
      const remaining = selectTodayCareNeighbors(next).length;
      setLocalItems(next);
      setExiting(null);
      setFeedback({ kind: "snooze", name, remaining });

      if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
      feedbackTimer.current = setTimeout(() => setFeedback(null), 2800);

      void onListRefresh?.();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* 1. Ops summaries */}
      <TodayOpsSummaryCard
        completed={opsSummary.completed}
        total={opsSummary.total}
        pending={opsSummary.pending}
        visit={opsSummary.visit}
        like={opsSummary.like}
        comment={opsSummary.comment}
      />
      <WeeklyOpsReportCard report={weeklyReport} onSelect={onSelect} />

      {/* Reply-visit workflow entry (list lives on /neighbors/reply) */}
      <ReplyVisitSummaryCard
        summary={replyVisitSummary}
        loading={replyVisitSummaryLoading}
      />

      {/* 2. Now todo — max 3 incomplete */}
      <section className="space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold tracking-tight">지금 할 일</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              우선 돌볼 이웃 · 최대 3명
            </p>
          </div>
          {opsSummary.pending > 0 ? (
            <p className="shrink-0 text-xs font-medium tabular-nums text-muted-foreground">
              남음 {opsSummary.pending}명
            </p>
          ) : null}
        </div>

        {feedback ? (
          <div
            className={cn(
              "rounded-lg px-3 py-2 text-sm transition-opacity",
              feedback.kind === "done"
                ? "border border-emerald-500/25 bg-emerald-500/10"
                : "border border-amber-500/25 bg-amber-500/10",
            )}
            role="status"
          >
            {feedback.kind === "done" ? (
              <>
                <p className="font-medium text-emerald-900 dark:text-emerald-100">
                  오늘 돌봄 완료 · {feedback.name}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  남은 대상 {feedback.remaining}명
                </p>
              </>
            ) : (
              <>
                <p className="font-medium text-amber-900 dark:text-amber-100">
                  나중에 보기로 넘김 · {feedback.name}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  ⏰ 내일 다시 확인 · 남은 대상 {feedback.remaining}명
                </p>
              </>
            )}
          </div>
        ) : null}

        {nowTodo.length > 0 ? (
          <>
            <ul className="flex flex-col gap-2">
              {nowTodo.map((item) => (
                <li key={`now-${item.personId}`}>
                  <NowTodoCard
                    item={item}
                    onSelect={onSelect}
                    onComplete={handleComplete}
                    onSnooze={handleSnooze}
                    exiting={
                      exiting?.id === item.personId ? exiting.kind : null
                    }
                    locked={busyId != null && busyId !== item.personId}
                  />
                </li>
              ))}
            </ul>
            {morePending > 0 ? (
              <p className="text-center text-[11px] text-muted-foreground">
                아래 전체 목록에 우선 대상 {morePending}명 더 있음
              </p>
            ) : null}
          </>
        ) : (
          <p className="rounded-xl border border-border/60 bg-secondary/30 px-4 py-5 text-center text-sm text-muted-foreground">
            {todayCareDone.length > 0
              ? "지금 할 일을 모두 마쳤습니다."
              : "지금 할 이웃이 없습니다."}
          </p>
        )}
      </section>

      {/* 3. Done today */}
      <section className="space-y-2">
        <div>
          <h2 className="text-sm font-semibold tracking-tight">
            오늘 완료
            {todayCareDone.length > 0 ? (
              <span className="ml-1.5 text-muted-foreground">
                {todayCareDone.length}
              </span>
            ) : null}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            완료한 이웃 · 행동 · 시간
          </p>
        </div>
        {todayCareDone.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {todayCareDone.map((item) => (
              <li key={`care-done-${item.personId}`}>
                <CareDoneRow item={item} onSelect={onSelect} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-xl border border-dashed border-border/60 px-4 py-4 text-center text-sm text-muted-foreground">
            아직 오늘 완료한 이웃이 없습니다.
          </p>
        )}
      </section>

      {/* 4. Full list */}
      <div className="border-t border-border/50 pt-3">
        <p className="text-sm font-semibold tracking-tight">전체 이웃</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          서로이웃 완료 {filtered.length}명
          {filter !== "all" ? ` · 필터 적용` : ""}
        </p>
      </div>

      <div className="space-y-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="블로그명 · 닉네임 · URL 검색"
          className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
        />

        <div className="flex flex-wrap gap-2">
          {(
            [
              ["all", "전체"],
              ["neglected", "방치"],
              ["recent_post", "새글 있음"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setFilter(value)}
              className={cn(
                "rounded-full px-3 py-1.5 text-xs font-medium",
                filter === value
                  ? "bg-primary text-primary-foreground"
                  : "bg-secondary text-secondary-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap gap-2">
          {(
            [
              ["last_touch", "최근 교류순"],
              ["temperature", "관계 온도순"],
              ...(hasLastPostData
                ? ([["last_post", "최근 게시글순"]] as const)
                : []),
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setSort(value)}
              className={cn(
                "rounded-md px-2.5 py-1.5 text-[11px] font-medium",
                sort === value
                  ? "bg-foreground text-background"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <ul className="flex flex-col gap-2">
        {filtered.map((item) => (
          <li key={item.personId}>
            <NeighborManageCard item={item} onSelect={onSelect} />
          </li>
        ))}
        {filtered.length === 0 ? (
          <li className="rounded-xl border border-border/70 px-4 py-10 text-center text-sm text-muted-foreground">
            {localItems.length === 0
              ? "서로이웃 완료된 이웃이 없습니다."
              : "검색 결과가 없습니다."}
          </li>
        ) : null}
      </ul>
    </div>
  );
}
