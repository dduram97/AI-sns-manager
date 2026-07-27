/**
 * Decision step — Rule Pipeline + DecisionRecord insert.
 * Does NOT mutate Workflow / Action / Approval.
 */

import { runRulePipeline } from "../domain/decision/runRulePipeline";
import type { Repositories } from "../repositories/index";
import type {
  DecisionContext,
  DecisionOutput,
  DecisionRecord,
} from "./types";

export async function runDecision(
  repos: Repositories,
  ctx: DecisionContext,
): Promise<{ output: DecisionOutput; record: DecisionRecord }> {
  const output = runRulePipeline(ctx);

  const record = await repos.insertDecision({
    person_id: ctx.person.id,
    workflow_id: ctx.workflow?.id ?? null,
    perception_event_id: ctx.perceptions[0]?.id ?? null,
    decision_type: output.kind,
    reason_short: output.reason_short,
    reason_detail: {
      explanation: output.explanation,
      reasons: output.reasons,
      rule_ids: output.rule_ids,
      goal: ctx.blackboard.goal,
      priority_score: ctx.blackboard.priority_score,
      priority_conflicts: ctx.blackboard.priority_conflicts,
      risk: ctx.blackboard.risk,
      relationship_health: ctx.blackboard.relationship_eval.health,
      relationship_factors: ctx.blackboard.relationship_eval.factors,
      candidates: ctx.blackboard.action_candidates,
      transition: ctx.blackboard.transition,
    },
    inputs: {
      stage: ctx.workflow?.current_stage ?? ctx.relationship.stage,
      event_types: ctx.perceptions.map((p) => p.event_type),
    },
  });

  return { output, record };
}
