"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  completeReplyVisitTaskAction,
  executeReplyVisitLikeAction,
  listReplyVisitTasksAction,
  prepareReplyCommentDraftAction,
  snoozeReplyVisitTaskAction,
} from "@/app/actions/replyVisitTasks";
import { ReplyVisitCommentDraftModal } from "@/components/neighbor/ReplyVisitCommentDraftModal";
import {
  EMPTY_REPLY_VISIT_PROGRESS,
  ReplyVisitProgressModal,
  type ReplyVisitProgressState,
} from "@/components/neighbor/ReplyVisitProgressModal";
import { ReplyVisitTaskCard } from "@/components/neighbor/ReplyVisitTaskCard";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { applyBatchQueueDelay } from "@/lib/batchQueueDelay";
import type {
  ReplyVisitSummary,
  ReplyVisitTaskItem,
} from "@/services/replyVisitTaskService";

function humanError(code: string): string {
  if (code === "person_not_found") {
    return "이웃 CRM에 없는 블로그입니다.";
  }
  if (code === "latest_post_not_found") {
    return "최신글을 찾지 못했습니다.";
  }
  if (code === "draft_already_executed") {
    return "이미 등록된 댓글입니다.";
  }
  if (code === "draft_submit_in_progress") {
    return "댓글 등록이 이미 진행 중입니다.";
  }
  if (/session_|needs_relogin|login required|LOGIN_REQUIRED|relogin/i.test(code)) {
    return "네이버 로그인이 필요합니다. 세션을 확인해주세요.";
  }
  if (/timeout|TIMEOUT/i.test(code)) {
    return "네이버 응답이 지연되었습니다. 잠시 후 다시 시도해주세요.";
  }
  if (/rate.?limit|too many|429|일일.*한도|daily_.*_limit/i.test(code)) {
    return "실행 한도에 도달했습니다. 잠시 후 다시 시도해주세요.";
  }
  if (/duplicate_target_action/i.test(code)) {
    return "같은 글에 최근 실행한 이력이 있어 중복 실행을 막았습니다.";
  }
  return code;
}

type BatchMode = "like" | "draft" | "complete";

