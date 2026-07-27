"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  buildNeighborFeedPersonLink,
  daysSince,
  formatDaysAgoKo,
  getNeighborNextActionRec,
  getNeighborOpsHealth,
} from "@/lib/neighborManageListUtils";
import { cn } from "@/lib/utils";
import type { NeighborManageDetailView } from "@/types/neighborManage";

const HISTORY_PREVIEW = 5;

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border/70 bg-card p-4">
      <h2 className="text-xs font-medium text-muted-foreground">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function StatusLine({
  label,
  days,
}: {
  label: string;
  days: number | null;
}) {
  return (
    <div className="flex justify-between gap-3 border-b border-border/40 py-1.5 text-sm last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums font-medium">
        {formatDaysAgoKo(days)}
      </span>
    </div>
  );
}

export function NeighborManageDetail({
  data,
  onBack,
}: {
  data: NeighborManageDetailView;
  onBack: () => void;
}) {
  const { person, relationship } = data;
  const [historyOpen, setHistoryOpen] = useState(false);

  const title = data.blogName ?? data.nickname ?? person.display_name;

  const health = useMemo(
    () =>
      getNeighborOpsHealth({
        lastVisitAt: relationship.last_visit_at,
        lastLikeAt: relationship.last_like_at,
        lastCommentAt: relationship.last_comment_at,
        lastTouchAt: relationship.last_touch_at,
        lastPostAt: data.lastPostAt,
      }),
    [relationship, data.lastPostAt],
  );

  const nextAction = useMemo(
    () =>
      getNeighborNextActionRec({
        lastVisitAt: relationship.last_visit_at,
        lastLikeAt: relationship.last_like_at,
        lastCommentAt: relationship.last_comment_at,
        lastPostAt: data.lastPostAt,
      }),
    [relationship, data.lastPostAt],
  );

  const daysVisit = daysSince(relationship.last_visit_at);
  const daysLike = daysSince(relationship.last_like_at);
  const daysComment = daysSince(relationship.last_comment_at);
  const daysPost = daysSince(data.lastPostAt);

  const historyItems = useMemo(() => {
    const rows: Array<{ id: string; label: string; at: string | null }> = [
      ...data.recentCareActions.map((a) => ({
        id: `job-${a.id}`,
        label: a.label,
        at: a.executedAt,
      })),
      ...data.relationChanges.map((c) => ({
        id: `stage-${c.id}`,
        label: c.summary || "관계 변화",
        at: c.createdAt,
      })),
    ];
    rows.sort((a, b) => {
      const at = a.at ? new Date(a.at).getTime() : 0;
      const bt = b.at ? new Date(b.at).getTime() : 0;
      return bt - at;
    });
    return rows;
  }, [data.recentCareActions, data.relationChanges]);

  const visibleHistory = historyOpen
    ? historyItems
    : historyItems.slice(0, HISTORY_PREVIEW);
  const hasMoreHistory = historyItems.length > HISTORY_PREVIEW;

  const feedHref = buildNeighborFeedPersonLink(person.id);
  const needsCare = health === "관리 필요";

  return (
    <div className="flex flex-col gap-4 pb-4">
      <button
        type="button"
        onClick={onBack}
        className="text-left text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        ← 이웃 목록
      </button>

      {/* 1. Ops status summary */}
      <section className="rounded-xl border border-border/70 bg-card p-4">
        <div className="flex items-start justify-between gap-3">
          <h2 className="min-w-0 truncate text-xl font-semibold tracking-tight">
            {title}
          </h2>
          <span
            className={cn(
              "shrink-0 rounded-md px-2.5 py-1 text-xs font-medium",
              needsCare
                ? "bg-amber-500/15 text-amber-800 dark:text-amber-200"
                : "bg-emerald-500/15 text-emerald-800 dark:text-emerald-200",
            )}
          >
            {health}
          </span>
        </div>

        {data.nickname && data.blogName && data.nickname !== data.blogName ? (
          <p className="mt-1 text-xs text-muted-foreground">
            닉네임 · {data.nickname}
          </p>
        ) : null}

        <div className="mt-3">
          <p className="mb-1 text-[11px] font-medium text-muted-foreground">
            현재 상태
          </p>
          <StatusLine label="마지막 방문" days={daysVisit} />
          <StatusLine label="마지막 공감" days={daysLike} />
          <StatusLine label="마지막 댓글" days={daysComment} />
          <StatusLine label="최근 글" days={daysPost} />
        </div>
      </section>

      {/* 2. Next action */}
      <Section title="다음 행동 추천">
        <p className="text-sm font-semibold leading-snug">
          👉 {nextAction.action}
        </p>
        {nextAction.reasons.length > 0 ? (
          <div className="mt-2 space-y-0.5">
            <p className="text-[11px] font-medium text-muted-foreground">
              이유
            </p>
            {nextAction.reasons.map((r) => (
              <p key={r} className="text-xs leading-snug text-foreground/85">
                · {r}
              </p>
            ))}
          </div>
        ) : null}
      </Section>

      {/* 3. Recent post */}
      {data.lastPostTitle || data.lastPostAt ? (
        data.blogUrl ? (
          <a
            href={data.blogUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="block rounded-xl border border-border/70 bg-card p-4 transition-colors hover:bg-secondary/40"
          >
            <p className="text-[11px] font-medium text-muted-foreground">
              📌 최근 글
            </p>
            <p className="mt-1 truncate text-sm font-medium">
              {data.lastPostTitle?.trim() || "제목 없음"}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              작성 {formatDaysAgoKo(daysPost)}
            </p>
          </a>
        ) : (
          <section className="rounded-xl border border-border/70 bg-card p-4">
            <p className="text-[11px] font-medium text-muted-foreground">
              📌 최근 글
            </p>
            <p className="mt-1 truncate text-sm font-medium">
              {data.lastPostTitle?.trim() || "제목 없음"}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              작성 {formatDaysAgoKo(daysPost)}
            </p>
          </section>
        )
      ) : null}

      {/* 4. Ops timeline — visit/like/comment + relation change only */}
      <Section title="최근 관리 기록">
        {visibleHistory.length === 0 ? (
          <p className="text-sm text-muted-foreground">기록이 없습니다.</p>
        ) : (
          <ul className="space-y-0">
            {visibleHistory.map((row) => (
              <li
                key={row.id}
                className="flex items-center justify-between gap-3 border-b border-border/40 py-2 text-sm last:border-0"
              >
                <span className="min-w-0 truncate font-medium">{row.label}</span>
                <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                  {row.at
                    ? formatDaysAgoKo(daysSince(row.at))
                    : "—"}
                </span>
              </li>
            ))}
          </ul>
        )}
        {hasMoreHistory ? (
          <button
            type="button"
            onClick={() => setHistoryOpen((v) => !v)}
            className="mt-2 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            {historyOpen
              ? "접기"
              : `더보기 (${historyItems.length - HISTORY_PREVIEW})`}
          </button>
        ) : null}
      </Section>

      {/* 5. CTAs */}
      <div className="flex flex-col gap-2 pt-1">
        {data.blogUrl ? (
          <Button asChild size="lg" className="h-11 w-full text-sm">
            <a href={data.blogUrl} target="_blank" rel="noopener noreferrer">
              블로그 방문
            </a>
          </Button>
        ) : null}
        <Button asChild size="lg" variant="outline" className="h-11 w-full text-sm">
          <Link href={feedHref}>이웃 새글 보기</Link>
        </Button>
        <Button
          type="button"
          size="lg"
          variant="secondary"
          className="h-11 w-full text-sm"
          onClick={onBack}
        >
          목록으로
        </Button>
      </div>
    </div>
  );
}
