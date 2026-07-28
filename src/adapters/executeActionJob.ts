/**
 * Post-adapter persistence: success / failure / skip side effects + Live guards.
 * Keeps Repository structure; no Decision Engine change.
 */

import type {
  ActionJob,
  OutcomeDaily,
  PolicyProfile,
  Workflow,
} from "../workers/types";
import type { ActionFailureDetail } from "../lib/actionFailure";
import {
  classifyWorkerErrorText,
  failureToErrorColumn,
} from "../lib/actionFailure";
import { makeSkip, statusForSkip } from "../lib/actionOutcome";
import { logActionResult } from "../lib/logActionResult";
import { getChannelExecutor } from "./channelExecutor";
import type { ChannelActionResult } from "./types";
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
  markJobExecuted(
    jobId: string,
    opts?: {
      note?: string;
      executionResult?: Record<string, unknown>;
    },
  ): Promise<ActionJob>;
  markJobFailed(
    jobId: string,
    errorMessage: string,
    opts?: { errorCode?: string; failure?: ActionFailureDetail },
  ): Promise<ActionJob>;
  /** Soft skip / not_available / excluded — not counted as success or hard fail */
  markJobSkipped?(
    jobId: string,
    input: {
      status: "skipped" | "excluded";
      reasonCode: string;
      reasonMessage: string;
      failedStep?: string;
      outcome?: string;
      detail?: Record<string, unknown>;
      steps?: string[];
    },
  ): Promise<ActionJob>;
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
    kind: "executed" | "blocked" | "observed";
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
  | {
      ok: true;
      job: ActionJob;
      /** Soft skip that still resolves approval as success (e.g. like button missing in both-mode) */
      softSkipped?: boolean;
      skipReasonCode?: string;
      skipReasonMessage?: string;
      /** Neighbor excluded — not success, not hard failure */
      excluded?: boolean;
    }
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
  channelResult?: Extract<ChannelActionResult, { ok: true }>;
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

function isSoftSkipOutcome(
  outcome: string | undefined,
): outcome is "skipped" | "not_available" | "excluded" {
  return (
    outcome === "skipped" ||
    outcome === "not_available" ||
    outcome === "excluded"
  );
}

function executionResultFromSuccess(
  job: ActionJob,
  result: Extract<ChannelActionResult, { ok: true }>,
  options?: ExecuteActionJobOptions,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    ...(result.executionResult ?? {}),
    url: result.externalRef ?? null,
  };
  if (result.steps?.length) base.steps = result.steps;
  if (result.detail) base.detail = result.detail;

  if (job.action_type === "like") {
    base.already_liked = result.skipped === true || options?.skipped === true;
    base.like = {
      already_liked: base.already_liked,
      url: result.externalRef ?? null,
      ...(typeof result.executionResult?.like === "object"
        ? (result.executionResult.like as Record<string, unknown>)
        : {}),
    };
  }
  if (job.action_type === "comment") {
    base.comment = {
      url: result.externalRef ?? null,
      ...(typeof result.executionResult?.comment === "object"
        ? (result.executionResult.comment as Record<string, unknown>)
        : {}),
    };
  }
  return base;
}

