/**
 * Agent Execution Log — Supervisor More screen (no Decision Engine change).
 * Repository → Service → UI.
 */

import "server-only";

import { createServiceClient } from "@/lib/supabase";
import { createSupervisorRepos } from "@/repositories/index";
import type { ActionJobStatus, ActionType } from "@/workers/types";
import type {
  AgentExecutionLogData,
  ExecutionLogStatus,
  RecentExecutionView,
  TickLogView,
} from "@/types/moreScreen";

export type {
  AgentExecutionLogData,
  ExecutionLogStatus,
  RecentExecutionView,
  TickLogView,
} from "@/types/moreScreen";

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function actionLabel(type: ActionType): string {
  switch (type) {
    case "visit":
      return "방문";
    case "like":
      return "공감";
    case "comment":
      return "댓글";
    case "neighbor_request":
      return "서로이웃";
    case "threads_reply":
      return "Threads 답글";
    default:
      return type;
  }
}

function mapStatus(status: ActionJobStatus): ExecutionLogStatus {
  if (status === "executed") return "executed";
  if (status === "failed") return "failed";
  return "blocked";
}

function statusLabel(status: ExecutionLogStatus): string {
  switch (status) {
    case "executed":
      return "executed";
    case "failed":
      return "failed";
    case "blocked":
      return "blocked";
  }
}

function sourceLabel(source: string | null): string | null {
  if (source === "cron") return "Cron";
  if (source === "manual") return "수동";
  return source;
}

export async function getAgentExecutionLog(
  limit = 12,
): Promise<AgentExecutionLogData> {
  const repos = createSupervisorRepos(createServiceClient());
  const [tick, jobs] = await Promise.all([
    repos.brief.getLastTickRun(),
    repos.approval.listRecentActionExecutions(limit),
  ]);

  const personIds = [...new Set(jobs.map((j) => j.person_id))];
  const nameById = new Map<string, string>();
  await Promise.all(
    personIds.map(async (id) => {
      const person = await repos.person.getById(id);
      if (person?.display_name) nameById.set(id, person.display_name);
    }),
  );

  const recentTick: TickLogView | null = tick
    ? {
        startedAt: tick.started_at,
        finishedAt: tick.finished_at,
        timeLabel: formatTime(tick.started_at),
        perceptionsProcessed: tick.perceptions_processed,
        approvalsCreated: tick.approvals_created,
        actionsExecuted: tick.actions_executed,
        actionsFailed: tick.actions_failed,
        ok: tick.ok,
        error: tick.error,
        sourceLabel: sourceLabel(tick.source),
      }
    : null;

  const recentExecutions: RecentExecutionView[] = jobs.map((job) => {
    const status = mapStatus(job.status);
    const at =
      job.executed_at ??
      (typeof job.target_ref?.last_failed_at === "string"
        ? job.target_ref.last_failed_at
        : null) ??
      job.updated_at;
    return {
      id: job.id,
      actionType: job.action_type,
      actionLabel: actionLabel(job.action_type),
      status,
      statusLabel: statusLabel(status),
      personLabel: nameById.get(job.person_id)?.trim() || "대상",
      timeLabel: formatTime(at),
      error: job.error,
    };
  });

  return { recentTick, recentExecutions };
}
