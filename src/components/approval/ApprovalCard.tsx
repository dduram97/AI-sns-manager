"use client";

import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, useTransition } from "react";
import {
  previewNeighborFeedCommentAction,
  regenerateApprovalCommentDraftAction,
  rejectApprovalAction,
  retryFailedApprovalAction,
  saveApprovalCommentSituationAction,
  saveApprovalDraftAction,
  snoozeApprovalAction,
} from "@/app/actions/approvals";
import { getAgentBriefAction } from "@/app/actions/brief";
import { Button } from "@/components/ui/button";
import {
  approvalModeLabel,
  defaultApprovalExecuteMode,
  parseApprovalExecuteMode,
  type ApprovalExecuteMode,
} from "@/lib/approvalExecuteMode";
import {
  approvalFailureStageLabel,
  formatApprovalFailureTime,
  toFriendlyFailure,
} from "@/lib/approvalFailure";
import {
  extractTestRunId,
  isNeighborFeedInboxItem,
  operatorAuthorName,
  operatorDraftBody,
  operatorPostTitle,
  operatorPublishedDate,
  operatorRecommendReasons,
} from "@/lib/approvalDisplay";
import {
  needsNeighborFeedAiDraft,
  neighborFeedDraftProbeFromInboxItem,
} from "@/lib/neighborFeedDraft";
import {
  COMMENT_SITUATIONS,
  type CommentSituation,
} from "@/lib/commentSituation";
import { queryKeys } from "@/lib/queryKeys";
import type { ApprovalInboxItem } from "@/types/approvalInbox";

export type ApprovalRequestApproveArgs = {
  approvalId: string;
  draftBody?: string;
  mode?: ApprovalExecuteMode;
};

type ApprovalCardProps = {
  item: ApprovalInboxItem;
  selected?: boolean;
  onSelectedChange?: (selected: boolean) => void;
  selectionDisabled?: boolean;
  /** When true, show IDs / workflow / raw decision like before. */
  developerMode?: boolean;
  onRequestApprove?: (args: ApprovalRequestApproveArgs) => void;
  onResolved?: (approvalId: string) => void;
  onNeedsRefresh?: () => void;
  /** Neighbor-feed page AI draft status (parent auto/batch generate). */
  neighborAiStatus?: "idle" | "generating" | "ready" | "failed";
  neighborAiError?: string | null;
  onNeighborDraftBodyChange?: (body: string) => void;
  /** Request AI draft for this card only (when not auto-generated). */
  onNeighborAiGenerate?: () => void;
  /** Deep-link preferred execute mode (like | comment | both). */
  preferredMode?: ApprovalExecuteMode;
};

function initialMode(item: ApprovalInboxItem): ApprovalExecuteMode {
  const stored = item.approval.presented_context?.last_execute_mode;
  if (item.availableModes.length > 0) {
    return parseApprovalExecuteMode(
      typeof stored === "string" ? stored : undefined,
      defaultApprovalExecuteMode(item.availableModes),
    );
  }
  return "comment";
}

