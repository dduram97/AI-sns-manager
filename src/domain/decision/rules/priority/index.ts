import type { DecisionContext } from "../../../../workers/types";
import { clamp, fire } from "../../helpers";

/**
 * Pipeline stage 3 — Priority Calculation + Conflict resolution
 * Order: VIP 방치 → Approval Pending → 새 글 → Warming 완료 → Discover
 */
export function applyPriorityCalculation(ctx: DecisionContext): void {
  const stage = ctx.workflow?.current_stage ?? ctx.relationship.stage;
  const flags = ctx.blackboard.relationship_eval.flags;
  const conflicts: string[] = [];
  let score = 20;

  const hasNewPost = ctx.blackboard.normalized_events.some(
    (e) => e.event_type === "new_post",
  );
  const openApprovals = ctx.recent_approvals.filter((a) => !a.resolved_at);
  const visits = ctx.recent_action_jobs.filter(
    (j) => j.action_type === "visit" && j.status === "executed",
  ).length;
  const likes = ctx.recent_action_jobs.filter(
    (j) => j.action_type === "like" && j.status === "executed",
  ).length;
  const warmingDone = visits >= 1 && likes >= 1;

  // Conflict ladder (first match wins as dominant signal)
  if (
    flags.includes("vip_neglect") ||
    (stage === "vip" && flags.includes("stale_touch"))
  ) {
    conflicts.push("vip_neglect");
    score = 95;
    fire(
      ctx,
      "prio.vip_neglect",
      "critical",
      ["relationship_quality"],
      "VIP 방치 우선",
    );
  } else if (openApprovals.length > 0 || stage === "approval_pending") {
    conflicts.push("approval_pending");
    score = 88;
    fire(ctx, "prio.approval_pending", "critical", ["minimize_user_time"]);
  } else if (hasNewPost) {
    conflicts.push("new_post");
    score = 82;
    fire(ctx, "prio.new_post", "high", ["relationship_quality"]);
  } else if (
    warmingDone &&
    ["warming", "waiting_new_post", "discover"].includes(stage)
  ) {
    conflicts.push("warming_done");
    score = 70;
    fire(ctx, "prio.warming_done", "high", [
      "sustained_growth",
      "natural_interaction",
    ]);
  } else if (stage === "discover") {
    conflicts.push("discover");
    score = 45;
    fire(ctx, "prio.discover", "normal", ["sustained_growth"]);
  } else {
    const stageBase: Record<string, number> = {
      approval_pending: 80,
      vip: 70,
      maintain: 55,
      early_relationship: 50,
      warming: 45,
      waiting_new_post: 35,
      discover: 30,
      risk: 40,
    };
    score = stageBase[stage] ?? 20;
    conflicts.push(`stage:${stage}`);
    fire(ctx, "prio.base_stage", "normal", ["relationship_quality"], stage);
  }

  // Secondary boosts (do not reorder conflict winner)
  if (flags.includes("vip_candidate") && !conflicts.includes("vip_neglect")) {
    score += 8;
    fire(ctx, "prio.vip", "high", ["relationship_quality"]);
  }
  if (openApprovals.length > 0 && !conflicts.includes("approval_pending")) {
    score += 12;
    fire(ctx, "prio.approval_aging", "high", ["minimize_user_time"]);
  }

  // G1 beats discover growth when health is low (Conflict §7)
  if (
    conflicts.includes("discover") &&
    ctx.blackboard.relationship_eval.health < 45
  ) {
    conflicts.push("g1_over_discover");
    score = Math.min(score, 35);
    fire(
      ctx,
      "prio.conflict_g1_vs_discover",
      "critical",
      ["relationship_quality"],
      "유지/품질 > 신규 발굴",
    );
  }

  ctx.blackboard.priority_conflicts = conflicts;
  ctx.blackboard.priority_score = clamp(score);
}