export function ReplyVisitManageScreen() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<ReplyVisitTaskItem[]>([]);
  const [summary, setSummary] = useState<ReplyVisitSummary>({
    completed: 0,
    total: 0,
    pending: 0,
    lastAnalyzedAt: null,
  });
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [completedOpen, setCompletedOpen] = useState(true);
  const [batchRunning, setBatchRunning] = useState(false);
  const [progress, setProgress] = useState<ReplyVisitProgressState>(
    EMPTY_REPLY_VISIT_PROGRESS,
  );
  const [draftItem, setDraftItem] = useState<ReplyVisitTaskItem | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const data = await listReplyVisitTasksAction();
      setItems(data.items);
      setSummary(data.summary);
      setSelectedIds((prev) => {
        const pendingIds = new Set(
          data.items
            .filter((i) => i.status !== "completed")
            .map((i) => i.id),
        );
        return new Set([...prev].filter((id) => pendingIds.has(id)));
      });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "답방 목록을 불러오지 못했습니다.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const pendingItems = useMemo(
    () => items.filter((i) => i.status !== "completed"),
    [items],
  );
  const completedItems = useMemo(
    () => items.filter((i) => i.status === "completed"),
    [items],
  );

  const allPendingSelected =
    pendingItems.length > 0 &&
    pendingItems.every((i) => selectedIds.has(i.id));

  function toggleSelectAll(checked: boolean) {
    if (!checked) {
      setSelectedIds(new Set());
      return;
    }
    setSelectedIds(new Set(pendingItems.map((i) => i.id)));
  }

  function toggleSelect(taskId: string, selected: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (selected) next.add(taskId);
      else next.delete(taskId);
      return next;
    });
  }

  function markLocalCompleted(taskIds: string[]) {
    const idSet = new Set(taskIds);
    const nowIso = new Date().toISOString();
    setItems((prev) =>
      prev.map((item) =>
        idSet.has(item.id)
          ? {
              ...item,
              status: "completed" as const,
              completedAt: nowIso,
              hasCommentDraft: false,
              commentDraftStatus: item.commentDraftStatus ?? "none",
            }
          : item,
      ),
    );
    setSummary((prev) => ({
      ...prev,
      completed: Math.min(prev.total, prev.completed + taskIds.length),
      pending: Math.max(0, prev.pending - taskIds.length),
    }));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of taskIds) next.delete(id);
      return next;
    });
  }

  function markLocalHasDraft(taskIds: string[]) {
    const idSet = new Set(taskIds);
    setItems((prev) =>
      prev.map((item) =>
        idSet.has(item.id)
          ? {
              ...item,
              hasCommentDraft: true,
              commentDraftStatus: "draft" as const,
            }
          : item,
      ),
    );
  }

  function removeLocal(taskId: string) {
    setItems((prev) => prev.filter((i) => i.id !== taskId));
    setSummary((prev) => ({
      ...prev,
      pending: Math.max(0, prev.pending - 1),
      total: Math.max(0, prev.total - 1),
    }));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.delete(taskId);
      return next;
    });
  }

  async function runSequential(
    targets: ReplyVisitTaskItem[],
    mode: BatchMode,
  ): Promise<{ successCount: number; failCount: number }> {
    if (targets.length === 0 || batchRunning) {
      return { successCount: 0, failCount: 0 };
    }

    setBatchRunning(true);
    setProgress({
      open: true,
      phase: "running",
      title:
        mode === "draft"
          ? "댓글 초안 생성 중입니다"
          : "답방 진행 중입니다",
      current: 0,
      total: targets.length,
      currentLabel: "준비 중…",
      successCount: 0,
      failCount: 0,
    });

    let successCount = 0;
    let failCount = 0;
    const completedNow: string[] = [];
    const draftedNow: string[] = [];
    const failNotes: string[] = [];

    for (let i = 0; i < targets.length; i += 1) {
      const item = targets[i]!;
      const actionLabel =
        mode === "like"
          ? "글 좋아요 중…"
          : mode === "draft"
            ? "댓글 초안 생성 중…"
            : "완료 처리 중…";

      setProgress((prev) => ({
        ...prev,
        current: i,
        currentLabel: `${item.blogName}님 ${actionLabel}`,
      }));

      try {
        if (mode === "like") {
          const result = await executeReplyVisitLikeAction({
            taskId: item.id,
            relationId: item.relationId ?? undefined,
            personId: item.personId || undefined,
            blogId: item.blogId,
          });
          if (!result.ok) throw new Error(humanError(result.error));
        } else if (mode === "draft") {
          const result = await prepareReplyCommentDraftAction({
            taskId: item.id,
            relationId: item.relationId ?? undefined,
            personId: item.personId || undefined,
            blogId: item.blogId,
            regenerate: true,
          });
          if (!result.ok) throw new Error(humanError(result.error));
          draftedNow.push(item.id);
        } else {
          const result = await completeReplyVisitTaskAction(item.id);
          if (!result.ok) throw new Error(result.error);
          completedNow.push(item.id);
        }
        successCount += 1;
      } catch (err) {
        failCount += 1;
        failNotes.push(
          `${item.blogName}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      setProgress((prev) => ({
        ...prev,
        current: i + 1,
        successCount,
        failCount,
      }));

      if (i < targets.length - 1) {
        await applyBatchQueueDelay();
      }
    }

    if (completedNow.length > 0) markLocalCompleted(completedNow);
    if (draftedNow.length > 0) markLocalHasDraft(draftedNow);

    const phase =
      failCount === 0
        ? "success"
        : successCount === 0
          ? "failed"
          : "partial";

    const successTitle =
      mode === "draft"
        ? `댓글 초안 ${successCount}개 생성됨 — 카드에서 검수하세요`
        : "답방 완료되었습니다";

    setProgress({
      open: true,
      phase,
      title:
        phase === "success"
          ? successTitle
          : phase === "partial"
            ? mode === "draft"
              ? "일부 초안 생성 실패"
              : "일부 답방 실패"
            : mode === "draft"
              ? "초안 생성 실패"
              : "답방 실패",
      current: targets.length,
      total: targets.length,
      currentLabel: failNotes.slice(0, 3).join(" · "),
      successCount,
      failCount,
    });
    setBatchRunning(false);
    return { successCount, failCount };
  }

  async function handleSingleLike(item: ReplyVisitTaskItem) {
    const { failCount } = await runSequential([item], "like");
    if (failCount > 0) throw new Error("좋아요 실행에 실패했습니다.");
  }

  async function handleSingleComment(item: ReplyVisitTaskItem) {
    // Open review modal — AI generate happens inside modal (or reuse draft).
    setDraftItem(item);
  }

  async function handleComplete(item: ReplyVisitTaskItem) {
    const { failCount } = await runSequential([item], "complete");
    if (failCount > 0) throw new Error("완료 처리에 실패했습니다.");
  }

  async function handleSnooze(item: ReplyVisitTaskItem) {
    const result = await snoozeReplyVisitTaskAction(item.id);
    if (!result.ok) throw new Error(result.error);
    removeLocal(item.id);
  }

  const selectedItems = pendingItems.filter((i) => selectedIds.has(i.id));

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-4 px-4 pb-56 pt-6">
      <div>
        <p className="text-xs text-muted-foreground">
          <Link
            href="/neighbors?tab=manage"
            className="underline-offset-2 hover:underline"
          >
            이웃관리
          </Link>
          <span aria-hidden> · </span>
          답방
        </p>
        <h1 className="mt-1 text-lg font-semibold tracking-tight">
          답방 해야할 이웃
        </h1>
        <p className="mt-1 text-sm tabular-nums text-muted-foreground">
          전체 {summary.total}명 · 완료 {summary.completed}명
          {pendingItems.length > 0
            ? ` · 미완료 ${pendingItems.length}명`
            : ""}
        </p>
      </div>

      {loading ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-28 w-full rounded-xl" />
          <Skeleton className="h-28 w-full rounded-xl" />
        </div>
      ) : error ? (
        <p className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      ) : (
        <>
          <section className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold tracking-tight">
                🔴 미완료 ({pendingItems.length})
              </h2>
            </div>

            {pendingItems.length > 0 ? (
              <>
                <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/60 bg-secondary/20 px-3 py-2">
                  <label className="flex cursor-pointer items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-primary"
                      checked={allPendingSelected}
                      disabled={batchRunning || draftItem != null}
                      onChange={(e) => toggleSelectAll(e.target.checked)}
                    />
                    전체 선택
                  </label>
                  {selectedItems.length > 0 ? (
                    <div className="ml-auto flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-8 text-xs"
                        disabled={batchRunning || draftItem != null}
                        onClick={() =>
                          void runSequential(selectedItems, "like")
                        }
                      >
                        좋아요 일괄
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="default"
                        className="h-8 text-xs"
                        disabled={batchRunning || draftItem != null}
                        onClick={() =>
                          void runSequential(selectedItems, "draft")
                        }
                      >
                        댓글 초안 일괄
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        className="h-8 text-xs"
                        disabled={batchRunning || draftItem != null}
                        onClick={() =>
                          void runSequential(selectedItems, "complete")
                        }
                      >
                        완료 처리
                      </Button>
                    </div>
                  ) : null}
                </div>

                <ul className="flex flex-col gap-3">
                  {pendingItems.map((item) => (
                    <li key={item.id}>
                      <ReplyVisitTaskCard
                        item={item}
                        selectable
                        selected={selectedIds.has(item.id)}
                        onSelectChange={toggleSelect}
                      locked={batchRunning || draftItem != null}
                      onLike={handleSingleLike}
                      onComment={handleSingleComment}
                      onSnooze={handleSnooze}
                      onComplete={handleComplete}
                      onOpenDraft={handleSingleComment}
                    />
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="rounded-xl border border-border/60 bg-secondary/30 px-4 py-5 text-center text-sm text-muted-foreground">
              {summary.total > 0
                ? "미완료 답방이 없습니다."
                : "최근 3일 내 공감·댓글을 남긴 이웃이 없습니다."}
            </p>
          )}
        </section>

        <section className="space-y-3">
          <button
            type="button"
            className="flex w-full items-center justify-between gap-3 text-left"
            onClick={() => setCompletedOpen((v) => !v)}
          >
            <h2 className="text-sm font-semibold tracking-tight">
              🟢 완료 ({completedItems.length})
            </h2>
            <span className="text-xs text-muted-foreground">
              {completedOpen ? "접기" : "펼치기"}
            </span>
          </button>
          {completedOpen ? (
            completedItems.length > 0 ? (
              <ul className="flex flex-col gap-3">
                {completedItems.map((item) => (
                  <li key={item.id}>
                    <ReplyVisitTaskCard
                      item={item}
                      locked={batchRunning || draftItem != null}
                    />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rounded-xl border border-border/50 px-4 py-4 text-center text-sm text-muted-foreground">
                완료한 답방이 없습니다.
              </p>
            )
          ) : null}
        </section>
        </>
      )}

      <ReplyVisitProgressModal
        state={progress}
        onClose={() => {
          setProgress(EMPTY_REPLY_VISIT_PROGRESS);
          void reload();
        }}
      />

      <ReplyVisitCommentDraftModal
        open={draftItem != null}
        item={draftItem}
        onClose={() => setDraftItem(null)}
        onSubmitted={(item) => {
          setItems((prev) =>
            prev.map((row) =>
              row.id === item.id
                ? {
                    ...row,
                    hasCommentDraft: false,
                    commentDraftStatus: "executed" as const,
                  }
                : row,
            ),
          );
        }}
      />
    </div>
  );
}