export function ApprovalCard({
  item,
  selected = false,
  onSelectedChange,
  selectionDisabled = false,
  developerMode = false,
  onRequestApprove,
  onResolved,
  onNeedsRefresh,
  neighborAiStatus,
  neighborAiError,
  onNeighborDraftBodyChange,
  onNeighborAiGenerate,
  preferredMode,
}: ApprovalCardProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.draftBody);
  const [savedHint, setSavedHint] = useState(false);
  const [regenHint, setRegenHint] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [failModalOpen, setFailModalOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [mode, setMode] = useState<ApprovalExecuteMode>(() =>
    preferredMode && item.availableModes.includes(preferredMode)
      ? preferredMode
      : initialMode(item),
  );
  const [situation, setSituation] = useState<CommentSituation>(
    () => item.commentSituation ?? "공감",
  );

  useEffect(() => {
    setDraft(item.draftBody);
  }, [item.draftBody, item.approval.id]);

  useEffect(() => {
    if (!preferredMode) return;
    if (!item.availableModes.includes(preferredMode)) return;
    setMode(preferredMode);
  }, [preferredMode, item.approval.id, item.availableModes]);

  async function refreshBriefCache() {
    await queryClient.invalidateQueries({ queryKey: queryKeys.agentBrief });
    await queryClient.fetchQuery({
      queryKey: queryKeys.agentBrief,
      queryFn: () => getAgentBriefAction(),
    });
    router.refresh();
  }

  function run(action: () => Promise<void>) {
    start(async () => {
      await action();
      await refreshBriefCache();
    });
  }

  const isNeighborFeed = isNeighborFeedInboxItem(item);
  const needsAiPreview = needsNeighborFeedAiDraft(
    neighborFeedDraftProbeFromInboxItem({
      source: item.source,
      draftBody: draft,
      job: item.job,
      approval: item.approval,
    }),
  );
  const aiStatus =
    neighborAiStatus ??
    (needsAiPreview
      ? "idle"
      : draft.trim()
        ? "ready"
        : "idle");
  const displayDraft = developerMode
    ? draft
    : isNeighborFeed && (aiStatus === "generating" || aiStatus === "idle")
      ? needsAiPreview
        ? ""
        : operatorDraftBody(draft) || draft
      : isNeighborFeed && needsAiPreview
        ? ""
        : operatorDraftBody(draft) || draft;
  const recommendReasons = operatorRecommendReasons(item);
  const busy = pending || selectionDisabled;
  const showModes = item.availableModes.length > 0;
  const errorMessage = item.job.error?.trim() || "알 수 없는 오류";
  const friendly = toFriendlyFailure(errorMessage, item.job.action_type);
  const failStage = friendly.stage;
  const failAt =
    typeof item.job.target_ref?.last_failed_at === "string"
      ? item.job.target_ref.last_failed_at
      : item.job.updated_at;
  const testRunId = extractTestRunId(item);
  const publishedLabel = operatorPublishedDate(item);
  const authorName = developerMode
    ? item.mutualRequest?.blogName ?? item.person.display_name
    : operatorAuthorName(item);
  const postTitle = developerMode
    ? item.postTitle?.trim() || authorName
    : operatorPostTitle(item);
  const isComment = item.job.action_type === "comment";
  const isFailed =
    !item.approval.resolved_at && item.job.status === "failed";

  return (
    <article
      className={`rounded-xl border bg-card p-4 ${
        selected
          ? "border-foreground/40"
          : isFailed
            ? "border-destructive/40"
            : "border-border/70"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          {onSelectedChange ? (
            <input
              type="checkbox"
              className="mt-1 size-4 shrink-0 rounded border-border"
              checked={selected}
              disabled={selectionDisabled || isFailed}
              aria-label={`${postTitle} 선택`}
              onChange={(e) => onSelectedChange(e.target.checked)}
            />
          ) : null}
          <div className="min-w-0">
            {isNeighborFeed ? (
              <p className="text-[11px] font-medium text-muted-foreground">
                [이웃 새글]
              </p>
            ) : null}
            {isNeighborFeed ? (
              <>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {authorName}
                </p>
                <h2 className="mt-0.5 text-base font-semibold tracking-tight leading-snug">
                  {postTitle}
                </h2>
                {publishedLabel ? (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    작성일 {publishedLabel}
                  </p>
                ) : null}
                {item.postSummary?.trim() ? (
                  <p className="mt-1.5 line-clamp-3 text-xs leading-relaxed text-muted-foreground">
                    {item.postSummary.trim()}
                  </p>
                ) : null}
              </>
            ) : (
              <>
                <h2 className="text-base font-semibold tracking-tight leading-snug">
                  {postTitle}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">{authorName}</p>
                {publishedLabel ? (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    작성일 {publishedLabel}
                  </p>
                ) : null}
              </>
            )}
            {developerMode ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {item.actionLabel} · {item.job.channel}
                {item.hasBundledLike ? " · 공감 묶음" : ""}
                {isNeighborFeed ? " · neighbor_feed" : ""} ·{" "}
                {item.workflow.current_stage} · priority{" "}
                {item.approval.inbox_priority}
              </p>
            ) : null}
          </div>
        </div>
      </div>

      {isFailed ? (
        <div className="mt-3 space-y-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5">
            <p className="text-sm font-semibold text-destructive">
              {item.job.action_type === "neighbor_request"
                ? "🔴 서로이웃 추가 실패"
                : "🔴 처리실패"}
            </p>
          <Button
            type="button"
            variant="outline"
            className="w-full border-destructive/40 text-destructive hover:bg-destructive/10"
            onClick={() => setFailModalOpen(true)}
          >
            처리실패 이유 보기
          </Button>
        </div>
      ) : null}

      {/* 왜 추천했나요? — skip for neighbor_feed (collect metadata only) */}
      {!isNeighborFeed ? (
        <div className="mt-3 rounded-lg border border-border/50 bg-secondary/40 px-3 py-2.5">
          <p className="text-[11px] font-medium text-muted-foreground">
            왜 추천했나요?
          </p>
          <ul className="mt-1.5 space-y-1">
            {(developerMode && item.decisionExplain
              ? [
                  item.decisionExplain.explanation,
                  ...item.decisionExplain.reasons,
                ].filter(Boolean)
              : recommendReasons
            ).map((r, i) => (
              <li
                key={`${item.approval.id}-why-${i}`}
                className="flex gap-2 text-sm text-foreground/85"
              >
                <span className="text-muted-foreground">•</span>
                <span>{r}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {isNeighborFeed && isComment && !isFailed ? (
        <div className="mt-3 space-y-2">
          <p className="text-[11px] font-medium text-muted-foreground">
            {aiStatus === "generating"
              ? "🟡 댓글 생성 중"
              : aiStatus === "ready" || (displayDraft && !needsAiPreview)
                ? "🟢 댓글 준비 완료"
                : aiStatus === "failed"
                  ? "🔴 생성 실패"
                  : "⚪ 댓글 대기"}
          </p>
          {(neighborAiError || previewError) ? (
            <div className="space-y-0.5">
              <p className="text-xs text-destructive">
                원인: {neighborAiError || previewError}
              </p>
            </div>
          ) : null}
          {displayDraft && aiStatus !== "generating" ? (
            <div>
              <p className="mb-1 text-[11px] font-medium text-muted-foreground">
                추천 댓글
              </p>
              {editing ? (
                <textarea
                  value={draft}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    onNeighborDraftBodyChange?.(e.target.value);
                  }}
                  rows={3}
                  className="w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm leading-relaxed outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
                />
              ) : (
                <blockquote className="rounded-lg bg-secondary/70 px-3 py-2 text-sm leading-relaxed">
                  {displayDraft}
                </blockquote>
              )}
            </div>
          ) : aiStatus === "generating" ? (
            <p className="text-[11px] text-muted-foreground">
              초안을 만드는 중… 완료되면 바로 표시됩니다.
            </p>
          ) : (
            <div className="space-y-2">
              <p className="text-[11px] text-muted-foreground">
                아직 초안이 없습니다. 필요하면 생성해 주세요.
              </p>
              {onNeighborAiGenerate ? (
                <Button
                  variant="secondary"
                  size="sm"
                  className="w-full"
                  disabled={busy}
                  onClick={() => {
                    setPreviewError(null);
                    onNeighborAiGenerate();
                  }}
                >
                  {aiStatus === "failed" ? "다시 생성" : "댓글 초안 생성"}
                </Button>
              ) : null}
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="outline"
              className="w-full"
              disabled={busy || aiStatus === "generating" || !draft.trim()}
              onClick={() => {
                if (editing) {
                  run(async () => {
                    await saveApprovalDraftAction(item.approval.id, draft);
                    setEditing(false);
                    setSavedHint(true);
                    onNeighborDraftBodyChange?.(draft);
                  });
                } else {
                  setEditing(true);
                }
              }}
            >
              {editing ? "저장" : "댓글 수정"}
            </Button>
            <Button
              variant="secondary"
              className="w-full"
              disabled={busy || aiStatus === "generating"}
              onClick={() => {
                if (onNeighborAiGenerate && (aiStatus === "failed" || aiStatus === "idle")) {
                  onNeighborAiGenerate();
                  return;
                }
                run(async () => {
                  setPreviewError(null);
                  const result = await previewNeighborFeedCommentAction(
                    item.approval.id,
                    situation,
                  );
                  if (result.success) {
                    setDraft(result.body);
                    setSituation(
                      result.situation as CommentSituation,
                    );
                    setEditing(false);
                    onNeighborDraftBodyChange?.(result.body);
                    onNeedsRefresh?.();
                  } else {
                    setPreviewError(result.message);
                  }
                });
              }}
            >
              {aiStatus === "failed" ? "다시 생성" : "재생성"}
            </Button>
          </div>
          {savedHint ? (
            <p className="text-[11px] text-muted-foreground">
              초안이 저장되었습니다.
            </p>
          ) : null}
        </div>
      ) : null}

      {isComment && !isFailed && !isNeighborFeed ? (
        <fieldset className="mt-3 space-y-2">
          <legend className="text-[11px] font-medium text-muted-foreground">
            상황
          </legend>
          <div className="flex flex-wrap gap-2">
            {COMMENT_SITUATIONS.map((s) => (
              <label
                key={s}
                className={`cursor-pointer rounded-lg border px-2.5 py-1.5 text-xs ${
                  situation === s
                    ? "border-foreground/50 bg-secondary"
                    : "border-border/60 text-muted-foreground"
                }`}
              >
                <input
                  type="radio"
                  className="sr-only"
                  name={`situation-${item.approval.id}`}
                  checked={situation === s}
                  disabled={busy}
                  onChange={() => {
                    setSituation(s);
                    setRegenHint(null);
                    start(async () => {
                      await saveApprovalCommentSituationAction(
                        item.approval.id,
                        s,
                      );
                    });
                  }}
                />
                {s}
              </label>
            ))}
          </div>
          <Button
            variant="secondary"
            className="w-full"
            disabled={busy}
            onClick={() =>
              run(async () => {
                const result = await regenerateApprovalCommentDraftAction(
                  item.approval.id,
                  situation,
                );
                setDraft(result.body);
                setSituation(result.situation);
                setRegenHint(
                  developerMode
                    ? `초안 재생성 · ${result.source}`
                    : "초안을 다시 만들었습니다",
                );
                setEditing(true);
              })
            }
          >
            이 상황으로 AI 초안 다시 생성
          </Button>
          {regenHint ? (
            <p className="text-[11px] text-muted-foreground">{regenHint}</p>
          ) : null}
        </fieldset>
      ) : null}

      {showModes ? (
        <fieldset className="mt-3 space-y-2">
          <legend className="text-[11px] font-medium text-muted-foreground">
            처리 유형
          </legend>
          <div className="flex flex-wrap gap-2">
            {item.availableModes.map((m) => (
              <label
                key={m}
                className={`cursor-pointer rounded-lg border px-2.5 py-1.5 text-xs ${
                  mode === m
                    ? "border-foreground/50 bg-secondary"
                    : "border-border/60 text-muted-foreground"
                }`}
              >
                <input
                  type="radio"
                  className="sr-only"
                  name={`mode-${item.approval.id}`}
                  checked={mode === m}
                  disabled={busy}
                  onChange={() => setMode(m)}
                />
                {approvalModeLabel(m)}
              </label>
            ))}
          </div>
        </fieldset>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">
          처리 유형: {item.actionLabel}
        </p>
      )}

      {isFailed ? (
        <div className="mt-3 space-y-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            className="w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm leading-relaxed outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
            placeholder="재시도에 사용할 초안"
          />
          <div className="grid grid-cols-2 gap-2">
            <Button
              className="w-full"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await retryFailedApprovalAction(item.approval.id, {
                    draftBody: draft,
                    mode: showModes ? mode : undefined,
                  });
                  onNeedsRefresh?.();
                })
              }
            >
              재시도
            </Button>
            <Button
              variant="outline"
              className="w-full"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await rejectApprovalAction(
                    item.approval.id,
                    "supervisor_reject",
                  );
                  onResolved?.(item.approval.id);
                })
              }
            >
              거절
            </Button>
          </div>
        </div>
      ) : editing && !isNeighborFeed ? (
        <div className="mt-3 space-y-2">
          <p className="text-[11px] font-medium text-muted-foreground">
            AI 댓글 초안
          </p>
          <textarea
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setSavedHint(false);
            }}
            rows={4}
            className="w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm leading-relaxed outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
            placeholder="초안을 수정하세요"
          />
          {savedHint ? (
            <p className="text-[11px] text-muted-foreground">
              초안이 저장되었습니다.
            </p>
          ) : null}
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="secondary"
              className="w-full"
              disabled={busy || !draft.trim()}
              onClick={() =>
                run(async () => {
                  await saveApprovalDraftAction(item.approval.id, draft);
                  setSavedHint(true);
                })
              }
            >
              저장
            </Button>
            <Button
              className="w-full"
              disabled={busy || !draft.trim()}
              onClick={() =>
                onRequestApprove?.({
                  approvalId: item.approval.id,
                  draftBody: draft,
                  mode: showModes ? mode : undefined,
                })
              }
            >
              승인
            </Button>
            <Button
              variant="ghost"
              className="col-span-2 w-full"
              disabled={busy}
              onClick={() => {
                setDraft(item.draftBody);
                setEditing(false);
                setSavedHint(false);
              }}
            >
              편집 취소
            </Button>
          </div>
        </div>
      ) : (
        <>
          {!isNeighborFeed ? (
            displayDraft ? (
              <div className="mt-3">
                <p className="mb-1 text-[11px] font-medium text-muted-foreground">
                  AI 댓글 초안
                </p>
                <blockquote className="rounded-lg bg-secondary/70 px-3 py-2 text-sm leading-relaxed">
                  {displayDraft}
                </blockquote>
              </div>
            ) : (
              <p className="mt-3 text-xs text-muted-foreground">
                초안이 없습니다. 수정 후 승인에서 작성할 수 있습니다.
              </p>
            )
          ) : null}

          <div className="mt-4 grid grid-cols-2 gap-2">
            <Button
              className="w-full"
              disabled={busy}
              onClick={() =>
                onRequestApprove?.({
                  approvalId: item.approval.id,
                  // Neighbor feed: let execute path generate/reuse AI (don't send template)
                  draftBody:
                    isNeighborFeed && needsAiPreview
                      ? undefined
                      : isNeighborFeed
                        ? draft
                        : undefined,
                  mode: showModes ? mode : undefined,
                })
              }
            >
              {isNeighborFeed ? "실행" : "승인"}
            </Button>
            <Button
              variant="outline"
              className="w-full"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await rejectApprovalAction(
                    item.approval.id,
                    "supervisor_reject",
                  );
                  onResolved?.(item.approval.id);
                })
              }
            >
              거절
            </Button>
            <Button
              variant="secondary"
              className="w-full"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await snoozeApprovalAction(item.approval.id);
                  onNeedsRefresh?.();
                })
              }
            >
              보류
            </Button>
            <Button
              variant="ghost"
              className="w-full"
              disabled={busy}
              onClick={() => {
                setDraft(item.draftBody);
                setEditing(true);
              }}
            >
              수정 후 승인
            </Button>
          </div>
        </>
      )}

      <div className="mt-3 border-t border-border/50 pt-2">
        <button
          type="button"
          className="text-xs font-medium text-muted-foreground underline-offset-2 hover:underline"
          onClick={() => setDetailsOpen((v) => !v)}
        >
          {detailsOpen || developerMode ? "상세 접기" : "상세 보기"}
        </button>
        {detailsOpen || developerMode ? (
          <dl className="mt-2 space-y-1.5 rounded-lg bg-secondary/40 px-3 py-2.5 font-mono text-[11px] text-muted-foreground">
            <div className="flex justify-between gap-2 break-all">
              <dt>approval_id</dt>
              <dd>{item.approval.id}</dd>
            </div>
            <div className="flex justify-between gap-2 break-all">
              <dt>job_id</dt>
              <dd>{item.job.id}</dd>
            </div>
            <div className="flex justify-between gap-2 break-all">
              <dt>bundle_id</dt>
              <dd>{item.bundleId ?? "-"}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt>priority</dt>
              <dd>{item.approval.inbox_priority}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt>workflow</dt>
              <dd>{item.workflow.current_stage}</dd>
            </div>
            <div className="flex justify-between gap-2 break-all">
              <dt>decision</dt>
              <dd>{item.decisionExplain?.decisionId ?? "-"}</dd>
            </div>
            <div className="flex justify-between gap-2 break-all">
              <dt>test_run_id</dt>
              <dd>{testRunId ?? "-"}</dd>
            </div>
            {developerMode && item.reasonShort ? (
              <div className="flex justify-between gap-2 break-all">
                <dt>reason_short</dt>
                <dd>{item.reasonShort}</dd>
              </div>
            ) : null}
          </dl>
        ) : null}
      </div>

      {failModalOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center"
          role="dialog"
          aria-modal="true"
          aria-labelledby="fail-modal-title"
          onClick={() => setFailModalOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-border bg-background p-4 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <h3
              id="fail-modal-title"
              className="text-base font-semibold tracking-tight"
            >
              처리 실패 이유
            </h3>
            <p className="mt-3 text-sm font-medium">{friendly.cause}</p>
            <p className="mt-2 text-sm text-foreground/85">{friendly.detail}</p>
            <p className="mt-3 text-xs text-muted-foreground">
              {formatApprovalFailureTime(failAt)} ·{" "}
              {approvalFailureStageLabel(failStage)}
            </p>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                className="w-full"
                onClick={() => setFailModalOpen(false)}
              >
                닫기
              </Button>
              <Button
                className="w-full"
                disabled={busy}
                onClick={() => {
                  setFailModalOpen(false);
                  run(async () => {
                    await retryFailedApprovalAction(item.approval.id, {
                      draftBody: draft,
                      mode: showModes ? mode : undefined,
                    });
                    onNeedsRefresh?.();
                  });
                }}
              >
                재시도
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </article>
  );
}
