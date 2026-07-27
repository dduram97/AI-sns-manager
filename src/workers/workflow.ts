/**
 * Workflow Update — DecisionOutput applied to Postgres Workflow / RelationshipState.
 */

import type { Repositories } from "../repositories/index";
import type {
  DecisionOutput,
  DecisionRecord,
  Person,
  Workflow,
  WorkflowPatch,
} from "./types";

export interface WorkflowUpdateResult {
  workflow: Workflow;
  stageChanged: boolean;
  created: boolean;
}

export async function applyWorkflowUpdate(
  repos: Repositories,
  person: Person,
  output: DecisionOutput,
  record: DecisionRecord,
): Promise<WorkflowUpdateResult> {
  let workflow = await repos.getActiveWorkflow(person.id);
  let created = false;
  let previousStage = workflow?.current_stage;

  if (!workflow) {
    workflow = await repos.createWorkflow({
      person_id: person.id,
      current_stage: "discover",
      current_state: "active",
      next_action: "none",
      last_decision_id: record.id,
    });
    await repos.setPersonActiveWorkflow(person.id, workflow.id);
    created = true;
    previousStage = undefined;
  }

  let patch: WorkflowPatch | undefined;
  switch (output.kind) {
    case "workflow_update":
      patch = output.patch;
      break;
    case "create_action":
    case "create_approval":
    case "observe":
    case "delay":
      patch = output.workflow_patch;
      break;
    case "skip":
      patch = undefined;
      break;
  }

  if (output.kind === "delay") {
    patch = {
      ...patch,
      current_state: "waiting",
      waiting_until: output.delay_until,
      waiting_for: output.waiting_for ?? patch?.waiting_for ?? null,
    };
  }

  const update: Parameters<Repositories["updateWorkflow"]>[1] = {
    last_decision_id: record.id,
  };
  if (patch?.current_stage) update.current_stage = patch.current_stage;
  if (patch?.current_state) update.current_state = patch.current_state;
  if (patch?.next_action) update.next_action = patch.next_action;
  if (patch?.waiting_until !== undefined)
    update.waiting_until = patch.waiting_until;
  if (patch?.waiting_for !== undefined)
    update.waiting_for = patch.waiting_for ?? null;
  if (patch?.priority !== undefined) update.priority = patch.priority;
  if (patch?.blocked_reason !== undefined)
    update.blocked_reason = patch.blocked_reason;
  if (patch?.goal !== undefined) update.goal = patch.goal ?? null;

  workflow = await repos.updateWorkflow(workflow.id, update);
  await repos.setPersonActiveWorkflow(person.id, workflow.id);

  const stageChanged =
    created ||
    (patch?.current_stage != null && patch.current_stage !== previousStage);

  const rel = await repos.getRelationship(person.id);
  const relPatch: Parameters<Repositories["updateRelationship"]>[1] = {};
  if (patch?.relationship?.score_delta) {
    relPatch.score = Math.max(0, rel.score + patch.relationship.score_delta);
  }
  if (patch?.relationship?.temperature_delta) {
    relPatch.temperature = Math.max(
      0,
      rel.temperature + patch.relationship.temperature_delta,
    );
  }
  if (patch?.relationship?.stage) {
    relPatch.stage = patch.relationship.stage;
  } else if (patch?.current_stage) {
    relPatch.stage = patch.current_stage;
  }
  if (Object.keys(relPatch).length > 0) {
    await repos.updateRelationship(person.id, relPatch);
  }

  return { workflow, stageChanged, created };
}
