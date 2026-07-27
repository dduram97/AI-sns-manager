"use client";

import { Button } from "@/components/ui/button";
import { neighborRecommendGrade } from "@/lib/neighborAiDisplay";
import type { NeighborCandidate } from "@/types/neighborScreen";

type NeighborCandidateCardProps = {
  candidate: NeighborCandidate;
  selected: boolean;
  selectionDisabled: boolean;
  requestDisabled: boolean;
  excludeDisabled: boolean;
  failReason: string | null;
  onToggleSelect: (checked: boolean) => void;
  onRequest: () => void;
  onExclude: () => void;
  onShowFailReason: () => void;
};

export function NeighborCandidateCard({
  candidate,
  selected,
  selectionDisabled,
  requestDisabled,
  excludeDisabled,
  failReason,
  onToggleSelect,
  onRequest,
  onExclude,
  onShowFailReason,
}: NeighborCandidateCardProps) {
  const grade = neighborRecommendGrade(candidate.recommendScore);
  const topReasons = candidate.recommendReasons.slice(0, 2);

  return (
    <article className="rounded-xl border border-border/70 bg-card p-4">
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          className="mt-1 size-4"
          checked={selected}
          disabled={selectionDisabled}
          onChange={(e) => onToggleSelect(e.target.checked)}
        />
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold leading-snug">
            {candidate.blogName}
          </h2>

          <p className="mt-2 text-sm text-muted-foreground">
            최근 활동 · {candidate.lastActivityLabel}
          </p>

          <p className="mt-1 text-sm text-foreground/90">
            추천 단계 ·{" "}
            {grade.emoji ? `${grade.emoji} ${grade.label}` : grade.label || "검토"}
          </p>

          {topReasons.length > 0 ? (
            <ul className="mt-3 space-y-1">
              {topReasons.map((reason) => (
                <li key={reason} className="text-sm text-foreground/85">
                  ✅ {reason}
                </li>
              ))}
            </ul>
          ) : null}

          {candidate.alreadyRequested ? (
            <p className="mt-2 text-xs text-destructive">
              이미 서로이웃 처리한 블로그
            </p>
          ) : null}
          {candidate.hasOpenApproval ? (
            <p className="mt-2 text-xs text-muted-foreground">승인 대기 중</p>
          ) : null}
          {failReason ? (
            <div className="mt-2 space-y-1">
              <p className="text-xs font-medium text-destructive">🔴 신청 실패</p>
              <button
                type="button"
                className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                onClick={onShowFailReason}
              >
                실패 이유 보기
              </button>
            </div>
          ) : null}

          <Button
            className="mt-4 w-full"
            disabled={requestDisabled}
            onClick={onRequest}
          >
            서로이웃 신청
          </Button>

          <details className="mt-3 rounded-lg border border-border/60 bg-secondary/20 px-3 py-2">
            <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
              상세보기
            </summary>
            <div className="mt-3 space-y-2 text-xs text-muted-foreground">
              <p>
                닉네임 · {candidate.nickname} · {candidate.blogId}
              </p>
              <p>분야 · {candidate.category}</p>
              <p>
                키워드 일치율 {candidate.keywordMatchRate}% · 광고성{" "}
                {candidate.adScore}점
              </p>
              <p>
                추천 점수 {candidate.recommendScore}점
                {grade.label ? ` (${grade.label})` : ""}
              </p>
              {candidate.recommendReasons.length > topReasons.length ? (
                <ul className="space-y-1">
                  {candidate.recommendReasons.slice(topReasons.length).map((reason) => (
                    <li key={reason} className="text-foreground/85">
                      ✅ {reason}
                    </li>
                  ))}
                </ul>
              ) : null}
              <Button
                variant="outline"
                size="sm"
                className="mt-2 w-full"
                disabled={excludeDisabled}
                onClick={onExclude}
              >
                제외
              </Button>
            </div>
          </details>
        </div>
      </div>
    </article>
  );
}
