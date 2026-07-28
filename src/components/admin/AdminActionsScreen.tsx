"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ADMIN_CONTENT_CLASS } from "@/components/shell/snsMenus";
import type { AdminActionsScreenData } from "@/services/adminActionsService";

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
    case "planned":
      return "bg-amber-500/15 text-amber-800 dark:text-amber-200";
    case "approved":
      return "bg-sky-500/15 text-sky-800 dark:text-sky-200";
    case "executed":
      return "bg-emerald-500/15 text-emerald-800 dark:text-emerald-200";
    case "running":
      return "bg-violet-500/15 text-violet-800 dark:text-violet-200";
    case "skipped":
    case "excluded":
      return "bg-slate-500/15 text-slate-700 dark:text-slate-200";
    case "failed":
    case "permanently_failed":
      return "bg-rose-500/15 text-rose-800 dark:text-rose-200";
    default:
      return "bg-secondary text-secondary-foreground";
  }
}

export function AdminActionsScreen({
  data,
}: {
  data: AdminActionsScreenData;
}) {
  const [typeFilter, setTypeFilter] = useState<
    "all" | "like" | "comment" | "neighbor_request" | "visit"
  >("all");
  const [statusFilter, setStatusFilter] = useState<
    "all" | "planned" | "approved" | "executed" | "failed"
  >("all");

  const visible = useMemo(() => {
    return data.rows.filter((r) => {
      if (typeFilter !== "all" && r.actionType !== typeFilter) return false;
      if (statusFilter === "all") return true;
      if (statusFilter === "failed") {
        return r.status === "failed" || r.status === "permanently_failed";
      }
      return r.status === statusFilter;
    });
  }, [data.rows, typeFilter, statusFilter]);

  return (
    <div className={ADMIN_CONTENT_CLASS}>
      <header className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
          Admin
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Actions</h1>
        <p className="text-sm text-muted-foreground">
          총 {data.counts.total} · planned {data.counts.planned} · approved{" "}
          {data.counts.approved} · executed {data.counts.executed} · failed{" "}
          {data.counts.failed} · skipped/excluded {data.counts.skipped}
        </p>
        <div className="flex flex-wrap gap-2 pt-1 text-xs">
          <Link
            href="/admin/discovery"
            className="text-primary underline-offset-2 hover:underline"
          >
            Discovery →
          </Link>
          <Link
            href="/admin/neighbors"
            className="text-muted-foreground underline-offset-2 hover:underline"
          >
            Neighbors
          </Link>
          <Link
            href="/more"
            className="text-muted-foreground underline-offset-2 hover:underline"
          >
            더보기
          </Link>
        </div>
      </header>

      <div className="flex flex-wrap gap-2">
        {(
          [
            ["all", "전체"],
            ["like", "like"],
            ["comment", "comment"],
            ["neighbor_request", "neighbor"],
            ["visit", "visit"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTypeFilter(key)}
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              typeFilter === key
                ? "bg-primary text-primary-foreground"
                : "bg-secondary text-secondary-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        {(
          [
            ["all", "상태"],
            ["planned", "planned"],
            ["approved", "approved"],
            ["executed", "executed"],
            ["failed", "failed"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setStatusFilter(key)}
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              statusFilter === key
                ? "bg-primary text-primary-foreground"
                : "bg-secondary text-secondary-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <div className="rounded-xl border border-border/70 bg-card px-4 py-10 text-center text-sm text-muted-foreground">
          표시할 이력이 없습니다.
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {visible.map((row) => (
            <article
              key={row.id}
              className="rounded-xl border border-border/70 bg-card px-4 py-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                {row.actionType === "neighbor_request" ? (
                  <Link
                    href={`/admin/actions/${row.id}`}
                    className="text-sm font-semibold text-primary underline-offset-2 hover:underline"
                  >
                    {row.actionType}
                  </Link>
                ) : (
                  <span className="text-sm font-semibold">{row.actionType}</span>
                )}
                <span
                  className={`rounded-md px-2 py-0.5 text-[11px] font-medium ${statusBadgeClass(
                    row.status,
                  )}`}
                >
                  {row.status}
                </span>
                <span className="rounded-md bg-secondary px-2 py-0.5 text-[11px]">
                  {row.risk}
                </span>
                {row.workerTest ? (
                  <span className="rounded-md bg-secondary px-2 py-0.5 text-[11px]">
                    test
                  </span>
                ) : null}
              </div>
              <p className="mt-1 truncate text-xs text-muted-foreground">
                {row.blogId ?? "—"}
              </p>
              {row.targetUrl ? (
                <a
                  href={row.targetUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-0.5 block truncate text-xs text-primary underline-offset-2 hover:underline"
                >
                  {row.targetUrl}
                </a>
              ) : null}
              <div className="mt-2 grid grid-cols-2 gap-1 text-[11px] text-muted-foreground">
                <p>생성 {formatTime(row.createdAt)}</p>
                <p>완료 {formatTime(row.completedAt)}</p>
                {row.approvedAt ? (
                  <p className="col-span-2">
                    승인 {formatTime(row.approvedAt)}
                    {row.approvedBy ? ` · ${row.approvedBy}` : ""}
                  </p>
                ) : null}
              </div>
              {row.failure ? (
                <div
                  className={`mt-2 space-y-0.5 rounded-md px-2.5 py-2 text-[11px] ${
                    row.failure.kind === "failure"
                      ? "bg-rose-500/5 text-rose-700 dark:text-rose-300"
                      : "bg-slate-500/10 text-slate-700 dark:text-slate-200"
                  }`}
                >
                  <p className="font-medium">{row.failure.summary}</p>
                  <p>
                    failed_step: {row.failure.failedStep} (
                    {row.failure.failedStepLabel})
                  </p>
                  <p>
                    error_code: {row.failure.errorCode}
                  </p>
                  <p>detail: {row.failure.errorMessage}</p>
                  {row.failure.kind === "failure" ? (
                    <p>
                      재시도:{" "}
                      {row.failure.retryable ? "가능" : "권장하지 않음"}
                    </p>
                  ) : null}
                  {row.failure.url ? (
                    <p className="truncate">URL: {row.failure.url}</p>
                  ) : null}
                  {row.failure.steps.length > 0 ? (
                    <p className="truncate opacity-80">
                      trail: {row.failure.steps.join(" → ")}
                    </p>
                  ) : null}
                </div>
              ) : row.error ? (
                <p className="mt-1 line-clamp-2 text-[11px] text-rose-600 dark:text-rose-300">
                  {row.error}
                </p>
              ) : null}
              <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
                {row.id}
              </p>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