function skipDetailFromResult(
  job: ActionJob,
  result: Extract<ChannelActionResult, { ok: true }>,
): ReturnType<typeof makeSkip> {
  const reasonCode =
    result.reasonCode ??
    (job.action_type === "like" ? "LIKE_BUTTON_NOT_AVAILABLE" : "SKIPPED");
  const reasonMessage =
    result.reasonMessage ??
    (job.action_type === "like"
      ? "공감 버튼이 없는 글입니다."
      : "실행 제외");
  return makeSkip({
    outcome:
      result.outcome === "excluded"
        ? "excluded"
        : result.outcome === "not_available"
          ? "not_available"
          : "skipped",
    reason_code: reasonCode,
    reason_message: reasonMessage,
    failed_step: result.failedStep ?? "button_search",
    detail: result.detail,
    steps: result.steps,
  });
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
    const executionResult =
      failed.target_ref &&
      typeof failed.target_ref === "object" &&
      !Array.isArray(failed.target_ref)
        ? ((failed.target_ref as Record<string, unknown>).execution_failure as
            | Record<string, unknown>
            | undefined) ?? null
        : null;
    logActionResult({
      jobId: failed.id,
      actionType: failed.action_type,
      status: "failed",
      errorCode:
        typeof executionResult?.error_code === "string"
          ? executionResult.error_code
          : "UNKNOWN",
      errorMessage: blocked,
      executionResult,
    });
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
    logActionResult({
      jobId: failed.id,
      actionType: failed.action_type,
      status: "failed",
      errorCode: "UNKNOWN",
      errorMessage: msg,
      executionResult:
        failed.target_ref &&
        typeof failed.target_ref === "object" &&
        !Array.isArray(failed.target_ref)
          ? ((failed.target_ref as Record<string, unknown>)
              .execution_failure as Record<string, unknown> | undefined) ?? null
          : null,
    });
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
    const failure =
      result.failure ??
      classifyWorkerErrorText(
        result.errorMessage,
        running.action_type === "comment" ? "comment_input_search" : "like_click",
      );
    const failed = await applyChannelFailure(
      port,
      running,
      failureToErrorColumn(failure),
      failure,
    );
    const executionResult =
      failed.target_ref &&
      typeof failed.target_ref === "object" &&
      !Array.isArray(failed.target_ref)
        ? ((failed.target_ref as Record<string, unknown>).execution_failure as
            | Record<string, unknown>
            | undefined) ?? null
        : null;
    logActionResult({
      jobId: failed.id,
      actionType: failed.action_type,
      status: "failed",
      errorCode: failure.error_code,
      errorMessage: failure.error_message,
      executionResult,
    });
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

  // Soft skip: like button missing, neighbor button missing, etc.
  if (isSoftSkipOutcome(result.outcome) && port.markJobSkipped) {
    const skip = skipDetailFromResult(job, result);
    const status: "skipped" | "excluded" =
      result.outcome === "excluded" ||
      statusForSkip(skip) === "excluded" ||
      (job.action_type === "neighbor_request" &&
        (result.reasonCode?.startsWith("NEIGHBOR_") ||
          result.reasonCode === "ALREADY_NEIGHBOR" ||
          result.reasonCode === "ALREADY_PENDING"))
        ? "excluded"
        : "skipped";
    const skippedJob = await port.markJobSkipped(running.id, {
      status,
      reasonCode: skip.reason_code,
      reasonMessage: skip.reason_message,
      failedStep: skip.failed_step,
      outcome: skip.outcome,
      detail: skip.detail,
      steps: skip.steps,
    });
    const executionResult =
      skippedJob.target_ref &&
      typeof skippedJob.target_ref === "object" &&
      !Array.isArray(skippedJob.target_ref)
        ? ((skippedJob.target_ref as Record<string, unknown>)
            .execution_result as Record<string, unknown> | undefined) ?? null
        : null;
    logActionResult({
      jobId: skippedJob.id,
      actionType: skippedJob.action_type,
      status,
      errorCode: skip.reason_code,
      errorMessage: skip.reason_message,
      executionResult,
    });
    await port.updateWorkflow(job.parent_workflow_id, {
      current_state: "active",
      blocked_reason: null,
      next_action: "none",
    });
    const isNeighborExcluded =
      job.action_type === "neighbor_request" && status === "excluded";
    await port.insertActivity({
      workflow_id: job.parent_workflow_id,
      person_id: job.person_id,
      action_job_id: job.id,
      decision_id: job.decision_id,
      kind: isNeighborExcluded ? "observed" : "executed",
      summary: isNeighborExcluded
        ? `neighbor excluded · ${skip.reason_message}`
        : job.action_type === "like"
          ? `like skipped · 공감 불가 (버튼 없음) · ${skip.reason_code}`
          : `${job.action_type} ${status} · ${skip.reason_code}`,
    });
    appendExecutionLog({
      at: new Date().toISOString(),
      job_id: skippedJob.id,
      action_type: skippedJob.action_type,
      person_id: skippedJob.person_id,
      status: status,
      ok: true,
      skipped: true,
      mode: process.env.NAVER_ADAPTER_MODE ?? "live",
    });
    traceReturn("executeActionJob", status, skip.reason_code);
    return {
      ok: true,
      job: skippedJob,
      softSkipped: true,
      excluded: isNeighborExcluded,
      skipReasonCode: skip.reason_code,
      skipReasonMessage: skip.reason_message,
    };
  }

  const executed = await applyChannelSuccess(port, running, {
    ...options,
    skipped: result.skipped === true,
    channelResult: result,
  });
  const executionResult =
    executed.target_ref &&
    typeof executed.target_ref === "object" &&
    !Array.isArray(executed.target_ref)
      ? ((executed.target_ref as Record<string, unknown>).execution_result as
          | Record<string, unknown>
          | undefined) ?? null
      : null;
  logActionResult({
    jobId: executed.id,
    actionType: executed.action_type,
    status: "executed",
    errorCode: null,
    errorMessage: null,
    executionResult,
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

  const executionExtra = options?.channelResult
    ? executionResultFromSuccess(job, options.channelResult, options)
    : undefined;
  const note =
    job.action_type === "like" && options?.skipped
      ? `like already_liked ${options.channelResult?.externalRef ?? ""}`.trim()
      : job.action_type === "like"
        ? `like ${options?.channelResult?.externalRef ?? ""}`.trim()
        : job.action_type === "comment"
          ? `comment ${options?.channelResult?.externalRef ?? ""}`.trim()
          : `${job.action_type} executed`;

  const executed = await port.markJobExecuted(job.id, {
    note,
    executionResult: executionExtra,
  });

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
  failure?: ActionFailureDetail,
): Promise<ActionJob> {
  const resolved =
    failure ?? classifyWorkerErrorText(errorMessage, "unknown");
  const failed = await port.markJobFailed(job.id, failureToErrorColumn(resolved), {
    errorCode: resolved.error_code,
    failure: resolved,
  });
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
