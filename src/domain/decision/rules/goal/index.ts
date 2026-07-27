import type {
  DecisionContext,
  GoalCode,
} from "../../../../workers/types";
import { clamp, fire } from "../../helpers";

/**
 * Pipeline stage 5 — Goal Evaluation (§7)
 * G1≻G2≻G3≻G4≻G5 — G5 never beats G1–G3.
 */
export function applyGoalEvaluation(ctx: DecisionContext): void {
  const rel = ctx.relationship;
  const flags = ctx.blackboard.relationship_eval.flags;
  const health = ctx.blackboard.relationship_eval.health;
  const openApprovals = ctx.recent_approvals.filter(
    (a) => !a.resolved_at,
  ).length;
  const risk = ctx.blackboard.risk;

  const relationship_health = clamp(
    health * 0.7 +
      (rel.stage === "maintain" || rel.stage === "vip" ? 10 : 0) +
      (ctx.outcome_today.mutual_reaction_count > 0 ? 8 : 0) -
      (flags.includes("cooling") ? 10 : 0),
  );

  const trust_level = clamp(
    85 -
      (flags.includes("sponsored_likely") ? 30 : 0) -
      (risk.reasons.includes("identical_phrase") ? 25 : 0) -
      (risk.reasons.includes("possible_similar_phrase") ? 12 : 0) -
      (risk.reasons.includes("short_interval_comment") ? 15 : 0) -
      (risk.reasons.includes("short_interval_request") ? 15 : 0) +
      (rel.stage === "warming" ? 5 : 0),
  );

  const user_time_cost = clamp(
    openApprovals * 18 +
      ctx.outcome_today.intervention_minutes_est * 6 +
      ctx.outcome_today.approval_pending_count * 5,
  );

  const growth_opportunity = clamp(
    (["discover", "warming"].includes(ctx.workflow?.current_stage ?? rel.stage)
      ? 72
      : 28) - (flags.includes("sponsored_likely") ? 40 : 0),
  );

  const engagement_potential = clamp(
    ctx.blackboard.normalized_events.some((e) => e.event_type === "new_post")
      ? 78
      : 32 + rel.temperature * 0.2,
  );

  const lagging_reach_proxy = clamp(
    Number(ctx.outcome_today.lagging_metrics?.views_proxy ?? 30),
  );

  const scores = {
    relationship_health: clamp(relationship_health),
    trust_level: clamp(trust_level),
    user_time_cost: clamp(user_time_cost),
    growth_opportunity: clamp(growth_opportunity),
    engagement_potential: clamp(engagement_potential),
    lagging_reach_proxy: clamp(lagging_reach_proxy),
  };

  // Active goal: G1 → G2 → G3 → G4. G5 never selected as active when G1–G3 unmet.
  let code: GoalCode = "relationship_quality";
  if (scores.relationship_health < 55) {
    code = "relationship_quality";
  } else if (scores.trust_level < 55 || risk.level === "high") {
    code = "natural_interaction";
  } else if (scores.user_time_cost > 55) {
    code = "minimize_user_time";
  } else if (scores.growth_opportunity > 65) {
    code = "sustained_growth";
  } else {
    code = "relationship_quality";
  }

  // Explicit G5 cap: lagging_reach cannot become active_code over G1–G3
  const g5_capped = true;
  if (
    scores.lagging_reach_proxy > 80 &&
    scores.relationship_health >= 55 &&
    scores.trust_level >= 55 &&
    scores.user_time_cost <= 55
  ) {
    // Still prefer G4 over G5 for action selection; G5 is lagging signal only
    fire(
      ctx,
      "goal.g5_lagging_only",
      "low",
      ["lagging_reach"],
      "G5 cannot outrank G1–G3",
    );
  }

  ctx.blackboard.goal = {
    code,
    unmet:
      scores.relationship_health < 55 ||
      scores.trust_level < 55 ||
      scores.user_time_cost > 70,
    scores,
    active_rank: [
      "relationship_quality",
      "natural_interaction",
      "minimize_user_time",
      "sustained_growth",
      "lagging_reach",
    ],
    g5_capped,
  };

  fire(
    ctx,
    "goal.evaluate",
    "high",
    [code],
    `active=${code} g5_capped=${g5_capped}`,
  );
}
