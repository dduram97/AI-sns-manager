"use client";

import { useEffect, useState, useTransition } from "react";
import {
  prepareReplyCommentDraftAction,
  regenerateReplyCommentDraftAction,
  submitReplyCommentDraftAction,
} from "@/app/actions/replyVisitTasks";
import { AppModal } from "@/components/ui/AppModal";
import { Button } from "@/components/ui/button";
import type { ReplyCommentDraft } from "@/services/replyVisitCommentDraftService";
import type { ReplyVisitTaskItem } from "@/services/replyVisitTaskService";

function draftHumanError(code: string): string {
  if (code === "draft_already_executed") return "이미 등록된 댓글입니다.";
  if (code === "draft_submit_in_progress") {
    return "댓글 등록이 이미 진행 중입니다.";
  }
  if (code === "comment_empty") return "댓글 내용을 입력해주세요.";
  if (/session_|needs_relogin|login required|LOGIN_REQUIRED|relogin/i.test(code)) {
    return "네이버 로그인이 필요합니다. 세션을 확인해주세요.";
  }
  if (/timeout|TIMEOUT/i.test(code)) {
    return "네이버 응답이 지연되었습니다. 잠시 후 다시 시도해주세요.";
  }
  if (/duplicate_target_action/i.test(code)) {
    return "같은 글에 최근 실행한 이력이 있어 중복 등록을 막았습니다.";
  }
  return code;
}

export function ReplyVisitCommentDraftModal({
  open,
  item,
  onClose,
  onSubmitted,
}: {
  open: boolean;
  item: ReplyVisitTaskItem | null;
  onClose: () => void;
  onSubmitted?: (item: ReplyVisitTaskItem) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [loading, setLoading] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [draft, setDraft] = useState<ReplyCommentDraft | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !item) {
      setDraft(null);
      setText("");
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    void prepareReplyCommentDraftAction({
      taskId: item.id,
      relationId: item.relationId ?? undefined,
      personId: item.personId || undefined,
      blogId: item.blogId,
      regenerate: false,
    })
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          setError(draftHumanError(result.error));
          return;
        }
        setDraft(result.draft);
        setText(result.draft.editedComment || result.draft.generatedComment);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, item]);

  if (!item) return null;

  const postUrl =
    draft?.postUrl ||
    item.latestPostUrl?.trim() ||
    `https://blog.naver.com/${encodeURIComponent(item.blogId)}`;
  const postTitle = draft?.postTitle || item.latestPostTitle || "최신글";

  function handleRegenerate() {
    if (!item || regenerating || submitting) return;
    setRegenerating(true);
    setError(null);
    startTransition(async () => {
      const result = await regenerateReplyCommentDraftAction({
        taskId: item.id,
        relationId: item.relationId ?? undefined,
        personId: item.personId || undefined,
        blogId: item.blogId,
      });
      setRegenerating(false);
      if (!result.ok) {
        setError(draftHumanError(result.error));
        return;
      }
      setDraft(result.draft);
      setText(result.draft.editedComment || result.draft.generatedComment);
    });
  }

  function handleSubmit() {
    if (!item || !draft || submitting || regenerating) return;
    const body = text.trim();
    if (!body) {
      setError("댓글 내용을 입력해주세요.");
      return;
    }
    const currentItem = item;
    setSubmitting(true);
    setError(null);
    startTransition(async () => {
      const result = await submitReplyCommentDraftAction({
        draftId: draft.id,
        editedComment: body,
      });
      setSubmitting(false);
      if (!result.ok) {
        setError(draftHumanError(result.error));
        return;
      }
      onSubmitted?.(currentItem);
      onClose();
    });
  }

  const busy = loading || pending || regenerating || submitting;

  return (
    <AppModal
      open={open}
      title="답방 댓글 작성"
      onClose={busy && submitting ? () => {} : onClose}
      showCloseButton={!submitting}
      className="max-w-lg"
      footer={
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            className="flex-1"
            disabled={busy}
            onClick={onClose}
          >
            닫기
          </Button>
          <Button
            type="button"
            variant="outline"
            className="flex-1"
            disabled={busy || loading}
            onClick={handleRegenerate}
          >
            {regenerating ? "생성 중…" : "다시 생성"}
          </Button>
          <Button
            type="button"
            className="flex-1"
            disabled={busy || loading || !draft}
            onClick={handleSubmit}
          >
            {submitting ? "등록 중…" : "등록하기"}
          </Button>
        </div>
      }
    >
      <div className="space-y-3 text-sm">
        <div className="rounded-lg border border-border/60 bg-secondary/20 p-3">
          <p className="font-semibold tracking-tight">{item.blogName}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">@{item.blogId}</p>
          <p className="mt-2 text-xs text-muted-foreground">상대방 글</p>
          <p className="mt-0.5 line-clamp-2 font-medium">{postTitle}</p>
          <a
            href={postUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 inline-block text-xs text-primary underline-offset-2 hover:underline"
          >
            글 보기
          </a>
        </div>

        {loading ? (
          <p className="text-muted-foreground">AI 추천 댓글 생성 중…</p>
        ) : (
          <>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                AI 추천 댓글 (수정 가능)
              </span>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={5}
                disabled={busy}
                className="w-full resize-y rounded-lg border border-border/70 bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30"
                placeholder="댓글 내용을 입력하세요"
              />
            </label>
            <p className="text-[11px] text-muted-foreground">
              등록하기를 누르기 전에는 네이버에 댓글이 올라가지 않습니다.
            </p>
          </>
        )}

        {error ? (
          <p className="text-[11px] text-destructive">{error}</p>
        ) : null}
      </div>
    </AppModal>
  );
}
