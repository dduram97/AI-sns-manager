"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import {
  approveAdminJobAction,
  approveAdminJobsBatchAction,
  excludeAdminCandidateAction,
} from "@/app/actions/admin";
import { ADMIN_CONTENT_CLASS } from "@/components/shell/snsMenus";
import { Button } from "@/components/ui/button";
import type { AdminDiscoveryScreenData } from "@/services/adminDiscoveryService";

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

function statusBadgeClass(status: string | null): string {
  switch (status) {
    case "planned":
      return "bg-amber-500/15 text-amber-800 dark:text-amber-200";
    case "approved":
      return "bg-sky-500/15 text-sky-800 dark:text-sky-200";
    case "executed":
      return "bg-emerald-500/15 text-emerald-800 dark:text-emerald-200";
    case "failed":
    case "permanently_failed":
      return "bg-rose-500/15 text-rose-800 dark:text-rose-200";
    case "skipped":
      return "bg-muted text-muted-foreground";
    default:
      return "bg-secondary text-secondary-foreground";
  }
}

export function AdminDiscoveryScreen({
  data,
}: {
  data: AdminDiscoveryScreenData;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [hint, setHint] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "planned" | "approved" | "skipped">(
    "all",
  );

  const visible = useMemo(() => {
    return data.rows.filter((r) => {
      if (filter === "all") return true;
      if (filter === "planned") return r.jobStatus === "planned";
      if (filter === "approved") return r.jobStatus === "approved";
      if (filter === "skipped") return r.candidateStatus === "skipped";
      return true;
    });
  }, [data.rows, filter]);

  const plannedIds = useMemo(
    () =>
      visible
        .filter((r) => r.jobStatus === "planned" && r.actionJobId)
        .map((r) => r.actionJobId!),
    [visible],
  );

  function toggle(jobId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });
  }

  function selectAllPlanned() {
    setSelected(new Set(plannedIds));
  }

  function approveOne(jobId: string) {
    setHint(null);
    startTransition(async () => {
      const r = await approveAdminJobAction(jobId);
      setHint(r.ok ? "승인 완료" : r.errorMessage ?? "승인 실패");
      router.refresh();
    });
  }

  function approveSelected() {
    const ids = [...selected];
    if (ids.length === 0) {
      setHint("승인할 planned job을 선택하세요.");
      return;
    }
    setHint(null);
    startTransition(async () => {
      const r = await approveAdminJobsBatchAction(ids);
      setHint(`승인 ${r.ok}건 · 실패 ${r.failed}건`);
      setSelected(new Set());
      router.refresh();
    });
  }

  function excludeOne(row: AdminDiscoveryScreenData["rows"][number]) {
    setHint(null);
    startTransition(async () => {
      const r = await excludeAdminCandidateAction({
        candidateId: row.id,
        blogId: row.blogId,
        blogUrl: row.blogUrl,
        blogName: row.blogName,
      });
      setHint(r.ok ? "제외 완료 (재발견 방지)" : r.errorMessage ?? "제외 실패");
      router.refresh();
    });
  }

  return (
    <div className={ADMIN_CONTENT_CLASS}>
      <header className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
          Admin
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Discovery</h1>
        <p className="text-sm text-muted-foreground">
          후보 {data.counts.total} · planned {data.counts.planned} · approved{" "}
          {data.counts.approved} · skipped {data.counts.skipped}
        </p>
        <div className="flex flex-wrap gap-2 pt-1 text-xs">
          <Link href="/admin/actions" className="text-primary underline-offset-2 hover:underline">
            실행 이력 →
          </Link>
          <Link href="/more" className="text-muted-foreground underline-offset-2 hover:underline">
            더보기
          </Link>
        </div>
      </header>

      <div className="flex flex-wrap gap-2">
        {(
          [
            ["all", "전체"],
            ["planned", "planned"],
            ["approved", "approved"],
            ["skipped", "제외"],
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

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending || plannedIds.length === 0}
          onClick={selectAllPlanned}
        >
          planned 전체 선택
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={pending || selected.size === 0}
          onClick={approveSelected}
        >
          선택 승인 ({selected.size})
        </Button>
      </div>

      {hint ? (
        <p className="text-center text-xs text-muted-foreground">{hint}</p>
      ) : null}

      {visible.length === 0 ? (
        <div className="rounded-xl border border-border/70 bg-card px-4 py-10 text-center text-sm text-muted-foreground">
          표시할 후보가 없습니다.
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {visible.map((row) => {
            const canApprove =
              row.jobStatus === "planned" && Boolean(row.actionJobId);
            const jobId = row.actionJobId;
            return (
              <article
                key={row.id}
                className="rounded-xl border border-border/70 bg-card px-4 py-3"
              >
                <div className="flex items-start gap-3">
                  {canApprove && jobId ? (
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4"
                      checked={selected.has(jobId)}
                      onChange={() => toggle(jobId)}
                      aria-label="선택"
                    />
                  ) : (
                    <span className="mt-1 h-4 w-4" />
                  )}
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold tracking-tight">
                        {row.blogName || row.blogId}
                      </span>
                      {row.score != null ? (
                        <span className="rounded-md bg-secondary px-2 py-0.5 text-[11px] font-medium">
                          score {row.score}
                        </span>
                      ) : null}
                      <span
                        className={`rounded-md px-2 py-0.5 text-[11px] font-medium ${statusBadgeClass(
                          row.jobStatus ?? row.candidateStatus,
                        )}`}
                      >
                        {row.jobStatus
                          ? `job:${row.jobStatus}`
                          : `cand:${row.candidateStatus}`}
                      </span>
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {row.blogId} · {row.keyword || "—"}
                    </p>
                    <a
                      href={row.blogUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="block truncate text-xs text-primary underline-offset-2 hover:underline"
                    >
                      {row.blogUrl}
                    </a>
                    {row.postUrl ? (
                      <a
                        href={row.postUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="block truncate text-[11px] text-muted-foreground underline-offset-2 hover:underline"
                      >
                        {row.postUrl}
                      </a>
                    ) : null}
                    <p className="text-[11px] text-muted-foreground">
                      발견 {formatTime(row.discoveredAt)}
                      {row.skipReason ? ` · ${row.skipReason}` : ""}
                    </p>
                    <div className="flex flex-wrap gap-2 pt-1">
                      {canApprove && jobId ? (
                        <Button
                          type="button"
                          size="sm"
                          disabled={pending}
                          onClick={() => approveOne(jobId)}
                        >
                          승인
                        </Button>
                      ) : null}
                      {row.candidateStatus !== "skipped" ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={pending}
                          onClick={() => excludeOne(row)}
                        >
                          제외
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
