/**
 * Decision Rule Pipeline — ARCHITECTURE_SPEC §6 / §16 / §17
 * Decision NEVER writes to DB. Returns DecisionOutput only.
 */

import type {
  DecisionContext,
  DecisionOutput,
} from "../../workers/types";
import { applyNormalizeEvents } from "./rules/normalize";
import { applyRelationshipEvaluation } from "./rules/relationship/index";
import { applyPriorityCalculation } from "./rules/priority/index";
import { applyRiskEvaluation } from "./rules/risk/index";
import { applyGoalEvaluation } from "./rules/goal/index";
import { applyWorkflowTransition } from "./rules/transition/index";
import { applyActionCandidateGeneration } from "./rules/action/index";
import { applyApprovalRequirementCheck } from "./rules/action/approval";
import { applyPolicyGates } from "./rules/policy/index";
import { applyOutcomeFeedback } from "./rules/outcome/index";
import { emitFromBlackboard } from "./rules/emit";

export function runRulePipeline(ctx: DecisionContext): DecisionOutput {
  applyNormalizeEvents(ctx);
  if (ctx.blackboard.terminal) return ctx.blackboard.terminal;

  applyRelationshipEvaluation(ctx);
  applyPriorityCalculation(ctx);
  applyRiskEvaluation(ctx);
  applyGoalEvaluation(ctx);
  applyWorkflowTransition(ctx);
  applyActionCandidateGeneration(ctx);
  applyApprovalRequirementCheck(ctx);
  applyPolicyGates(ctx);
  if (ctx.blackboard.terminal) return ctx.blackboard.terminal;

  applyOutcomeFeedback(ctx);
  return emitFromBlackboard(ctx);
}
