import Link from "next/link";

import { DashboardScoreBadge } from "@/components/brief/DashboardScoreBadge";
import { Button } from "@/components/ui/button";
import type { TodayTopNeighbor } from "@/types/todayDashboard";

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 text-xs">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right text-foreground/90">{value}</dd>
    </div>
  );
}

export function TodayTopNeighborCard({ neighbor }: { neighbor: TodayTopNeighbor }) {
  return (
    <article className="rounded-xl border border-border/70 bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <h4 className="min-w-0 text-base font-semibold leading-snug">
          {neighbor.blogName}
        </h4>
        <DashboardScoreBadge label="교류" score={neighbor.interactionScore} />
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
        <MetaRow label="마지막 공감" value={neighbor.lastLike} />
      </dl>

      <div className="mt-4 flex justify-end gap-2">
        {neighbor.isAccepted ? (
          <Button asChild size="sm" variant="outline" className="h-8 px-3 text-xs">
            <Link href={`/neighbors?tab=manage&id=${neighbor.id}`}>
              이웃 관리
            </Link>
          </Button>
        ) : null}
        <Button asChild size="sm" variant="secondary" className="h-8 px-3 text-xs">
          <Link href={neighbor.blogUrl} target="_blank" rel="noopener noreferrer">
            블로그 방문
          </Link>
        </Button>
      </div>
    </article>
  );
}
