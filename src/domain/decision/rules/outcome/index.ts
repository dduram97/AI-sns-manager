import type { DecisionContext } from "../../../../workers/types";
import { clamp, fire } from "../../helpers";

/** Pipeline stage 10 — Outcome Feedback → Goal scores */
export function applyOutcomeFeedback(ctx: DecisionContext): void {
  const g = ctx.blackboard.goal.scores;

  if (ctx.outcome_today.mutual_reaction_count > 0) {
    g.relationship_health = clamp(g.relationship_health + 5);
    g.lagging_reach_proxy = clamp(g.lagging_reach_proxy + 3);
    fire(ctx, "out.mutual_boost", "normal", [
      "relationship_quality",
      "lagging_reach",
    ]);
  }

  if (ctx.outcome_today.temperature_up_count > 0) {
    g.relationship_health = clamp(g.relationship_health + 3);
    fire(ctx, "out.temperature_up", "normal", ["relationship_quality"]);
  }

  if (ctx.outcome_today.intervention_minutes_est >= 8) {
    g.user_time_cost = clamp(g.user_time_cost + 20);
    fire(ctx, "out.time_budget", "high", ["minimize_user_time"]);
    if (ctx.blackboard.approval_required && g.user_time_cost > 70) {
      // G3 conflict: Approval 과다 → prefer observe / low-cost candidates
      for (const c of ctx.blackboard.action_candidates) {
        if (c.action_type === "observe") c.score += 35;
        if (c.estimated_user_time_cost > 0) c.score -= 15;
      }
      fire(
        ctx,
        "out.conflict_g3_approvals",
        "critical",
        ["minimize_user_time"],
        "Approval 과다 vs 10분",
      );
    }
  }

  // G5 feedback never promotes lagging_reach over unmet G1–G3
  if (
    ctx.blackboard.goal.unmet &&
    ctx.blackboard.goal.code !== "lagging_reach"
  ) {
    g.lagging_reach_proxy = clamp(g.lagging_reach_proxy);
    fire(ctx, "out.g5_capped", "low", ["lagging_reach"], "G5 lagging only");
  }

  fire(ctx, "out.feedback_applied", "low");
}
