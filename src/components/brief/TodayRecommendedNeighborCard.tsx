"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { excludeNeighborBlogAction } from "@/app/actions/neighbors";
import { DashboardScoreBadge } from "@/components/brief/DashboardScoreBadge";
import { Button } from "@/components/ui/button";
import type { TodayRecommendedNeighbor } from "@/types/todayDashboard";

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 text-xs">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right text-foreground/90">{value}</dd>
    </div>
  );
}

export function TodayRecommendedNeighborCard({
  neighbor,
}: {
  neighbor: TodayRecommendedNeighbor;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleExclude() {
    if (!neighbor.blogId || pending) return;
    setError(null);
    startTransition(async () => {
      try {
        await excludeNeighborBlogAction({
          blogId: neighbor.blogId,
          blogName: neighbor.blogName,
          blogUrl: neighbor.blogUrl,
          personId: neighbor.id,
        });
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "후보 제외에 실패했습니다.");
      }
    });
  }

  return (
    <article className="rounded-xl border border-primary/20 bg-card p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            AI 추천
          </p>
          <h4 className="mt-1 text-base font-semibold leading-snug">
            {neighbor.blogName}
          </h4>
        </div>
        <DashboardScoreBadge label="추천" score={neighbor.recommendScore} />
      </div>

      <div className="mt-3 rounded-lg bg-secondary/40 px-3 py-2.5">
        <p className="line-clamp-2 text-sm font-medium leading-snug text-foreground/90">
          {neighbor.recentPostTitle}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          최근글 · {neighbor.recentPostAt}
        </p>
      </div>

      <dl className="mt-3 space-y-1.5">
        <MetaRow label="마지막 방문" value={neighbor.lastVisit} />
        <MetaRow label="마지막 댓글" value={neighbor.lastComment} />
      </dl>

      {neighbor.reasons.length > 0 ? (
        <ul className="mt-3 space-y-1">
          {neighbor.reasons.map((reason) => (
            <li key={reason} className="text-sm text-foreground/85">
              · {reason}
            </li>
          ))}
        </ul>
      ) : null}

      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}

      <div className="mt-4 flex justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 px-3 text-xs"
          disabled={pending || !neighbor.blogId}
          onClick={handleExclude}
        >
          후보 제외
        </Button>
        <Button asChild size="sm" variant="secondary" className="h-8 px-3 text-xs">
          <Link href={neighbor.blogUrl} target="_blank" rel="noopener noreferrer">
            블로그 방문
          </Link>
        </Button>
      </div>
    </article>
  );
}
