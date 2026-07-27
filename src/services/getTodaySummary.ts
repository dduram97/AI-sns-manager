import "server-only";

import type { DatabaseClient } from "@/lib/supabase";
import { createServiceClient } from "@/lib/supabase";
import { resolveCompletedRange } from "@/lib/completedRange";
import { createSupervisorRepos } from "@/repositories/index";
import {
  countNeighborExecutedToday,
  listNeighborCandidates,
} from "@/services/neighborService";
import type { TodaySummaryViewModel } from "@/types/todaySummary";

export type { TodaySummaryViewModel } from "@/types/todaySummary";

function isNeighborFeedJob(
  targetRef: Record<string, unknown> | null | undefined,
): boolean {
  if (!targetRef) return false;
  return (
    targetRef.source === "neighbor_feed" || targetRef.neighbor_feed === true
  );
}

async function countNeighborFeedCompletedToday(
  db: DatabaseClient,
  fromIso: string,
  toIso: string,
): Promise<number> {
  const { data, error } = await db
    .from("approval_items")
    .select("action_job_id")
    .not("resolved_at", "is", null)
    .gte("resolved_at", fromIso)
    .lte("resolved_at", toIso)
    .limit(500);
  if (error) {
    throw new Error(
      `getTodaySummary neighborFeedCompleted: ${error.message}`,
    );
  }

  const rows = data ?? [];
  if (rows.length === 0) return 0;

  const jobIds = [
    ...new Set(
      rows
        .map((row) => String((row as { action_job_id?: string }).action_job_id))
        .filter(Boolean),
    ),
  ];
  if (jobIds.length === 0) return 0;

  const neighborFeedJobIds = new Set<string>();
  const chunkSize = 100;
  for (let i = 0; i < jobIds.length; i += chunkSize) {
    const chunk = jobIds.slice(i, i + chunkSize);
    const { data: jobs, error: jobsErr } = await db
      .from("action_jobs")
      .select("id, target_ref")
      .in("id", chunk);
    if (jobsErr) {
      throw new Error(
        `getTodaySummary neighborFeedCompleted jobs: ${jobsErr.message}`,
      );
    }
    for (const job of jobs ?? []) {
      const rec = job as { id?: string; target_ref?: Record<string, unknown> };
      if (rec.id && isNeighborFeedJob(rec.target_ref)) {
        neighborFeedJobIds.add(String(rec.id));
      }
    }
  }

  return rows.filter((row) =>
    neighborFeedJobIds.has(
      String((row as { action_job_id?: string }).action_job_id),
    ),
  ).length;
}

export async function getTodaySummary(): Promise<TodaySummaryViewModel> {
  const repos = createSupervisorRepos(createServiceClient());
  const db = createServiceClient();
  const since = resolveCompletedRange({ preset: "today" }).fromIso;
  const todayRange = resolveCompletedRange({ preset: "today" });

  const [
    openInbox,
    neighborFeedCompleted,
    candidates,
    neighborExecutedToday,
    executedCommentsRes,
  ] = await Promise.all([
    repos.approval.listOpenInbox(),
    countNeighborFeedCompletedToday(db, todayRange.fromIso, todayRange.toIso),
    listNeighborCandidates(),
    countNeighborExecutedToday(),
    db
      .from("action_jobs")
      .select("id, target_ref, action_type, status, executed_at")
      .eq("action_type", "comment")
      .eq("status", "executed")
      .gte("executed_at", since),
  ]);

  if (executedCommentsRes.error) {
    throw new Error(`getTodaySummary comments: ${executedCommentsRes.error.message}`);
  }

  const neighborFeedPending = openInbox.filter(
    (item) => item.source === "neighbor_feed",
  ).length;

  const commentPending = openInbox.filter(
    (item) =>
      item.source !== "neighbor_feed" && item.job.action_type === "comment",
  ).length;

  const commentCompleted = (executedCommentsRes.data ?? []).filter((row) => {
    const ref = (row as { target_ref?: Record<string, unknown> }).target_ref;
    return !isNeighborFeedJob(ref);
  }).length;

  return {
    neighborFeed: {
      pending: neighborFeedPending,
      completed: neighborFeedCompleted,
    },
    neighborRequest: {
      candidates: candidates.length,
      completed: neighborExecutedToday,
    },
    comment: {
      pending: commentPending,
      completed: commentCompleted,
    },
  };
}
