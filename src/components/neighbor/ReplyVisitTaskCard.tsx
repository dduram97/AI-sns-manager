"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ReplyVisitTaskItem } from "@/services/replyVisitTaskService";

/** completed_at → KST display e.g. 07/02(월), 오전 10:32 */
export function formatCompletedAtKst(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(d);

  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";

  const month = get("month");
  const day = get("day");
  const weekday = get("weekday");
  const dayPeriod = get("dayPeriod");
  const hour = get("hour");
  const minute = get("minute");

  return `${month}/${day}(${weekday}), ${dayPeriod} ${hour}:${minute}`;
}

export function ReplyVisitTaskCard({
  item,
  selectable = false,
  selected = false,
  onSelectChange,
  locked = false,
  onLike,
  onComment,
  onSnooze,
  onComplete,
  onOpenDraft,
}: {
  item: ReplyVisitTaskItem;
  selectable?: boolean;
  selected?: boolean;
  onSelectChange?: (taskId: string, selected: boolean) => void;
  locked?: boolean;
  onLike?: (item: ReplyVisitTaskItem) => void | Promise<void>;
  onComment?: (item: ReplyVisitTaskItem) => void | Promise<void>;
  onSnooze?: (item: ReplyVisitTaskItem) => void | Promise<void>;
  onComplete?: (item: ReplyVisitTaskItem) => void | Promise<void>;
  /** Open review modal when card with draft is clicked. */
  onOpenDraft?: (item: ReplyVisitTaskItem) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<
    "like" | "comment" | "snooze" | "done" | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [likeDone, setLikeDone] = useState(false);
  const [statusNote, setStatusNote] = useState<string | null>(null);

  const isCompleted = item.status === "completed";
  const draftStatus = item.commentDraftStatus ?? (item.hasCommentDraft ? "draft" : "none");
  const hasOpenDraft = draftStatus === "draft";
  const postUrl =
    item.latestPostUrl?.trim() ||
    `https://blog.naver.com/${encodeURIComponent(item.blogId)}`;
  const completedLabel = formatCompletedAtKst(item.completedAt);

  const disabled = locked || pending || busy != null;

  function draftStatusLabel(): { text: string; className: string } {
    if (draftStatus === "executed") {
      return {
        text: "댓글 등록 완료",
        className:
          "bg-emerald-500/15 text-emerald-800 dark:text-emerald-200",
      };
    }
    if (draftStatus === "draft") {
      return {
        text: "댓글 초안 생성됨",
        className: "bg-amber-500/15 text-amber-800 dark:text-amber-200",
      };
    }
    return {
      text: "댓글 초안 없음",
      className: "bg-secondary text-muted-foreground",
    };
  }

  function run(
    kind: "like" | "comment" | "snooze" | "done",
    fn?: (item: ReplyVisitTaskItem) => void | Promise<void>,
    onOk?: () => void,
  ) {
    if (!fn) return;
    setError(null);
    setStatusNote(null);
    setBusy(kind);
    startTransition(async () => {
      try {
        await fn(item);
        onOk?.();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    });
  }

  const draftBadge = draftStatusLabel();

  return (
    <article
      className={cn(
        "rounded-xl border bg-card p-4",
        isCompleted
          ? "border-emerald-500/25 bg-emerald-500/[0.03]"
          : "border-border/70",
        selected && !isCompleted ? "border-primary/50 ring-1 ring-primary/20" : "",
        hasOpenDraft && !isCompleted && onOpenDraft
          ? "cursor-pointer hover:border-amber-500/40"
          : "",
      )}
      onClick={
        hasOpenDraft && !isCompleted && onOpenDraft && !disabled
          ? () => onOpenDraft(item)
          : undefined
      }
      onKeyDown={
        hasOpenDraft && !isCompleted && onOpenDraft && !disabled
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onOpenDraft(item);
              }
            }
          : undefined
      }
      role={hasOpenDraft && !isCompleted && onOpenDraft ? "button" : undefined}
      tabIndex={hasOpenDraft && !isCompleted && onOpenDraft ? 0 : undefined}
    >
      <div className="flex items-start gap-3">
        {selectable && !isCompleted ? (
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 shrink-0 accent-primary"
            checked={selected}
            disabled={locked}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => onSelectChange?.(item.id, e.target.checked)}
            aria-label={`${item.blogName} 선택`}
          />
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="truncate text-sm font-semibold tracking-tight">
                  {item.blogName}
                </h3>
                {isCompleted ? (
                  <span className="text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                    🟢 완료
                  </span>
                ) : (
                  <span className="text-[11px] font-medium text-rose-700 dark:text-rose-300">
                    🔴 미완료
                  </span>
                )}
              </div>
              <a
                href={item.profileUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-0.5 block truncate text-xs text-muted-foreground underline-offset-2 hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                @{item.blogId}
              </a>
            </div>
            {item.relationScore > 0 ? (
              <span className="shrink-0 rounded-md bg-secondary px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
                점수 {item.relationScore}
              </span>
            ) : null}
          </div>

          <div className="mt-2 space-y-0.5 text-xs text-muted-foreground">
            <p>
              {item.activityClassLabel}
              {item.hasComment ? " · 댓글" : ""}
              {item.hasLike ? " · 공감" : ""}
            </p>
            <p>최근 활동 {item.lastActivityLabel}</p>
            {item.latestPostTitle ? (
              <p className="truncate">📌 {item.latestPostTitle}</p>
            ) : null}
            {!isCompleted ? (
              <p className="pt-1">
                <span
                  className={cn(
                    "inline-flex rounded-md px-1.5 py-0.5 text-[10px] font-medium",
                    draftBadge.className,
                  )}
                >
                  {draftBadge.text}
                </span>
                {hasOpenDraft ? (
                  <span className="ml-1.5 text-[10px] text-muted-foreground">
                    · 카드 클릭 시 검수
                  </span>
                ) : null}
              </p>
            ) : null}
            {isCompleted && completedLabel ? (
              <p className="pt-0.5 font-medium text-emerald-800 dark:text-emerald-200">
                완료일자: {completedLabel}
              </p>
            ) : null}
          </div>

          <div
            className="mt-3 flex flex-wrap gap-2"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <Button
              asChild
              size="sm"
              variant="outline"
              className="h-9 px-3 text-xs"
            >
              <a href={postUrl} target="_blank" rel="noopener noreferrer">
                글보기
              </a>
            </Button>
            {!isCompleted ? (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-9 px-3 text-xs"
                  disabled={disabled || likeDone}
                  onClick={() =>
                    run("like", onLike, () => {
                      setLikeDone(true);
                      setStatusNote("공감 등록 완료");
                    })
                  }
                >
                  {busy === "like"
                    ? "공감 중…"
                    : likeDone
                      ? "공감 완료"
                      : "좋아요"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="default"
                  className="h-9 px-3 text-xs"
                  disabled={disabled}
                  onClick={() => run("comment", onComment)}
                >
                  {busy === "comment"
                    ? "준비 중…"
                    : hasOpenDraft
                      ? "댓글 검수"
                      : draftStatus === "executed"
                        ? "댓글 다시쓰기"
                        : "댓글"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-9 px-3 text-xs"
                  disabled={disabled}
                  onClick={() => run("snooze", onSnooze)}
                >
                  {busy === "snooze" ? "처리 중…" : "나중에"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="h-9 px-3 text-xs"
                  disabled={disabled}
                  onClick={() => run("done", onComplete)}
                >
                  {busy === "done" ? "처리 중…" : "완료"}
                </Button>
              </>
            ) : null}
          </div>

          {statusNote ? (
            <p className="mt-2 text-[11px] text-emerald-700 dark:text-emerald-300">
              {statusNote}
            </p>
          ) : null}
          {error ? (
            <p className="mt-2 text-[11px] text-destructive">{error}</p>
          ) : null}
        </div>
      </div>
    </article>
  );
}
