import type { DecisionContext } from "../../../../workers/types";
import { fire } from "../../helpers";

/** Pipeline stage 8 — Approval Requirement Check */
export function applyApprovalRequirementCheck(ctx: DecisionContext): void {
  const top = [...ctx.blackboard.action_candidates].sort(
    (a, b) => b.score - a.score,
  )[0];

  const highRiskTypes = new Set([
    "comment",
    "neighbor_request",
    "threads_reply",
  ]);

  let required = false;
  if (top && highRiskTypes.has(top.action_type)) {
    const preset = ctx.policy.preset;
    if (preset === "default" || preset === "supervise") {
      required = true;
    } else if (top.action_type === "comment") {
      required = !ctx.policy.high_risk_auto_comment;
    } else if (top.action_type === "neighbor_request") {
      required = !ctx.policy.high_risk_auto_request;
    } else {
      required = true;
    }
  }

  ctx.blackboard.approval_required = required;
  if (required && ctx.blackboard.risk.level === "low") {
    ctx.blackboard.risk.level = "medium";
  }
  if (required) {
    ctx.blackboard.risk.reasons.push("approval_required");
  }
  fire(
    ctx,
    "approval.requirement",
    "critical",
    ["natural_interaction", "minimize_user_time"],
    `required=${required}`,
  );
}
