"use client";

import { AppModal } from "@/components/ui/AppModal";
import { Button } from "@/components/ui/button";

export type ReplyVisitProgressPhase =
  | "running"
  | "success"
  | "partial"
  | "failed";

export type ReplyVisitProgressState = {
  open: boolean;
  phase: ReplyVisitProgressPhase;
  title: string;
  current: number;
  total: number;
  currentLabel: string;
  successCount: number;
  failCount: number;
};

export const EMPTY_REPLY_VISIT_PROGRESS: ReplyVisitProgressState = {
  open: false,
  phase: "running",
  title: "답방 진행 중입니다",
  current: 0,
  total: 0,
  currentLabel: "",
  successCount: 0,
  failCount: 0,
};

export function ReplyVisitProgressModal({
  state,
  onClose,
}: {
  state: ReplyVisitProgressState;
  onClose: () => void;
}) {
  const canClose = state.phase !== "running";
  const subtitle =
    state.phase === "running"
      ? `현재: ${state.current} / ${state.total} 완료`
      : state.phase === "success"
        ? "답방 완료되었습니다"
        : state.phase === "partial"
          ? "일부 답방 실패"
          : "답방 실패";

  return (
    <AppModal
      open={state.open}
      title={state.phase === "running" ? state.title : subtitle}
      onClose={canClose ? onClose : () => {}}
      showCloseButton={canClose}
      footer={
        canClose ? (
          <Button type="button" className="w-full" onClick={onClose}>
            확인
          </Button>
        ) : null
      }
    >
      <div className="space-y-3 text-sm">
        {state.phase === "running" ? (
          <>
            <p className="tabular-nums text-muted-foreground">
              현재: {state.current} / {state.total} 완료
            </p>
            <p className="font-medium text-foreground">
              처리중: {state.currentLabel || "준비 중…"}
            </p>
            <div className="h-2 overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{
                  width: `${
                    state.total > 0
                      ? Math.min(100, (state.current / state.total) * 100)
                      : 0
                  }%`,
                }}
              />
            </div>
          </>
        ) : (
          <>
            <p className="text-muted-foreground">
              성공 {state.successCount} · 실패 {state.failCount}
              {state.total > 0 ? ` · 전체 ${state.total}` : ""}
            </p>
            {state.currentLabel ? (
              <p className="text-xs text-muted-foreground">{state.currentLabel}</p>
            ) : null}
          </>
        )}
      </div>
    </AppModal>
  );
}
