"use client";

import Link from "next/link";
import { ADMIN_CONTENT_CLASS } from "@/components/shell/snsMenus";
import type { AdminActionDetailData } from "@/services/adminNeighborPerformanceService";

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

export function AdminActionDetailScreen({
  data,
}: {
  data: AdminActionDetailData;
}) {
  const { job, performance, discovery, candidateScore, blogId, blogUrl } = data;

  return (
    <div className={ADMIN_CONTENT_CLASS}>
      <header className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
          Admin · Action
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">
          {job.actionType}
        </h1>
        <p className="text-sm text-muted-foreground">
          {job.status} · {job.risk}
        </p>
        <div className="flex flex-wrap gap-2 pt-1 text-xs">
          <Link
            href="/admin/actions"
            className="text-primary underline-offset-2 hover:underline"
          >
            ← 목록
          </Link>
          {performance ? (
            <Link
              href="/admin/neighbors"
              className="text-muted-foreground underline-offset-2 hover:underline"
            >
              Neighbors
            </Link>
          ) : null}
        </div>
      </header>

      <section className="rounded-xl border border-border/70 bg-card px-4 py-3 space-y-2">
        <h2 className="text-sm font-semibold">Job</h2>
        <p className="truncate font-mono text-[11px] text-muted-foreground">
          {job.id}
        </p>
        <p className="text-xs text-muted-foreground">
          생성 {formatTime(job.createdAt)} · 실행 {formatTime(job.executedAt)}
        </p>
        {blogId ? (
          <p className="text-sm">
            blog <span className="font-medium">{blogId}</span>
          </p>
        ) : null}
        {blogUrl ? (
          <a
            href={blogUrl}
            target="_blank"
            rel="noreferrer"
            className="block truncate text-xs text-primary underline-offset-2 hover:underline"
          >
            {blogUrl}
          </a>
        ) : null}
        {job.draftBody ? (
          <p className="rounded-md bg-secondary/50 px-3 py-2 text-xs">
            {job.draftBody}
          </p>
        ) : null}
        {job.failure ? (
          <div
            className={`space-y-1 rounded-md px-3 py-2 text-xs ${
              job.failure.kind === "failure"
                ? "bg-rose-500/5 text-rose-700 dark:text-rose-300"
                : "bg-slate-500/10 text-slate-700 dark:text-slate-200"
            }`}
          >
            <p className="font-medium">{job.failure.summary}</p>
            <p>
              failed_step: {job.failure.failedStep} (
              {job.failure.failedStepLabel})
            </p>
            <p>error_code: {job.failure.errorCode}</p>
            <p>detail: {job.failure.errorMessage}</p>
            {job.failure.kind === "failure" ? (
              <p>
                재시도: {job.failure.retryable ? "가능" : "권장하지 않음"}
              </p>
            ) : null}
            {job.failure.url ? (
              <p className="truncate">URL: {job.failure.url}</p>
            ) : null}
            {job.failure.steps.length > 0 ? (
              <p className="truncate">
                trail: {job.failure.steps.join(" → ")}
              </p>
            ) : null}
          </div>
        ) : job.error ? (
          <p className="text-xs text-rose-600">{job.error}</p>
        ) : null}
      </section>

      <section className="rounded-xl border border-border/70 bg-card px-4 py-3 space-y-2">
        <h2 className="text-sm font-semibold">Candidate score</h2>
        <p className="text-2xl font-semibold tracking-tight">
          {candidateScore ?? "—"}
        </p>
        {discovery ? (
          <p className="text-xs text-muted-foreground">
            discovery {discovery.status}
            {discovery.keyword ? ` · ${discovery.keyword}` : ""}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            연결된 discovery_candidates 없음
          </p>
        )}
      </section>

      <section className="rounded-xl border border-border/70 bg-card px-4 py-3 space-y-2">
        <h2 className="text-sm font-semibold">Neighbor performance</h2>
        {!performance ? (
          <p className="text-xs text-muted-foreground">
            아직 추적 행이 없습니다. neighbor_request executed 시 생성됩니다.
          </p>
        ) : (
          <>
            <p className="text-sm font-medium">{performance.requestStatus}</p>
            <div className="grid grid-cols-2 gap-1 text-[11px] text-muted-foreground">
              <p>신청 {formatTime(performance.requestedAt)}</p>
              <p>수락 {formatTime(performance.acceptedAt)}</p>
              <p>프로필 방문 {performance.profileVisitCount}</p>
              <p>글 방문 {performance.postVisitCount}</p>
              <p>상호작용 {performance.interactionCount}</p>
              <p>성과합 {performance.engagementScore}</p>
            </div>
            {performance.outcomeLabel ? (
              <p className="text-xs">outcome: {performance.outcomeLabel}</p>
            ) : null}
            <Link
              href="/admin/neighbors"
              className="inline-block text-xs text-primary underline-offset-2 hover:underline"
            >
              Neighbors 목록에서 보기 →
            </Link>
          </>
        )}
      </section>
    </div>
  );
}
