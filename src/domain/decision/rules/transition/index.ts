import type {
  DecisionContext,
  RelationshipStage,
  WorkflowState,
} from "../../../../workers/types";
import { fire } from "../../helpers";

function setTransition(
  ctx: DecisionContext,
  to_stage: RelationshipStage,
  to_state: WorkflowState,
  reason: string,
  ruleId: string,
  goals: Array<
    | "relationship_quality"
    | "natural_interaction"
    | "minimize_user_time"
    | "sustained_growth"
    | "lagging_reach"
  >,
  priority: "critical" | "high" | "normal" | "low" = "normal",
) {
  ctx.blackboard.transition = { to_stage, to_state, reason };
  fire(ctx, ruleId, priority, goals, reason);
}

/**
 * Pipeline stage 6 — Workflow Transition
 * discover → warming → waiting_new_post → approval_pending → early → maintain → vip | risk
 */
export function applyWorkflowTransition(ctx: DecisionContext): void {
  const stage = ctx.workflow?.current_stage ?? ctx.relationship.stage;
  const hasNewPost = ctx.blackboard.normalized_events.some(
    (e) => e.event_type === "new_post",
  );
  const suggested = ctx.blackboard.relationship_eval.suggested_stage;
  const flags = ctx.blackboard.relationship_eval.flags;

  const visits = ctx.recent_action_jobs.filter(
    (j) => j.action_type === "visit" && j.status === "executed",
  ).length;
  const likes = ctx.recent_action_jobs.filter(
    (j) => j.action_type === "like" && j.status === "executed",
  ).length;
  const warmingDone = visits >= 1 && likes >= 1;

  // risk
  if (suggested === "risk" && stage !== "risk") {
    setTransition(
      ctx,
      "risk",
      "active",
      "cooling / long no-touch → risk",
      "transition.to_risk",
      ["relationship_quality", "natural_interaction"],
      "high",
    );
    return;
  }

  if (stage === "risk" && ctx.blackboard.relationship_eval.health >= 55) {
    setTransition(
      ctx,
      "maintain",
      "active",
      "risk recovered → maintain",
      "transition.risk_recover",
      ["relationship_quality"],
      "normal",
    );
    return;
  }

  // discover → warming
  if (stage === "discover") {
    setTransition(
      ctx,
      "warming",
      "active",
      "discover → warming",
      "transition.discover_to_warming",
      ["sustained_growth"],
    );
    return;
  }

  // warming → waiting_new_post
  if (stage === "warming" && warmingDone && !hasNewPost) {
    setTransition(
      ctx,
      "waiting_new_post",
      "waiting",
      "warming done; wait for post",
      "transition.warming_to_wait",
      ["natural_interaction", "sustained_growth"],
    );
    return;
  }

  // warming | waiting → approval_pending
  if (
    (stage === "warming" || stage === "waiting_new_post") &&
    warmingDone &&
    hasNewPost
  ) {
    setTransition(
      ctx,
      "approval_pending",
      "active",
      "warming done + new post → approval",
      "transition.to_approval_pending",
      ["sustained_growth", "natural_interaction"],
      "high",
    );
    return;
  }

  // approval_pending stays until approve path advances (worker); observe if no candidates later
  if (stage === "approval_pending") {
    fire(
      ctx,
      "transition.approval_hold",
      "normal",
      ["minimize_user_time"],
      "await supervisor",
    );
    return;
  }

  // early_relationship → maintain (stable temp)
  if (
    stage === "early_relationship" &&
    ctx.relationship.temperature >= 55 &&
    !flags.includes("stale_touch")
  ) {
    setTransition(
      ctx,
      "maintain",
      "active",
      "early → maintain",
      "transition.early_to_maintain",
      ["relationship_quality"],
    );
    return;
  }

  // maintain → vip
  if (
    stage === "maintain" &&
    (ctx.relationship.temperature >= 75 || flags.includes("vip_candidate")) &&
    ctx.blackboard.relationship_eval.health >= 70
  ) {
    setTransition(
      ctx,
      "vip",
      "active",
      "maintain → vip",
      "transition.maintain_to_vip",
      ["relationship_quality"],
      "high",
    );
    return;
  }

  // maintain / vip + new post → engage (stay stage)
  if (
    (stage === "maintain" ||
      stage === "vip" ||
      stage === "early_relationship") &&
    hasNewPost
  ) {
    fire(
      ctx,
      "transition.maintain_engage",
      "normal",
      ["relationship_quality"],
      "new_post engage",
    );
    return;
  }

  // maintain / vip idle → waiting
  if (!hasNewPost && (stage === "maintain" || stage === "vip")) {
    setTransition(
      ctx,
      stage,
      "waiting",
      "no post; observe",
      "transition.wait_new_post",
      ["minimize_user_time"],
      "low",
    );
  }
}
