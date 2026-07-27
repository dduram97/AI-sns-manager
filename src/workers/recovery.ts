/**
 * ActionJob stuck-running recovery + retry policy.
 * Called at the start of Agent Tick (before sync).
 * Does not touch Decision Engine / Workflow / Approval UX.
 */

import { actionRetryLimit } from "../adapters/actionExecutionGuards";
import {
  executeActionJob,
  type ActionExecutionPort,
} from "../adapters/executeActionJob";
import { appendExecutionLog } from "../adapters/executionLog";
import type { Repositories } from "../repositories/index";
import type { ActionJob } from "./types";
import {
  ERROR_RETRY_EXHAUSTED,
  ERROR_STUCK_RUNNING,
  isBundledLikeHeldByOpenApproval,
  isRetryableFailedJob,
  jobRetryCount,
  recoveryRetryBatchLimit,
  shouldPermanentlyFail,
  stuckRunningTimeoutMs,
} from "./actionRetryPolicy";

export type ActionRecoveryResult = {
  stuckRecovered: number;
  permanentlyFailed: number;
  retried: number;
  retrySucceeded: number;
  retryFailed: number;
  jobIds: string[];
  logs: string[];
};

function toPort(repos: Repositories): ActionExecutionPort {
  return {
    markJobRunning: (jobId) => repos.markActionRunning(jobId),
    markJobExecuted: (jobId) => repos.markActionExecuted(jobId),
    markJobFailed: (jobId, message) => repos.markActionFailed(jobId, message),
    updateRelationship: (personId, patch) =>
      repos.updateRelationship(personId, patch),
    updateWorkflow: (workflowId, patch) =>
      repos.updateWorkflow(workflowId, patch),
    insertActivity: (input) => repos.insertActivity(input),
    incrementOutcomeCounters: (deltas) =>
      repos.incrementOutcomeCounters(deltas),
    getPolicy: () => repos.getPolicy(),
    getOutcomeToday: () => repos.ensureOutcomeToday(),
    findRecentExecutedByPerson: (personId, actionType, limit) =>
      repos.findRecentExecutedByPerson(personId, actionType, limit),
  };
}

/** Skip recovery while Approval Inbox still owns the bundle (comment pending/failed). */
async function isHeldBundledLike(
  repos: Repositories,
  job: ActionJob,
): Promise<boolean> {
  if (job.action_type !== "like" || !job.bundle_id) return false;
  const siblings = await repos.listActionJobsByBundleId(job.bundle_id);
  const openApprovalJobIds = new Set<string>();
  for (const sibling of siblings) {
    if (sibling.action_type !== "comment" || sibling.status !== "failed") {
      continue;
    }
    const open = await repos.findOpenApprovalByActionJobId(sibling.id);
    if (open) openApprovalJobIds.add(sibling.id);
  }
  return isBundledLikeHeldByOpenApproval(job, siblings, {
    openApprovalJobIds,
  });
}

async function recoverOneStuck(
  repos: Repositories,
  job: ActionJob,
  timeoutMs: number,
): Promise<ActionJob> {
  const msg = `stuck_running_timeout (>${timeoutMs}ms since updated_at)`;
  const failed = await repos.markActionFailedWithCode(
    job.id,
    msg,
    ERROR_STUCK_RUNNING,
  );

  await repos.insertActivity({
    workflow_id: job.parent_workflow_id,
    person_id: job.person_id,
    action_job_id: job.id,
    decision_id: job.decision_id,
    kind: "blocked",
    summary: `stuck running recovered · ${ERROR_STUCK_RUNNING} · retry ${jobRetryCount(failed)}`,
  });

  appendExecutionLog({
    at: new Date().toISOString(),
    job_id: failed.id,
    action_type: failed.action_type,
    person_id: failed.person_id,
    status: "failed",
    ok: false,
    error: msg,
    retry_count: jobRetryCount(failed),
    mode: process.env.NAVER_ADAPTER_MODE ?? "live",
  });

  if (shouldPermanentlyFail(failed)) {
    return promotePermanentlyFailed(repos, failed);
  }
  return failed;
}

