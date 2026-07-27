/**
 * Post-adapter persistence: success / failure side effects + Live guards.
 * Keeps Repository structure; no Decision Engine change.
 */

import type {
  ActionJob,
  OutcomeDaily,
  PolicyProfile,
  Workflow,
} from "../workers/types";
import { getChannelExecutor } from "./channelExecutor";
import {
  actionRetryLimit,
  canStartExecution,
  guardDailyLimit,
  guardDuplicateJobStatus,
  guardRepeatTarget,
  guardRetryLimit,
} from "./actionExecutionGuards";
import { appendExecutionLog } from "./executionLog";
import {
  isReloginRequired,
  readSessionHealth,
} from "./naver/sessionHealth";
import {
  resetTraceSummary,
  traceEnter,
  traceReturn,
  traceBlocked,
} from "./naver/traceSummary";

export interface ActionExecutionPort {
  markJobRunning(jobId: string): Promise<ActionJob>;
  markJobExecuted(jobId: string): Promise<ActionJob>;
  markJobFailed(jobId: string, errorMessage: string): Promise<ActionJob>;
  updateRelationship(
    personId: string,
    patch: {
      last_touch_at?: string;
      last_visit_at?: string;
      last_like_at?: string;
      last_comment_at?: string;
    },
  ): Promise<unknown>;
  updateWorkflow(
    workflowId: string,
    patch: {
      current_state?: Workflow["current_state"];
      blocked_reason?: string | null;
      next_action?: Workflow["next_action"];
    },
  ): Promise<Workflow>;
  insertActivity(input: {
    workflow_id: string | null;
    person_id: string | null;
    action_job_id: string | null;
    decision_id: string | null;
    kind: "executed" | "blocked";
    summary: string;
  }): Promise<unknown>;
  incrementOutcomeCounters(deltas: {
    auto_visit_count?: number;
    auto_like_count?: number;
    time_saved_minutes_est?: number;
  }): Promise<unknown>;
  getPolicy(): Promise<PolicyProfile>;
  getOutcomeToday(): Promise<OutcomeDaily>;
  findRecentExecutedByPerson(
    personId: string,
    actionType: string,
    limit?: number,
  ): Promise<ActionJob[]>;
  /** Optional: mark blog channel error when session needs relogin */
  markBlogChannelError?(reason: string): Promise<void>;
}

export type ChannelExecuteOutcome =
  | { ok: true; job: ActionJob }
  | { ok: false; job: ActionJob; errorMessage: string };

function touchPatchForJob(job: ActionJob, now: string) {
  const touch: {
    last_touch_at: string;
    last_visit_at?: string;
    last_like_at?: string;
    last_comment_at?: string;
  } = { last_touch_at: now };

  if (job.action_type === "visit") touch.last_visit_at = now;
  if (job.action_type === "like") touch.last_like_at = now;
  if (job.action_type === "comment" || job.action_type === "threads_reply") {
    touch.last_comment_at = now;
  }
  return touch;
}

export type ExecuteActionJobOptions = {
  personDisplayName?: string;
  skipped?: boolean;
};

async function runPreflightGuards(
  port: ActionExecutionPort,
  job: ActionJob,
): Promise<string | null> {
  const dup = guardDuplicateJobStatus(job);
  if (dup) return dup;
  if (!canStartExecution(job)) {
    return `not_executable_status_${job.status}`;
  }
  const retry = guardRetryLimit(job);
  if (retry) return retry;

  const health = readSessionHealth();
  if (
    (process.env.NAVER_ADAPTER_MODE ?? "live").toLowerCase() !== "mock" &&
    isReloginRequired(health)
  ) {
    // Soft warn only when within short TTL — do not embed stale Playwright call logs forever
    console.warn(
      `[executeActionJob] session health=${health?.state} age-blocked briefly: ${health?.reason?.slice(0, 120) ?? "relogin"}`,
    );
    return `session_${health?.state ?? "needs_relogin"}: recent session failure — wait a few seconds or run npm run naver:login`;
  }

  const [policy, outcome, recent] = await Promise.all([
    port.getPolicy(),
    port.getOutcomeToday(),
    port.findRecentExecutedByPerson(job.person_id, job.action_type, 30),
  ]);
  const daily = guardDailyLimit(job, policy, outcome);
  if (daily) return daily;
  const repeat = guardRepeatTarget(job, recent);
  if (repeat) return repeat;
  return null;
}

/**
 * ActionJob → guards → running → ChannelExecutor → Adapter → persist.
 */
