"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { AppModal } from "@/components/ui/AppModal";
import {
  formatNeighborSearchRankLabel,
  neighborAdPassLabel,
  neighborCollectSourceBadges,
  neighborCollectSourceModalLabel,
  neighborDormantLabel,
  naverKeywordSearchUrl,
} from "@/lib/neighborCandidateDisplay";
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

function SourceBadge({ label }: { label: "NAVER" | "CDP" | "BOTH" }) {
  return (
    <span
      className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold tracking-wide ${
        label === "NAVER"
          ? "bg-sky-500/15 text-sky-800 dark:text-sky-200"
          : label === "CDP"
            ? "bg-violet-500/15 text-violet-800 dark:text-violet-200"
            : "bg-amber-500/15 text-amber-800 dark:text-amber-200"
      }`}
    >
      {label}
    </span>
  );
}

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
  const [detailOpen, setDetailOpen] = useState(false);
  const blogUrl =
    candidate.blogUrl?.trim() ||
    (candidate.blogId.trim()
      ? `https://blog.naver.com/${candidate.blogId.trim()}`
      : null);

  const rankLabel = formatNeighborSearchRankLabel(
    candidate.collectSource,
    candidate.searchRank,
  );
  const sourceBadges = neighborCollectSourceBadges(candidate.collectSource);
  const displayKeyword =
    candidate.searchKeyword ??
    candidate.scoreBreakdown.find((line) => line.label === "키워드")?.detail ??
    null;
  const displayRank =
    candidate.scoreBreakdown.find((line) => line.label === "검색순위")?.detail ??
    rankLabel;

  return (
    <>
      <article className="rounded-xl border border-border/70 bg-card p-4">
        <div className="flex items-start gap-3">
          <input
            type="checkbox"
            className="mt-1 size-4 shrink-0"
            checked={selected}
            disabled={selectionDisabled}
            onChange={(e) => onToggleSelect(e.target.checked)}
          />
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold leading-snug">
              {blogUrl ? (
                <a
                  href={blogUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline-offset-2 hover:underline"
                >
                  {candidate.blogName}
                </a>
              ) : (
                candidate.blogName
              )}
            </h2>

            {displayKeyword ? (
              <p className="mt-2 text-sm font-semibold leading-snug">
                <a
                  href={naverKeywordSearchUrl(displayKeyword)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-foreground underline-offset-2 hover:underline"
                >
                  {displayKeyword}
                </a>
              </p>
            ) : null}

            <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold tracking-tight text-primary">
                {displayRank}
              </p>
              <div className="flex items-center gap-2">
                <div className="flex flex-wrap gap-1">
                  {sourceBadges.map((badge) => (
                    <SourceBadge key={badge} label={badge} />
                  ))}
                </div>
                <p className="text-lg font-semibold tabular-nums tracking-tight">
                  {candidate.recommendScore}
                  <span className="text-xs font-medium text-muted-foreground">
                    점
                  </span>
                </p>
              </div>
            </div>

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
                <p className="text-xs font-medium text-destructive">
                  🔴 신청 실패
                </p>
                <button
                  type="button"
                  className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                  onClick={onShowFailReason}
                >
                  실패 이유 보기
                </button>
              </div>
            ) : null}

            <div className="mt-3 grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                className="w-full"
                onClick={() => setDetailOpen(true)}
              >
                상세
              </Button>
              <Button
                className="w-full"
                disabled={requestDisabled}
                onClick={onRequest}
              >
                서로이웃 신청
              </Button>
            </div>
          </div>
        </div>
      </article>

      <AppModal
        open={detailOpen}
        title="추천 상세"
        onClose={() => setDetailOpen(false)}
        footer={null}
      >
        <div className="space-y-4 text-sm">
          <section>
            <p className="text-[11px] font-medium text-muted-foreground">
              추천 근거 · 검색 키워드
            </p>
            {displayKeyword ? (
              <a
                href={naverKeywordSearchUrl(displayKeyword)}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 block font-medium underline-offset-2 hover:underline"
              >
                {displayKeyword}
              </a>
            ) : (
              <p className="mt-1 text-muted-foreground">—</p>
            )}
          </section>

          <section>
            <p className="text-[11px] font-medium text-muted-foreground">
              검색 순위
            </p>
            <p className="mt-1 font-medium">{displayRank}</p>
          </section>

          <section>
            <p className="text-[11px] font-medium text-muted-foreground">
              추천 출처
            </p>
            <p className="mt-1 font-medium">
              {neighborCollectSourceModalLabel(candidate.collectSource)}
            </p>
          </section>

          <section>
            <p className="text-[11px] font-medium text-muted-foreground">
              최근 활동
            </p>
            <p className="mt-1 font-medium">{candidate.lastActivityLabel}</p>
          </section>

          <section>
            <p className="text-[11px] font-medium text-muted-foreground">
              광고 여부
            </p>
            <p className="mt-1 font-medium">
              {neighborAdPassLabel(candidate.adScore)}
            </p>
          </section>

          <section>
            <p className="text-[11px] font-medium text-muted-foreground">
              휴면 여부
            </p>
            <p className="mt-1 font-medium">
              {neighborDormantLabel(
                candidate.recentlyActive,
                candidate.lastActivityLabel,
              )}
            </p>
          </section>

          <section>
            <p className="text-[11px] font-medium text-muted-foreground">
              점수 계산
            </p>
            <ul className="mt-2 space-y-1">
              {candidate.scoreBreakdown.map((line) => (
                <li key={`${line.label}-${line.detail ?? ""}`} className="tabular-nums">
                  {line.delta >= 0 ? "+" : ""}
                  {line.delta} {line.label}
                  {line.detail ? (
                    <span className="text-foreground/85"> · {line.detail}</span>
                  ) : null}
                </li>
              ))}
              <li className="pt-1 font-semibold tabular-nums">
                최종 {candidate.recommendScore}점
              </li>
            </ul>
          </section>

          <Button
            variant="outline"
            className="w-full"
            disabled={excludeDisabled}
            onClick={() => {
              setDetailOpen(false);
              onExclude();
            }}
          >
            제외
          </Button>
        </div>
      </AppModal>
    </>
  );
}
