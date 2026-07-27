/**
 * Failed ActionJob ops helpers (Live retry queue). No UI.
 */

import "server-only";

import { createServiceClient } from "@/lib/supabase";
import { actionRetryLimit } from "@/adapters/actionExecutionGuards";
import {
  executeActionJob,
  type ActionExecutionPort,
} from "@/adapters/executeActionJob";
import { createRepositories } from "@/repositories/index";
import { runActionJobRecovery } from "@/workers/recovery";
import type { ActionJob } from "@/workers/types";

function toPort(
  repos: ReturnType<typeof createRepositories>,
): ActionExecutionPort {
  return {
    markJobRunning: (jobId) => repos.markActionRunning(jobId),
    markJobExecuted: (jobId) => repos.markActionExecuted(jobId),
    markJobFailed: (jobId, message) => repos.markActionFailed(jobId, message),
    updateRelationship: (personId, patch) =>
      repos.updateRelationship(personId, patch),
    updateWorkflow: (workflowId, patch) => repos.updateWorkflow(workflowId, patch),
    insertActivity: (input) => repos.insertActivity(input),
    incrementOutcomeCounters: (deltas) => repos.incrementOutcomeCounters(deltas),
    getPolicy: () => repos.getPolicy(),
    getOutcomeToday: () => repos.ensureOutcomeToday(),
    findRecentExecutedByPerson: (personId, actionType, limit) =>
      repos.findRecentExecutedByPerson(personId, actionType, limit),
  };
}

/** Query failed ActionJobs (optionally only retryable under RETRY_LIMIT). */
export async function listFailedActionJobs(opts?: {
  limit?: number;
  personId?: string;
  retryableOnly?: boolean;
}): Promise<ActionJob[]> {
  const repos = createRepositories(createServiceClient());
  return repos.listFailedActionJobs({
    limit: opts?.limit,
    personId: opts?.personId,
    retryLimit: opts?.retryableOnly === false ? undefined : actionRetryLimit(),
  });
}

/** Requeue one failed job then execute (planned → running → executed|failed). */
export async function retryFailedActionJob(jobId: string): Promise<ActionJob> {
  const repos = createRepositories(createServiceClient());
  const limit = actionRetryLimit();
  const planned = await repos.requeueFailedActionJob(jobId, limit);
  const outcome = await executeActionJob(toPort(repos), planned);
  return outcome.job;
}

/** Manual: run stuck recovery + retry policy (same as tick recovery phase). */
export async function runStuckJobRecovery(opts?: {
  skipRetry?: boolean;
}) {
  const repos = createRepositories(createServiceClient());
  return runActionJobRecovery(repos, opts);
}
