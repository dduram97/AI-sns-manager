import type {
  DecisionContext,
  RelationshipHealthFactors,
} from "../../../../workers/types";
import { clamp, daysSince, fire } from "../../helpers";

function latestJobAt(
  ctx: DecisionContext,
  actionType: string,
  statuses: string[],
): string | null {
  const jobs = ctx.recent_action_jobs
    .filter((j) => j.action_type === actionType && statuses.includes(j.status))
    .sort(
      (a, b) =>
        new Date(b.executed_at ?? b.updated_at).getTime() -
        new Date(a.executed_at ?? a.updated_at).getTime(),
    );
  return jobs[0]?.executed_at ?? jobs[0]?.updated_at ?? null;
}

function latestApprovalAt(ctx: DecisionContext): string | null {
  const sorted = [...ctx.recent_approvals].sort(
    (a, b) =>
      new Date(b.resolved_at ?? b.created_at).getTime() -
      new Date(a.resolved_at ?? a.created_at).getTime(),
  );
  return sorted[0]?.resolved_at ?? sorted[0]?.created_at ?? null;
}

/**
 * Pipeline stage 2 — Relationship Evaluation
 * Computes Relationship Health from touch signals + stage/temp/score.
 */
export function applyRelationshipEvaluation(ctx: DecisionContext): void {
  const { relationship, now } = ctx;
  const flags: string[] = [];
  let scoreDelta = 0;
  let tempDelta = 0;

  const factors: RelationshipHealthFactors = {
    days_since_visit:
      daysSince(relationship.last_visit_at, now) ??
      daysSince(latestJobAt(ctx, "visit", ["executed"]), now),
    days_since_like:
      daysSince(relationship.last_like_at, now) ??
      daysSince(latestJobAt(ctx, "like", ["executed"]), now),
    days_since_comment: daysSince(relationship.last_comment_at, now),
    days_since_reply: daysSince(
      latestJobAt(ctx, "threads_reply", ["executed", "approved"]),
      now,
    ),
    days_since_approval: daysSince(latestApprovalAt(ctx), now),
    days_since_request: daysSince(
      latestJobAt(ctx, "neighbor_request", [
        "executed",
        "approved",
        "pending_approval",
      ]),
      now,
    ),
    stage: relationship.stage,
    temperature: relationship.temperature,
    score: relationship.score,
  };

  let health = 40;
  health += clamp(relationship.temperature * 0.35, 0, 35);
  health += clamp(relationship.score * 0.15, 0, 15);

  const stageBonus: Record<string, number> = {
    vip: 15,
    maintain: 10,
    early_relationship: 6,
    warming: 4,
    waiting_new_post: 2,
    approval_pending: 3,
    discover: 0,
    risk: -20,
  };
  health += stageBonus[relationship.stage] ?? 0;

  const penalize = (
    days: number | null,
    soft: number,
    hard: number,
    flag: string,
  ) => {
    if (days == null) {
      health -= 4;
      return;
    }
    if (days > hard) {
      health -= 12;
      flags.push(flag);
      scoreDelta -= 4;
      tempDelta -= 6;
    } else if (days > soft) {
      health -= 5;
      flags.push(`${flag}_soft`);
      tempDelta -= 2;
    } else {
      health += 3;
    }
  };

  penalize(factors.days_since_visit, 5, 14, "stale_visit");
  penalize(factors.days_since_like, 7, 21, "stale_like");
  penalize(factors.days_since_comment, 14, 30, "stale_comment");

  const lastTouchDays = daysSince(relationship.last_touch_at, now) ?? 99;
  if (lastTouchDays > 7) {
    flags.push("stale_touch");
    scoreDelta -= 5;
    tempDelta -= 8;
    fire(
      ctx,
      "rel.touch_gap",
      "normal",
      ["relationship_quality"],
      `${lastTouchDays.toFixed(1)}d`,
    );
  }

  if (ctx.person.discover_meta?.sponsored_likely === true) {
    flags.push("sponsored_likely");
    health -= 15;
    fire(ctx, "rel.sponsored_or_inactive", "high", [
      "natural_interaction",
      "sustained_growth",
    ]);
  }

  const hasNewPost = ctx.blackboard.normalized_events.some(
    (e) => e.event_type === "new_post",
  );
  if (hasNewPost) {
    tempDelta += 3;
    health += 5;
    flags.push("new_post_signal");
    fire(ctx, "rel.reciprocity", "high", ["relationship_quality"], "new_post");
  }

  if (relationship.stage === "vip" || relationship.temperature >= 70) {
    flags.push("vip_candidate");
    fire(ctx, "rel.vip_signal", "normal", ["relationship_quality"]);
  }

  if (
    lastTouchDays > 21 &&
    ["maintain", "vip", "early_relationship"].includes(relationship.stage)
  ) {
    ctx.blackboard.relationship_eval.suggested_stage = "risk";
    flags.push("cooling");
    health -= 10;
    fire(ctx, "rel.risk_cooldown", "high", [
      "relationship_quality",
      "natural_interaction",
    ]);
  }

  if (
    (relationship.stage === "vip" || relationship.stage === "maintain") &&
    lastTouchDays > 10
  ) {
    flags.push("vip_neglect");
    fire(
      ctx,
      "rel.vip_neglect",
      "high",
      ["relationship_quality"],
      `${lastTouchDays.toFixed(0)}d`,
    );
  }

  health = clamp(health);

  ctx.blackboard.relationship_eval = {
    health,
    factors,
    suggested_stage: ctx.blackboard.relationship_eval.suggested_stage,
    score_delta: scoreDelta,
    temperature_delta: tempDelta,
    flags,
  };

  fire(ctx, "rel.health", "high", ["relationship_quality"], `health=${health}`);
}
