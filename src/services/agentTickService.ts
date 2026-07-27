/**
 * Operational Agent Tick runner — lock → tick → API response shape.
 * Auth: CRON_SECRET (Vercel Cron) and/or AGENT_TICK_SECRET (manual).
 */

import "server-only";

import { createServiceClient } from "@/lib/supabase";
import { createRepositories } from "@/repositories/index";
import { maybeRunScheduledNeighborFeedCollect } from "@/services/neighborFeedScheduleService";
import { tick, type TickOptions } from "@/workers/tick";
import { withTickLock } from "@/workers/tickLock";
import {
  persistTickRunLog,
  type TickRunLogEntry,
} from "@/workers/tickRunLog";
import type { TickResult } from "@/workers/types";

export type AgentTickApiResponse = {
  ok: true;
  startedAt: string;
  finishedAt: string;
  perceptionsProcessed: number;
  approvalsCreated: number;
  actionsExecuted: number;
  actionsBlocked: number;
  personsProcessed: number;
  brief: {
    agent_status: string;
    approval_count: number;
    intervention_minutes_est: number;
    time_saved_minutes_est: number;
    activity_summary: Record<string, unknown>;
    growth_summary: Record<string, unknown>;
    last_tick_at: string | null;
  };
  logs?: string[];
};

export type AgentTickBusyResponse = {
  ok: false;
  error: "tick_already_running";
  startedAt: string;
  finishedAt: string;
  lockUntil?: string;
};

export type AgentTickUnauthorizedResponse = {
  ok: false;
  error: "unauthorized";
};

export type TickRequestSource = "cron" | "manual" | "unknown";

function briefSummary(result: TickResult): AgentTickApiResponse["brief"] {
  const detail = result.brief.status_detail ?? {};
  return {
    agent_status: result.brief.agent_status,
    approval_count: result.brief.approval_count,
    intervention_minutes_est: result.brief.intervention_minutes_est,
    time_saved_minutes_est: result.brief.time_saved_minutes_est,
    activity_summary: result.brief.activity_summary,
    growth_summary: result.brief.growth_summary,
    last_tick_at:
      typeof detail.last_tick_at === "string" ? detail.last_tick_at : null,
  };
}

export function toAgentTickResponse(
  result: TickResult,
  meta: { startedAt: string; finishedAt: string; includeLogs?: boolean },
): AgentTickApiResponse {
  return {
    ok: true,
    startedAt: meta.startedAt,
    finishedAt: meta.finishedAt,
    perceptionsProcessed: result.perceptionsProcessed,
    approvalsCreated: result.approvalsCreated.length,
    actionsExecuted: result.actionsExecuted,
    actionsBlocked: result.actionsBlocked,
    personsProcessed: result.personsProcessed,
    brief: briefSummary(result),
    ...(meta.includeLogs ? { logs: result.logs } : {}),
  };
}

/**
 * Run one Agent Tick under distributed lock.
 * Returns busy when another tick holds the lock.
 * Always writes an execution log (start / counts / failures).
 */
export async function runAgentTickLocked(
  options?: TickOptions & {
    includeLogs?: boolean;
    source?: TickRequestSource;
  },
): Promise<AgentTickApiResponse | AgentTickBusyResponse> {
  const db = createServiceClient();
  const repos = createRepositories(db);
  const includeLogs = options?.includeLogs === true;
  const source = options?.source ?? "unknown";
  const startedAt = new Date().toISOString();

  const locked = await withTickLock(db, async () => {
    const result = await tick(repos, options);
    // Side job: neighbor feed schedule (does not alter Agent workflow).
    // Errors are swallowed inside; never fail the tick response.
    await maybeRunScheduledNeighborFeedCollect();
    return result;
  });
  const finishedAt = new Date().toISOString();

  if (!locked.acquired) {
    const entry: TickRunLogEntry = {
      started_at: startedAt,
      finished_at: finishedAt,
      perceptions_processed: 0,
      approvals_created: 0,
      actions_executed: 0,
      actions_failed: 0,
      ok: false,
      error: "tick_already_running",
      source,
    };
    await persistTickRunLog(db, entry);
    return {
      ok: false,
      error: "tick_already_running",
      startedAt,
      finishedAt,
      lockUntil: locked.lockUntil,
    };
  }

  const entry: TickRunLogEntry = {
    started_at: startedAt,
    finished_at: finishedAt,
    perceptions_processed: locked.value.perceptionsProcessed,
    approvals_created: locked.value.approvalsCreated.length,
    actions_executed: locked.value.actionsExecuted,
    actions_failed: locked.value.actionsBlocked,
    ok: true,
    source,
  };
  await persistTickRunLog(db, entry);

  return toAgentTickResponse(locked.value, {
    startedAt,
    finishedAt,
    includeLogs,
  });
}

/**
 * Accept Vercel Cron (CRON_SECRET) and/or manual (AGENT_TICK_SECRET).
 * Vercel sends: Authorization: Bearer <CRON_SECRET>
 */
export function authorizeAgentTickRequest(
  authHeader: string | null,
  secretHeader: string | null,
): { ok: boolean; source: TickRequestSource } {
  const cronSecret = process.env.CRON_SECRET?.trim();
  const tickSecret = process.env.AGENT_TICK_SECRET?.trim();

  const bearer = authHeader?.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : null;

  if (cronSecret && bearer && bearer === cronSecret) {
    return { ok: true, source: "cron" };
  }
  if (tickSecret && secretHeader && secretHeader === tickSecret) {
    return { ok: true, source: "manual" };
  }
  if (tickSecret && bearer && bearer === tickSecret) {
    return { ok: true, source: "manual" };
  }

  // Misconfigured — refuse open endpoint
  if (!cronSecret && !tickSecret) {
    return { ok: false, source: "unknown" };
  }
  return { ok: false, source: "unknown" };
}
