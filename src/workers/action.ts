/**
 * Low-risk Action Queue — create planned ActionJob then execute via ChannelExecutor.
 * visit / like run without Approval (ARCHITECTURE_SPEC v2.0).
 */

import {
  executeActionJob,
  type ActionExecutionPort,
} from "../adapters/executeActionJob";
import { applyBatchQueueDelay } from "../lib/batchQueueDelay";
import type { Repositories } from "../repositories/index";
import type {
  ActionJob,
  DecisionOutput,
  DecisionRecord,
  Workflow,
} from "./types";

/** Sequential like spacing within a single Agent Tick process. */
let likesQueuedInTick = 0;

export function resetLowRiskLikeBatchState(): void {
  likesQueuedInTick = 0;
}

function toPort(repos: Repositories): ActionExecutionPort {
  return {
    markJobRunning: (jobId) => repos.markActionRunning(jobId),
    markJobExecuted: (jobId) => repos.markActionExecuted(jobId),
    markJobFailed: (jobId, message) => repos.markActionFailed(jobId, message),
    markJobSkipped: (jobId, input) => repos.markActionSkipped(jobId, input),
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

export async function enqueueLowRiskAction(
  repos: Repositories,
  workflow: Workflow,
  output: Extract<DecisionOutput, { kind: "create_action" }>,
  record: DecisionRecord,
): Promise<ActionJob> {
  const actionType = output.action.action_type;
  if (actionType === "observe") {
    throw new Error("observe must not create ActionJob");
  }
  if (actionType !== "visit" && actionType !== "like") {
    throw new Error(`enqueueLowRiskAction: unexpected type ${actionType}`);
  }

  if (actionType === "like") {
    if (likesQueuedInTick > 0) {
      await applyBatchQueueDelay();
    }
    likesQueuedInTick += 1;
  }

  const planned = await repos.createActionJob({
    parent_workflow_id: workflow.id,
    person_id: workflow.person_id,
    channel: output.action.channel ?? "blog",
    action_type: actionType,
    risk: "low",
    status: "planned",
    target_ref: output.action.target_ref ?? {},
    decision_id: record.id,
    inbox_priority: 0,
  });

  const outcome = await executeActionJob(toPort(repos), planned);
  return outcome.job;
}
