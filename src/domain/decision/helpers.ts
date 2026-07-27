import type {
  DecisionBlackboard,
  DecisionContext,
  DecisionExplainFields,
  GoalCode,
  GoalScoreVector,
  RelationshipStage,
} from "../../workers/types";

export function emptyBlackboard(): DecisionBlackboard {
  const scores: GoalScoreVector = {
    relationship_health: 50,
    engagement_potential: 50,
    trust_level: 70,
    growth_opportunity: 40,
    user_time_cost: 20,
    lagging_reach_proxy: 30,
  };
  const stage: RelationshipStage = "discover";
  return {
    normalized_events: [],
    relationship_eval: {
      health: 50,
      factors: {
        days_since_visit: null,
        days_since_like: null,
        days_since_comment: null,
        days_since_reply: null,
        days_since_approval: null,
        days_since_request: null,
        stage,
        temperature: 0,
        score: 0,
      },
      flags: [],
    },
    priority_score: 0,
    priority_conflicts: [],
    risk: { level: "low", reasons: [] },
    goal: {
      code: "relationship_quality",
      unmet: false,
      scores,
      active_rank: [
        "relationship_quality",
        "natural_interaction",
        "minimize_user_time",
        "sustained_growth",
        "lagging_reach",
      ],
      g5_capped: true,
    },
    action_candidates: [],
    approval_required: false,
    rule_fires: [],
    reasons: [],
  };
}

export function fire(
  ctx: DecisionContext,
  rule_id: string,
  priority: "critical" | "high" | "normal" | "low",
  supports_goals?: GoalCode[],
  note?: string,
): void {
  ctx.blackboard.rule_fires.push({ rule_id, priority, supports_goals, note });
  if (note) {
    ctx.blackboard.reasons.push(`[${rule_id}] ${note}`);
  } else {
    ctx.blackboard.reasons.push(`[${rule_id}]`);
  }
}

export function clamp(n: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, n));
}

export function daysSince(
  iso: string | null | undefined,
  now: Date,
): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return (now.getTime() - t) / (1000 * 60 * 60 * 24);
}

export function hoursSince(
  iso: string | null | undefined,
  now: Date,
): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return (now.getTime() - t) / (1000 * 60 * 60);
}

/** Build Decision Explain fields from blackboard + short reason */
export function buildExplain(
  ctx: DecisionContext,
  reason_short: string,
  extraReasons: string[] = [],
): DecisionExplainFields {
  const rule_ids = [
    ...new Set(ctx.blackboard.rule_fires.map((r) => r.rule_id)),
  ];
  const reasons = [
    ...ctx.blackboard.reasons,
    ...extraReasons,
    `goal=${ctx.blackboard.goal.code}`,
    `risk=${ctx.blackboard.risk.level}`,
    `priority=${ctx.blackboard.priority_score}`,
    `health=${ctx.blackboard.relationship_eval.health}`,
  ];
  const explanation = [
    reason_short,
    `관계 건강도 ${ctx.blackboard.relationship_eval.health}/100`,
    `활성 Goal: ${ctx.blackboard.goal.code}`,
    `Risk: ${ctx.blackboard.risk.level}`,
    ctx.blackboard.priority_conflicts.length > 0
      ? `Conflict: ${ctx.blackboard.priority_conflicts.join(" → ")}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return { reason_short, explanation, reasons, rule_ids };
}

export const GOAL_RANK: GoalCode[] = [
  "relationship_quality",
  "natural_interaction",
  "minimize_user_time",
  "sustained_growth",
  "lagging_reach",
];

/** Best (lowest index) among G1–G4; G5 alone ranks last and never beats G1–G3 */
export function bestGoalRank(goals: GoalCode[]): number {
  const primary = goals.filter((g) => g !== "lagging_reach");
  const pool = primary.length > 0 ? primary : goals;
  let best = 99;
  for (const g of pool) {
    const i = GOAL_RANK.indexOf(g);
    if (i >= 0 && i < best) best = i;
  }
  return best;
}

export const PRIORITY_BAND_RANK: Record<string, number> = {
  vip_neglect: 0,
  approval_pending: 1,
  new_post: 2,
  warming_done: 3,
  discover: 4,
  maintain: 5,
  observe: 9,
};
