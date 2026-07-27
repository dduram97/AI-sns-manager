"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { refreshNeighborPerformanceAction } from "@/app/actions/admin";
import { ADMIN_CONTENT_CLASS } from "@/components/shell/snsMenus";
import { Button } from "@/components/ui/button";
import type { AdminNeighborsScreenData } from "@/services/adminNeighborPerformanceService";

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("ko-KR", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case "requested":
      return "bg-amber-500/15 text-amber-800 dark:text-amber-200";
    case "accepted":
      return "bg-emerald-500/15 text-emerald-800 dark:text-emerald-200";
    case "rejected":
      return "bg-rose-500/15 text-rose-800 dark:text-rose-200";
    default:
      return "bg-muted text-muted-foreground";
  }
}

export function AdminNeighborsScreen({
  data,
}: {
  data: AdminNeighborsScreenData;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [hint, setHint] = useState<string | null>(null);
  const [filter, setFilter] = useState<
    "all" | "requested" | "accepted" | "unknown" | "top"
  >("all");

  const visible = useMemo(() => {
    let rows = [...data.rows];
    if (filter === "requested") {
      rows = rows.filter((r) => r.requestStatus === "requested");
    } else if (filter === "accepted") {
      rows = rows.filter((r) => r.requestStatus === "accepted");
    } else if (filter === "unknown") {
      rows = rows.filter((r) => r.requestStatus === "unknown");
    } else if (filter === "top") {
      rows = rows.sort(
        (a, b) =>
          b.engagementScore - a.engagementScore ||
          (b.candidateScore ?? -1) - (a.candidateScore ?? -1),
      );
    }
    return rows;
  }, [data.rows, filter]);

  function refreshOne(id: string) {
    setHint(null);
    startTransition(async () => {
      const r = await refreshNeighborPerformanceAction(id);
      setHint(
        r.ok
          ? `상태 갱신: ${r.status ?? "ok"}`
          : r.errorMessage ?? "갱신 실패",
      );
      router.refresh();
    });
  }

  return (
    <div className={ADMIN_CONTENT_CLASS}>
      <header className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
          Admin
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Neighbors</h1>
        <p className="text-sm text-muted-foreground">
          신청 {data.counts.total} · 대기 {data.counts.requested} · 수락{" "}
          {data.counts.accepted} · 미확인 {data.counts.unknown}
        </p>
        <div className="flex flex-wrap gap-2 pt-1 text-xs">
          <Link
            href="/admin/discovery"
            className="text-primary underline-offset-2 hover:underline"
          >
            Discovery →
          </Link>
          <Link
            href="/admin/actions"
            className="text-muted-foreground underline-offset-2 hover:underline"
          >
            Actions
          </Link>
        </div>
      </header>

      <div className="flex flex-wrap gap-2">
        {(
          [
            ["all", "전체"],
            ["requested", "신청 중"],
            ["accepted", "수락됨"],
            ["unknown", "미확인"],
            ["top", "성과 높은 순"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setFilter(key)}
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              filter === key
                ? "bg-primary text-primary-foreground"
                : "bg-secondary text-secondary-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {hint ? (
        <p className="text-center text-xs text-muted-foreground">{hint}</p>
      ) : null}

      {visible.length === 0 ? (
        <div className="rounded-xl border border-border/70 bg-card px-4 py-10 text-center text-sm text-muted-foreground">
          추적 데이터가 없습니다. neighbor_request 실행 후 쌓입니다.
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {visible.map((row) => (
            <article
              key={row.id}
              className="rounded-xl border border-border/70 bg-card px-4 py-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold">{row.blogId}</span>
                <span
                  className={`rounded-md px-2 py-0.5 text-[11px] font-medium ${statusBadgeClass(
                    row.requestStatus,
                  )}`}
                >
                  {row.requestStatus}
                </span>
                {row.candidateScore != null ? (
                  <span className="rounded-md bg-secondary px-2 py-0.5 text-[11px]">
                    score {row.candidateScore}
                  </span>
                ) : null}
                {row.outcomeLabel ? (
                  <span className="rounded-md bg-secondary px-2 py-0.5 text-[11px]">
                    {row.outcomeLabel}
                  </span>
                ) : null}
              </div>
              {row.blogUrl ? (
                <a
                  href={row.blogUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 block truncate text-xs text-primary underline-offset-2 hover:underline"
                >
                  {row.blogUrl}
                </a>
              ) : null}
              <div className="mt-2 grid grid-cols-2 gap-1 text-[11px] text-muted-foreground">
                <p>신청 {formatTime(row.requestedAt)}</p>
                <p>수락 {formatTime(row.acceptedAt)}</p>
                <p>프로필 방문 {row.profileVisitCount}</p>
                <p>글 방문 {row.postVisitCount}</p>
                <p>상호작용 {row.interactionCount}</p>
                <p>성과합 {row.engagementScore}</p>
                {row.daysSinceRequest != null ? (
                  <p className="col-span-2">경과일 {row.daysSinceRequest}일</p>
                ) : null}
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => refreshOne(row.id)}
                >
                  상태 새로고침
                </Button>
                <Link
                  href={`/admin/actions/${row.actionJobId}`}
                  className="inline-flex h-9 items-center rounded-md px-3 text-sm text-primary underline-offset-2 hover:underline"
                >
                  action 상세
                </Link>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
