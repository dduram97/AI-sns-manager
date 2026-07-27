import type {
  ActionCandidate,
  DecisionContext,
  DecisionOutput,
  GoalCode,
  WorkflowPatch,
} from "../../../workers/types";
import {
  PRIORITY_BAND_RANK,
  bestGoalRank,
  buildExplain,
} from "../helpers";

function mergePatch(
  transition: DecisionContext["blackboard"]["transition"],
  extra?: WorkflowPatch,
): WorkflowPatch {
  const patch: WorkflowPatch = {};
  if (transition?.to_stage) patch.current_stage = transition.to_stage;
  if (transition?.to_state) patch.current_state = transition.to_state;
  // Explicit emit fields win over transition suggestions
  // (e.g. create_approval must stay approval_pending)
  return { ...patch, ...extra };
}

/**
 * Select final candidate: Priority band → Goal rank (G5 capped) → user time → score
 */
export function selectActionCandidate(
  ctx: DecisionContext,
): ActionCandidate | undefined {
  const g5Blocked = ctx.blackboard.goal.g5_capped && ctx.blackboard.goal.unmet;

  const candidates = [...ctx.blackboard.action_candidates].filter((c) => {
    if (!g5Blocked) return true;
    const onlyG5 =
      c.supports_goals.length > 0 &&
      c.supports_goals.every((g) => g === "lagging_reach");
    return !onlyG5;
  });

  candidates.sort((a, b) => {
    const bandA = PRIORITY_BAND_RANK[a.priority_band ?? "observe"] ?? 9;
    const bandB = PRIORITY_BAND_RANK[b.priority_band ?? "observe"] ?? 9;
    if (bandA !== bandB) return bandA - bandB;

    const ga = bestGoalRank(a.supports_goals as GoalCode[]);
    const gb = bestGoalRank(b.supports_goals as GoalCode[]);
    if (ga !== gb) return ga - gb;

    if (a.estimated_user_time_cost !== b.estimated_user_time_cost) {
      return a.estimated_user_time_cost - b.estimated_user_time_cost;
    }
    return b.score - a.score;
  });

  return candidates[0];
}

/** Pipeline stage 11 — Emit single DecisionOutput with Explain */
export function emitFromBlackboard(ctx: DecisionContext): DecisionOutput {
  if (ctx.blackboard.terminal) {
    const t = ctx.blackboard.terminal;
    const explain = buildExplain(ctx, t.reason_short, t.reasons ?? []);
    return {
      ...t,
      ...explain,
      rule_ids: [...new Set([...explain.rule_ids, ...t.rule_ids])],
    };
  }

  const top = selectActionCandidate(ctx);
  const transition = ctx.blackboard.transition;
  const relEval = ctx.blackboard.relationship_eval;

  const basePatch: WorkflowPatch = {
    priority: ctx.blackboard.priority_score,
    relationship: {
      score_delta: relEval.score_delta,
      temperature_delta: relEval.temperature_delta,
      stage: transition?.to_stage,
    },
  };

  if (!top || top.action_type === "observe") {
    const reason = top?.reason_short ?? "관찰만";
    const patch = mergePatch(transition, {
      ...basePatch,
      next_action: "observe",
      current_state: transition?.to_state ?? "waiting",
      waiting_for: transition?.to_state === "waiting" ? "new_post" : undefined,
    });
    return {
      kind: "observe",
      workflow_patch: patch,
      ...buildExplain(ctx, reason, [
        `candidates=${ctx.blackboard.action_candidates.length}`,
        `selected=observe`,
      ]),
    };
  }

  if (
    ctx.blackboard.approval_required ||
    top.risk === "high" ||
    top.action_type === "comment" ||
    top.action_type === "neighbor_request" ||
    top.action_type === "threads_reply"
  ) {
    const draft = ctx.blackboard.draft ?? {
      action_type: top.action_type as
        | "comment"
        | "neighbor_request"
        | "threads_reply",
      body: top.draft_body ?? "",
      alternatives: top.draft_alternatives ?? [],
      target_ref: top.target_ref ?? {},
      channel: top.channel ?? "blog",
    };
    return {
      kind: "create_approval",
      draft,
      workflow_patch: mergePatch(transition, {
        ...basePatch,
        current_stage: "approval_pending",
        current_state: "active",
        next_action: draft.action_type,
      }),
      ...buildExplain(ctx, top.reason_short, [
        `selected=${top.action_type}`,
        `band=${top.priority_band ?? "n/a"}`,
        `approval_required=true`,
      ]),
    };
  }

  return {
    kind: "create_action",
    action: top,
    workflow_patch: mergePatch(transition, {
      ...basePatch,
      next_action: top.action_type as WorkflowPatch["next_action"],
      current_state: "active",
    }),
    ...buildExplain(ctx, top.reason_short, [
      `selected=${top.action_type}`,
      `band=${top.priority_band ?? "n/a"}`,
      `candidates=${ctx.blackboard.action_candidates.length}`,
    ]),
  };
}
