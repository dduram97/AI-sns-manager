/**
 * ActionJob retry / stuck-running policy helpers.
 * No Decision Engine / Workflow / Approval changes.
 */

import { actionRetryLimit } from "../adapters/actionExecutionGuards";
import type { ActionJob } from "./types";

export const ERROR_STUCK_RUNNING = "stuck_running_timeout";
export const ERROR_RETRY_EXHAUSTED = "retry_limit_exhausted";

export function stuckRunningTimeoutMs(): number {
  const explicit = Number(process.env.ACTION_STUCK_RUNNING_MS);
  if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
  const actionTimeout = Number(
    process.env.ACTION_TIMEOUT ??
      process.env.BROWSER_ACTION_TIMEOUT_MS ??
      90_000,
  );
  const base =
    Number.isFinite(actionTimeout) && actionTimeout > 0
      ? actionTimeout
      : 90_000;
  // Default: action timeout + 60s buffer
  return base + 60_000;
}

export function recoveryRetryBatchLimit(): number {
  const n = Number(process.env.ACTION_RECOVERY_RETRY_BATCH ?? 5);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 5;
}

export function jobRetryCount(job: ActionJob): number {
  const n = Number(job.target_ref?.retry_count ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function jobErrorCode(job: ActionJob): string | null {
  const code = job.target_ref?.error_code;
  return typeof code === "string" && code.trim() ? code.trim() : null;
}

/** failed + under RETRY_LIMIT → retryable */
export function isRetryableFailedJob(
  job: ActionJob,
  limit = actionRetryLimit(),
): boolean {
  if (job.status !== "failed") return false;
  return jobRetryCount(job) < limit;
}

/**
 * Bundled like still owned by an open comment approval.
 * Recovery must not auto-retry / permanently_fail these — Approval Inbox owns them.
 *
 * Hold when sibling comment is:
 * - pending_approval, or
 * - failed and still referenced by an open Approval (opts.openApprovalJobIds)
 */
export function isBundledLikeHeldByOpenApproval(
  job: ActionJob,
  bundleJobs: ActionJob[],
  opts?: { openApprovalJobIds?: ReadonlySet<string> },
): boolean {
  if (job.action_type !== "like" || !job.bundle_id) return false;
  const openIds = opts?.openApprovalJobIds;
  return bundleJobs.some((j) => {
    if (j.id === job.id || j.action_type !== "comment") return false;
    if (j.status === "pending_approval") return true;
    if (j.status === "failed" && openIds?.has(j.id)) return true;
    return false;
  });
}

/** failed + retry_count >= RETRY_LIMIT → should become permanently_failed */
export function shouldPermanentlyFail(
  job: ActionJob,
  limit = actionRetryLimit(),
): boolean {
  if (job.status === "permanently_failed") return true;
  if (job.status !== "failed") return false;
  return jobRetryCount(job) >= limit;
}

export function isStuckRunning(
  job: ActionJob,
  nowMs = Date.now(),
  timeoutMs = stuckRunningTimeoutMs(),
): boolean {
  if (job.status !== "running") return false;
  const updated = Date.parse(job.updated_at);
  if (!Number.isFinite(updated)) return false;
  return nowMs - updated >= timeoutMs;
}
