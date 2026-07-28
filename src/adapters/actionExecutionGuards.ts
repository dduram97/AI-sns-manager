/**
 * Live ActionJob execution guards (Policy limits / idempotency).
 * Does not modify Decision Engine — only blocks Adapter execution.
 */

import type {
  ActionJob,
  ActionType,
  PolicyProfile,
} from "../workers/types";

export function actionRetryLimit(): number {
  const n = Number(
    process.env.RETRY_LIMIT ?? process.env.ACTION_RETRY_LIMIT ?? 3,
  );
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 3;
}

export function actionTimeoutMs(): number {
  const n = Number(
    process.env.ACTION_TIMEOUT ??
      process.env.BROWSER_ACTION_TIMEOUT_MS ??
      90_000,
  );
  return Number.isFinite(n) && n > 0 ? n : 90_000;
}

type OutcomeLike = {
  auto_visit_count: number;
  auto_like_count: number;
};

function targetKey(job: ActionJob): string | null {
  const ref = job.target_ref ?? {};
  const post =
    (typeof ref.post_url === "string" && ref.post_url) ||
    (typeof ref.url === "string" && ref.url) ||
    null;
  if (post) return `${job.action_type}:post:${post.trim()}`;
  const blog =
    (typeof ref.blog_id === "string" && ref.blog_id) ||
    (typeof ref.blogId === "string" && ref.blogId) ||
    null;
  const logNo =
    (typeof ref.log_no === "string" && ref.log_no) ||
    (typeof ref.post_id === "string" && ref.post_id) ||
    null;
  if (blog && logNo) return `${job.action_type}:blog:${blog}/${logNo}`;
  if (
    blog &&
    (job.action_type === "visit" || job.action_type === "neighbor_request")
  ) {
    return `${job.action_type}:blog:${blog}`;
  }
  return null;
}

export function guardDuplicateJobStatus(job: ActionJob): string | null {
  if (job.status === "executed") return "already_executed";
  if (job.status === "running") return "already_running";
  if (
    job.status === "rejected" ||
    job.status === "expired" ||
    job.status === "permanently_failed"
  ) {
    return `terminal_status_${job.status}`;
  }
  if (job.status === "pending_approval") {
    return "still_pending_approval";
  }
  return null;
}

export function guardRetryLimit(job: ActionJob): string | null {
  const retries = Number(job.target_ref?.retry_count ?? 0);
  const limit = actionRetryLimit();
  if (Number.isFinite(retries) && retries >= limit) {
    return `retry_limit_reached (${retries}/${limit})`;
  }
  return null;
}

/** Daily Policy limits — visit/like only (Outcome counters). */
export function guardDailyLimit(
  job: ActionJob,
  policy: PolicyProfile,
  outcome: OutcomeLike,
): string | null {
  const limits = policy.daily_limits ?? {};
  const replyVisitImmediate =
    job.target_ref?.source === "reply_visit_immediate" ||
    job.target_ref?.reply_visit === true;
  // Intentional UI click on 답방 관리 — allow even when Agent auto like is off.
  if (
    !policy.low_risk_auto &&
    !replyVisitImmediate &&
    (job.action_type === "visit" || job.action_type === "like")
  ) {
    return "low_risk_auto_disabled";
  }
  if (job.action_type === "visit" && limits.visit != null) {
    if (outcome.auto_visit_count >= limits.visit) {
      return `daily_visit_limit (${outcome.auto_visit_count}/${limits.visit})`;
    }
  }
  if (job.action_type === "like" && limits.like != null) {
    if (outcome.auto_like_count >= limits.like) {
      return `daily_like_limit (${outcome.auto_like_count}/${limits.like})`;
    }
  }
  return null;
}

export function sameTargetKey(job: ActionJob): string | null {
  return targetKey(job);
}

export function isSameTargetAction(job: ActionJob, other: ActionJob): boolean {
  const a = targetKey(job);
  const b = targetKey(other);
  if (!a || !b) return false;
  return a === b;
}

const REPEAT_WINDOW_MS = () =>
  Number(process.env.ACTION_REPEAT_WINDOW_MS ?? 6 * 60 * 60 * 1000) ||
  6 * 60 * 60 * 1000;

/** Block repeating same target+action within window. */
export function guardRepeatTarget(
  job: ActionJob,
  recentExecuted: ActionJob[],
  now = Date.now(),
): string | null {
  const key = targetKey(job);
  if (!key) return null;
  const windowMs = REPEAT_WINDOW_MS();
  for (const other of recentExecuted) {
    if (other.id === job.id) continue;
    if (other.status !== "executed") continue;
    if (other.action_type !== job.action_type) continue;
    if (!isSameTargetAction(job, other)) continue;
    const at = other.executed_at
      ? Date.parse(other.executed_at)
      : Date.parse(other.created_at);
    if (Number.isFinite(at) && now - at < windowMs) {
      return `duplicate_target_action (${key})`;
    }
  }
  return null;
}

export function executableStatuses(): Array<ActionJob["status"]> {
  return ["planned", "approved", "failed"];
}

export function canStartExecution(job: ActionJob): boolean {
  return executableStatuses().includes(job.status);
}
