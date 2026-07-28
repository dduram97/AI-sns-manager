"use client";

import Link from "next/link";
import type { ReplyVisitSummary } from "@/services/replyVisitTaskService";
import { Button } from "@/components/ui/button";

export function ReplyVisitSummaryCard({
  summary,
  loading = false,
}: {
  summary: ReplyVisitSummary | null;
  loading?: boolean;
}) {
  const completed = summary?.completed ?? 0;
  const total = summary?.total ?? 0;

  return (
    <section className="rounded-xl border border-border/70 bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold tracking-tight">
            답방 해야할 이웃
          </h2>
          <p className="mt-1 text-sm tabular-nums text-muted-foreground">
            {loading ? (
              "불러오는 중…"
            ) : (
              <>
                완료 {completed}명 / 전체 {total}명
              </>
            )}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            최근 3일 내 내 글에 댓글·공감한 이웃
          </p>
        </div>
        <Button asChild size="sm" variant="outline" className="shrink-0">
          <Link href="/neighbors/reply">보기</Link>
        </Button>
      </div>
    </section>
  );
}
