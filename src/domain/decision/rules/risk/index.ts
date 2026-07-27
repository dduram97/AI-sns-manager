import type {
  DecisionContext,
  RiskLevel,
} from "../../../../workers/types";
import { fire, hoursSince } from "../../helpers";

/**
 * Pipeline stage 4 — Risk Evaluation
 * Classifies Low / Medium / High from phrase, visit, interval, daily signals.
 */
export function applyRiskEvaluation(ctx: DecisionContext): void {
  const reasons: string[] = [];
  let level: RiskLevel = "low";

  const raise = (next: RiskLevel, reason: string, ruleId: string) => {
    reasons.push(reason);
    const order: RiskLevel[] = ["low", "medium", "high"];
    if (order.indexOf(next) > order.indexOf(level)) level = next;
    fire(
      ctx,
      ruleId,
      next === "high" ? "high" : "normal",
      ["natural_interaction", "relationship_quality"],
      reason,
    );
  };

  // Open high-risk approval already in flight
  if (
    ctx.recent_action_jobs.some(
      (j) => j.status === "pending_approval" && j.risk === "high",
    )
  ) {
    raise("medium", "open_pending_approval", "risk.pending_approval_open");
  }

  // Identical / near-identical draft phrases
  const draftBodies = ctx.recent_action_jobs
    .map((j) => j.draft_body?.trim().toLowerCase())
    .filter((b): b is string => Boolean(b));
  const unique = new Set(draftBodies);
  if (draftBodies.length >= 2 && unique.size < draftBodies.length) {
    raise("high", "identical_phrase", "risk.identical_phrase");
  } else if (draftBodies.length >= 3) {
    raise("medium", "possible_similar_phrase", "risk.duplicate_draft");
  }

  // Excessive visits (today + recent)
  const visitCount = ctx.recent_action_jobs.filter(
    (j) => j.action_type === "visit" && j.status === "executed",
  ).length;
  const visitToday = ctx.outcome_today.auto_visit_count;
  if (visitToday >= 8 || visitCount >= 6) {
    raise("high", "excessive_visits", "risk.excessive_visits");
  } else if (visitToday >= 5 || visitCount >= 4) {
    raise("medium", "elevated_visits", "risk.elevated_visits");
  }

  // Short-interval comments (< 6h)
  const comments = ctx.recent_action_jobs
    .filter(
      (j) =>
        (j.action_type === "comment" || j.action_type === "threads_reply") &&
        ["executed", "approved", "pending_approval"].includes(j.status),
    )
    .sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
  if (comments[0]) {
    const h = hoursSince(comments[0].created_at, ctx.now);
    if (h != null && h < 6) {
      raise("high", "short_interval_comment", "risk.short_interval_comment");
    } else if (h != null && h < 18) {
      raise("medium", "comment_spacing", "risk.comment_spacing");
    }
  }

  // Short-interval neighbor requests (< 48h)
  const requests = ctx.recent_action_jobs
    .filter(
      (j) =>
        j.action_type === "neighbor_request" &&
        ["executed", "approved", "pending_approval", "rejected"].includes(
          j.status,
        ),
    )
    .sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
  if (requests[0]) {
    const h = hoursSince(requests[0].created_at, ctx.now);
    if (h != null && h < 48) {
      raise("high", "short_interval_request", "risk.short_interval_request");
    }
  }

  // Daily limit pressure (soft risk; hard gate is Policy)
  const limits = ctx.policy.daily_limits;
  const o = ctx.outcome_today;
  if (
    (limits.like != null && o.auto_like_count >= limits.like * 0.8) ||
    (limits.visit != null && o.auto_visit_count >= limits.visit * 0.8)
  ) {
    raise("medium", "daily_limit_pressure", "risk.daily_limit_pressure");
  }
  if (
    (limits.like != null && o.auto_like_count >= limits.like) ||
    (limits.visit != null && o.auto_visit_count >= limits.visit)
  ) {
    raise("high", "daily_limit_reached", "risk.daily_limit_reached");
  }

  if (ctx.blackboard.relationship_eval.flags.includes("sponsored_likely")) {
    raise("high", "sponsored_likely", "risk.sponsored_likely");
  }

  fire(
    ctx,
    "risk.action_matrix",
    "critical",
    ["natural_interaction"],
    `level=${level}`,
  );

  ctx.blackboard.risk = { level, reasons };
}