async function promotePermanentlyFailed(
  repos: Repositories,
  job: ActionJob,
): Promise<ActionJob> {
  const limit = actionRetryLimit();
  const msg =
    job.error ?? `retry_limit_exhausted (${jobRetryCount(job)}/${limit})`;
  const permanent = await repos.markActionPermanentlyFailed(
    job.id,
    msg,
    ERROR_RETRY_EXHAUSTED,
  );

  await repos.insertActivity({
    workflow_id: job.parent_workflow_id,
    person_id: job.person_id,
    action_job_id: job.id,
    decision_id: job.decision_id,
    kind: "blocked",
    summary: `permanently_failed · ${ERROR_RETRY_EXHAUSTED} · ${jobRetryCount(permanent)}/${limit}`,
  });

  appendExecutionLog({
    at: new Date().toISOString(),
    job_id: permanent.id,
    action_type: permanent.action_type,
    person_id: permanent.person_id,
    status: "failed",
    ok: false,
    error: msg,
    retry_count: jobRetryCount(permanent),
    mode: process.env.NAVER_ADAPTER_MODE ?? "live",
  });

  return permanent;
}

/**
 * 1) stuck running → failed (+ error_code, retry_count, Activity)
 * 2) exhausted failed → permanently_failed
 * 3) bounded retry of retryable failed jobs (low-risk only)
 */
export async function runActionJobRecovery(
  repos: Repositories,
  opts?: { skipRetry?: boolean },
): Promise<ActionRecoveryResult> {
  const logs: string[] = [];
  const jobIds: string[] = [];
  let stuckRecovered = 0;
  let permanentlyFailed = 0;
  let retried = 0;
  let retrySucceeded = 0;
  let retryFailed = 0;

  const timeoutMs = stuckRunningTimeoutMs();
  const olderThanIso = new Date(Date.now() - timeoutMs).toISOString();
  const stuck = await repos.listStuckRunningActionJobs({
    olderThanIso,
    limit: 50,
  });
  logs.push(
    `recovery:stuck_candidates=${stuck.length} timeout_ms=${timeoutMs}`,
  );

  for (const job of stuck) {
    try {
      const next = await recoverOneStuck(repos, job, timeoutMs);
      stuckRecovered += 1;
      jobIds.push(next.id);
      if (next.status === "permanently_failed") {
        permanentlyFailed += 1;
        logs.push(`recovery:stuck→permanently_failed id=${next.id}`);
      } else {
        logs.push(
          `recovery:stuck→failed id=${next.id} retry=${jobRetryCount(next)}`,
        );
      }
    } catch (err) {
      logs.push(
        `recovery:stuck_error id=${job.id} ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const limit = actionRetryLimit();
  const exhausted = await repos.listExhaustedFailedActionJobs({
    retryLimit: limit,
    limit: 50,
  });
  for (const job of exhausted) {
    if (!shouldPermanentlyFail(job, limit)) continue;
    if (await isHeldBundledLike(repos, job)) {
      logs.push(
        `recovery:skip_permanent_held_by_approval id=${job.id}`,
      );
      continue;
    }
    try {
      const permanent = await promotePermanentlyFailed(repos, job);
      permanentlyFailed += 1;
      jobIds.push(permanent.id);
      logs.push(`recovery:failed→permanently_failed id=${permanent.id}`);
    } catch (err) {
      logs.push(
        `recovery:permanent_error id=${job.id} ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (!opts?.skipRetry) {
    const batch = recoveryRetryBatchLimit();
    if (batch > 0) {
      const candidates = await repos.listFailedActionJobs({
        limit: batch,
        retryLimit: limit,
      });
      const port = toPort(repos);
      for (const job of candidates) {
        if (!isRetryableFailedJob(job, limit)) continue;
        // Only auto-retry low-risk (visit/like) — high-risk stays Approval path
        if (job.risk !== "low") continue;
        if (await isHeldBundledLike(repos, job)) {
          logs.push(`recovery:skip_retry_held_by_approval id=${job.id}`);
          continue;
        }
        retried += 1;
        jobIds.push(job.id);
        try {
          const outcome = await executeActionJob(port, job);
          if (outcome.ok) {
            retrySucceeded += 1;
            logs.push(`recovery:retry_ok id=${job.id} type=${job.action_type}`);
          } else {
            retryFailed += 1;
            if (shouldPermanentlyFail(outcome.job)) {
              await promotePermanentlyFailed(repos, outcome.job);
              permanentlyFailed += 1;
              logs.push(
                `recovery:retry_fail→permanent id=${job.id} err=${outcome.errorMessage}`,
              );
            } else {
              logs.push(
                `recovery:retry_fail id=${job.id} err=${outcome.errorMessage}`,
              );
            }
          }
        } catch (err) {
          retryFailed += 1;
          logs.push(
            `recovery:retry_error id=${job.id} ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  logs.push(
    `recovery:done stuck=${stuckRecovered} permanent=${permanentlyFailed} retried=${retried} ok=${retrySucceeded} fail=${retryFailed}`,
  );

  return {
    stuckRecovered,
    permanentlyFailed,
    retried,
    retrySucceeded,
    retryFailed,
    jobIds,
    logs,
  };
}