export async function executeActionJob(
  port: ActionExecutionPort,
  job: ActionJob,
  options?: ExecuteActionJobOptions,
): Promise<ChannelExecuteOutcome> {
  resetTraceSummary();
  traceEnter(
    "executeActionJob",
    `action=${job.action_type} jobId=${job.id} status=${job.status}`,
  );

  const blocked = await runPreflightGuards(port, job);
  if (blocked) {
    traceBlocked("preflight_failed", blocked);
    const failed = await applyChannelFailure(port, job, blocked);
    appendExecutionLog({
      at: new Date().toISOString(),
      job_id: failed.id,
      action_type: failed.action_type,
      person_id: failed.person_id,
      status: "blocked",
      ok: false,
      error: blocked,
      retry_count: Number(failed.target_ref?.retry_count ?? 0),
      mode: process.env.NAVER_ADAPTER_MODE ?? "live",
    });
    traceReturn("executeActionJob", "preflight_failed", blocked);
    return { ok: false, job: failed, errorMessage: blocked };
  }

  let running: ActionJob;
  try {
    running = await port.markJobRunning(job.id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    traceBlocked("mark_running_failed", msg);
    const failed = await applyChannelFailure(
      port,
      job,
      `mark_running_failed: ${msg}`,
    );
    traceReturn("executeActionJob", "mark_running_failed", msg);
    return { ok: false, job: failed, errorMessage: msg };
  }

  console.log(`[TRACE] executeActionJob calling ChannelExecutor.execute`);
  const result = await getChannelExecutor().execute(running);

  if (!result.ok) {
    if (
      /relogin|login|session|captcha/i.test(result.errorMessage) &&
      port.markBlogChannelError
    ) {
      await port
        .markBlogChannelError(result.errorMessage)
        .catch(() => undefined);
    }
    const failed = await applyChannelFailure(
      port,
      running,
      result.errorMessage,
    );
    appendExecutionLog({
      at: new Date().toISOString(),
      job_id: failed.id,
      action_type: failed.action_type,
      person_id: failed.person_id,
      status: "failed",
      ok: false,
      error: result.errorMessage,
      retry_count: Number(failed.target_ref?.retry_count ?? 0),
      mode: process.env.NAVER_ADAPTER_MODE ?? "live",
    });
    traceReturn(
      "executeActionJob",
      "adapter_failed",
      result.errorMessage.slice(0, 200),
    );
    return { ok: false, job: failed, errorMessage: result.errorMessage };
  }

  const executed = await applyChannelSuccess(port, running, {
    ...options,
    skipped: result.skipped === true,
  });
  appendExecutionLog({
    at: new Date().toISOString(),
    job_id: executed.id,
    action_type: executed.action_type,
    person_id: executed.person_id,
    status: "executed",
    ok: true,
    skipped: result.skipped === true,
    mode: process.env.NAVER_ADAPTER_MODE ?? "live",
  });
  traceReturn(
    "executeActionJob",
    "executed",
    `skipped=${result.skipped === true}`,
  );
  return { ok: true, job: executed };
}

export async function applyChannelSuccess(
  port: ActionExecutionPort,
  job: ActionJob,
  options?: ExecuteActionJobOptions,
): Promise<ActionJob> {
  const now = new Date().toISOString();
  await port.updateRelationship(job.person_id, touchPatchForJob(job, now));
  const executed = await port.markJobExecuted(job.id);

  await port.updateWorkflow(job.parent_workflow_id, {
    current_state: "active",
    blocked_reason: null,
    next_action: "none",
  });

  const personLabel = options?.personDisplayName?.trim() || job.person_id;
  let summary: string;
  if (job.action_type === "comment") {
    summary = `comment executed · ${personLabel} · ${now}`;
  } else if (job.action_type === "like" && options?.skipped) {
    summary = `like skipped · already liked · ${now}`;
  } else if (job.action_type === "like") {
    summary = `like executed · ${now}`;
  } else if (job.action_type === "visit") {
    summary = `visit executed · ${now}`;
  } else if (job.action_type === "neighbor_request") {
    summary = `mutual_request executed · ${now}`;
  } else {
    summary = `채널 실행 · ${job.action_type}`;
  }

  await port.insertActivity({
    workflow_id: job.parent_workflow_id,
    person_id: job.person_id,
    action_job_id: job.id,
    decision_id: job.decision_id,
    kind: "executed",
    summary,
  });

  if (job.action_type === "visit") {
    await port.incrementOutcomeCounters({
      auto_visit_count: 1,
      time_saved_minutes_est: 0.5,
    });
  } else if (job.action_type === "like" && !options?.skipped) {
    await port.incrementOutcomeCounters({
      auto_like_count: 1,
      time_saved_minutes_est: 0.5,
    });
  }

  return executed;
}

export async function applyChannelFailure(
  port: ActionExecutionPort,
  job: ActionJob,
  errorMessage: string,
): Promise<ActionJob> {
  const failed = await port.markJobFailed(job.id, errorMessage);
  const retries = Number(failed.target_ref?.retry_count ?? 0);
  const limit = actionRetryLimit();
  const exhausted = Number.isFinite(retries) && retries >= limit;
  const retryHint = exhausted
    ? ` · retry exhausted (${retries}/${limit}) → permanently_failed next recovery`
    : ` · retry ${retries}/${limit}`;

  await port.updateWorkflow(job.parent_workflow_id, {
    current_state: "blocked",
    blocked_reason: errorMessage,
    next_action: "none",
  });

  await port.insertActivity({
    workflow_id: job.parent_workflow_id,
    person_id: job.person_id,
    action_job_id: job.id,
    decision_id: job.decision_id,
    kind: "blocked",
    summary: `실행 실패 · ${errorMessage}${retryHint}`,
  });

  return failed;
}

/** List failed ActionJobs (optional retry filter). */
export async function listFailedActionJobsForRetry(
  list: (opts?: {
    limit?: number;
    personId?: string;
    retryLimit?: number;
  }) => Promise<ActionJob[]>,
  opts?: { limit?: number; personId?: string },
): Promise<ActionJob[]> {
  return list({
    ...opts,
    retryLimit: actionRetryLimit(),
  });
}
