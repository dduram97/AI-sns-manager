/**
 * Action job poller / runner for CDP Worker.
 *
 * App DB uses status `planned` | `approved` for runnable queue
 * (there is no `pending` status). Success status is `executed` (not "completed").
 *
 * Phase 2-2: visit
 * Phase 2-3: like (max 1)
 * Phase 2-4: comment (max 1)
 * Phase 2-5: neighbor_request (max 1)
 * Phase 3-3: execution safety (daily limit / cooldown / delay / dry-run / approve gate)
 */

import type { BrowserContext } from "playwright";

import {
  executeComment,
  resolveCommentBody,
} from "../naver/actions/comment";
import { executeLike, resolveLikePostUrl } from "../naver/actions/like";
import {
  executeNeighborRequest,
  extractBlogIdFromUrl,
  resolveNeighborBlogId,
  resolveNeighborBlogUrl,
} from "../naver/actions/neighborRequest";
import { executeVisit, resolveVisitUrl } from "../naver/actions/visit";
import type { DatabaseClient } from "../lib/supabase";
import {
  filterExecutableJobs,
  isDryRun,
  logActionEvent,
  maybeDelayBeforeAction,
  preflightAction,
} from "./executionSafety";
import { recordNeighborPerformanceOnExecute } from "./neighborPerformance";

/** Types surfaced by detectPendingActionJobs (queue visibility). */
export const CDP_WORKER_ACTION_TYPES = ["neighbor_request"] as const;

export type CdpWorkerActionType = (typeof CDP_WORKER_ACTION_TYPES)[number];

export const VISIT_ACTION_TYPE = "visit" as const;
export const LIKE_ACTION_TYPE = "like" as const;
export const COMMENT_ACTION_TYPE = "comment" as const;
export const NEIGHBOR_REQUEST_ACTION_TYPE = "neighbor_request" as const;

export const LIKE_JOB_LIMIT = 1;
export const COMMENT_JOB_LIMIT = 1;
export const NEIGHBOR_REQUEST_JOB_LIMIT = 1;

export const RUNNABLE_JOB_STATUSES = ["planned", "approved"] as const;

export type ActionJobRow = {
  id: string;
  person_id: string;
  channel: string;
  action_type: string;
  risk: string;
  status: string;
  draft_body: string | null;
  target_ref: Record<string, unknown> | null;
  scheduled_for: string | null;
  created_at: string;
  updated_at: string;
  error: string | null;
};

export type JobRunPlan = {
  job: ActionJobRow;
  actionType: CdpWorkerActionType;
  hints: {
    postUrl: string | null;
    blogId: string | null;
    draftBody: string | null;
  };
};

export type JobRunResult =
  | { ok: true; jobId: string; note: string }
  | { ok: false; jobId: string; skipped: true; reason: string }
  | { ok: false; jobId: string; error: string };

function isCdpWorkerActionType(v: string): v is CdpWorkerActionType {
  return (CDP_WORKER_ACTION_TYPES as readonly string[]).includes(v);
}

function planFromJob(job: ActionJobRow): JobRunPlan | null {
  if (!isCdpWorkerActionType(job.action_type)) return null;
  const ref = job.target_ref ?? {};
  return {
    job,
    actionType: job.action_type,
    hints: {
      postUrl:
        typeof ref.post_url === "string"
          ? ref.post_url
          : typeof ref.url === "string"
            ? ref.url
            : null,
      blogId: typeof ref.blog_id === "string" ? ref.blog_id : null,
      draftBody: job.draft_body,
    },
  };
}

/**
 * Fetch runnable neighbor_request jobs (detect / queue visibility).
 */
export async function listRunnableCdpJobs(
  db: DatabaseClient,
  limit = 20,
): Promise<ActionJobRow[]> {
  const { data, error } = await db
    .from("action_jobs")
    .select(
      "id, person_id, channel, action_type, risk, status, draft_body, target_ref, scheduled_for, created_at, updated_at, error",
    )
    .in("status", [...RUNNABLE_JOB_STATUSES])
    .in("action_type", [...CDP_WORKER_ACTION_TYPES])
    .order("created_at", { ascending: true })
    .limit(Math.max(limit * 10, 50));

  if (error) {
    throw new Error(`listRunnableCdpJobs: ${error.message}`);
  }
  return gateExecutable((data ?? []) as ActionJobRow[], limit);
}

/** Fetch runnable visit jobs for phase 2-2 execution. */
export async function listRunnableVisitJobs(
  db: DatabaseClient,
  limit = 10,
): Promise<ActionJobRow[]> {
  const { data, error } = await db
    .from("action_jobs")
    .select(
      "id, person_id, channel, action_type, risk, status, draft_body, target_ref, scheduled_for, created_at, updated_at, error",
    )
    .in("status", [...RUNNABLE_JOB_STATUSES])
    .eq("action_type", VISIT_ACTION_TYPE)
    .order("created_at", { ascending: true })
    .limit(Math.max(limit * 10, 50));

  if (error) {
    throw new Error(`listRunnableVisitJobs: ${error.message}`);
  }
  return gateExecutable((data ?? []) as ActionJobRow[], limit);
}

function normalizeLikeUrlKey(url: string): string {
  try {
    const u = new URL(url.trim());
    let host = u.hostname.toLowerCase();
    if (host === "blog.naver.com" || host.endsWith(".blog.naver.com")) {
      host = "m.blog.naver.com";
    }
    // path only — ignore query/hash for stable match
    const path = u.pathname.replace(/\/+$/, "") || "/";
    return `${host}${path}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase().replace(/\/+$/, "");
  }
}

function jobPostUrlRaw(job: ActionJobRow): string | null {
  const ref = job.target_ref ?? {};
  if (typeof ref.post_url === "string" && ref.post_url.trim()) {
    return ref.post_url.trim();
  }
  if (typeof ref.url === "string" && ref.url.trim()) {
    return ref.url.trim();
  }
  return null;
}

function isWorkerTestJob(job: ActionJobRow): boolean {
  return job.target_ref?.worker_test === true;
}

/** Apply Phase 3-3 approve gate after DB fetch. */
function gateExecutable(jobs: ActionJobRow[], limit: number): ActionJobRow[] {
  const gated = filterExecutableJobs(jobs);
  const blocked = jobs.length - gated.length;
  if (blocked > 0) {
    console.info(
      `[safety] status gate blocked=${blocked} (planned without worker_test/allow, or non-approved)`,
    );
  }
  return gated.slice(0, Math.max(1, limit));
}

function likeJobMatchesTestPostUrl(
  job: ActionJobRow,
  testPostUrl: string,
): boolean {
  const wantKey = normalizeLikeUrlKey(testPostUrl);
  const raw = jobPostUrlRaw(job);
  if (raw && normalizeLikeUrlKey(raw) === wantKey) return true;
  const resolved = resolveLikePostUrl(job.target_ref);
  if (resolved && normalizeLikeUrlKey(resolved) === wantKey) return true;
  const wantResolved = resolveLikePostUrl({ post_url: testPostUrl });
  if (
    wantResolved &&
    resolved &&
    normalizeLikeUrlKey(wantResolved) === normalizeLikeUrlKey(resolved)
  ) {
    return true;
  }
  return false;
}

/** Fetch runnable like jobs (phase 2-3; capped at LIKE_JOB_LIMIT).
 * Test mode (WORKER_TEST_POST_URL set):
 *   - only pick jobs whose target_ref.post_url matches that URL (normalized)
 *   - prefer target_ref.worker_test === true
 * Unset: existing oldest planned/approved like (limit 1).
 */
export async function listRunnableLikeJobs(
  db: DatabaseClient,
  limit = LIKE_JOB_LIMIT,
): Promise<ActionJobRow[]> {
  const safeLimit = Math.max(1, Math.min(limit, LIKE_JOB_LIMIT));
  const testPostUrl = process.env.WORKER_TEST_POST_URL?.trim() || "";

  if (!testPostUrl) {
    const { data, error } = await db
      .from("action_jobs")
      .select(
        "id, person_id, channel, action_type, risk, status, draft_body, target_ref, scheduled_for, created_at, updated_at, error",
      )
      .in("status", [...RUNNABLE_JOB_STATUSES])
      .eq("action_type", LIKE_ACTION_TYPE)
      .order("created_at", { ascending: true })
      .limit(Math.max(safeLimit * 20, 50));

    if (error) {
      throw new Error(`listRunnableLikeJobs: ${error.message}`);
    }
    return gateExecutable((data ?? []) as ActionJobRow[], safeLimit);
  }

  if (!resolveLikePostUrl({ post_url: testPostUrl })) {
    console.error(
      `[worker] WORKER_TEST_POST_URL invalid (need post URL): ${testPostUrl}`,
    );
    return [];
  }

  console.info(
    `[worker] like TEST MODE filter WORKER_TEST_POST_URL=${testPostUrl}`,
  );

  const { data, error } = await db
    .from("action_jobs")
    .select(
      "id, person_id, channel, action_type, risk, status, draft_body, target_ref, scheduled_for, created_at, updated_at, error",
    )
    .in("status", [...RUNNABLE_JOB_STATUSES])
    .eq("action_type", LIKE_ACTION_TYPE)
    .order("created_at", { ascending: true })
    .limit(100);

  if (error) {
    throw new Error(`listRunnableLikeJobs: ${error.message}`);
  }

  const candidates = ((data ?? []) as ActionJobRow[]).filter((job) =>
    likeJobMatchesTestPostUrl(job, testPostUrl),
  );

  if (candidates.length === 0) {
    console.info(
      `[worker] like TEST MODE: no planned/approved like matching URL (skipped other queue jobs)`,
    );
    return [];
  }

  // Prefer explicit worker_test fixtures when several match the same URL.
  candidates.sort((a, b) => {
    const aw = isWorkerTestJob(a) ? 0 : 1;
    const bw = isWorkerTestJob(b) ? 0 : 1;
    if (aw !== bw) return aw - bw;
    return a.created_at.localeCompare(b.created_at);
  });

  const gated = gateExecutable(candidates, safeLimit);
  if (gated.length === 0) {
    console.info(
      `[worker] like TEST MODE: matched URL but blocked by status gate (need approved or worker_test planned)`,
    );
    return [];
  }

  const matched = gated[0]!;
  console.info(`[worker] like TEST MODE matched job=${matched.id}`, {
    worker_test: isWorkerTestJob(matched),
    status: matched.status,
    post_url: jobPostUrlRaw(matched),
  });
  return [matched];
}

export function buildRunPlans(jobs: ActionJobRow[]): JobRunPlan[] {
  const plans: JobRunPlan[] = [];
  for (const job of jobs) {
    const plan = planFromJob(job);
    if (plan) plans.push(plan);
  }
  return plans;
}

/**
 * Legacy detect helper — neighbor_request now executes via runNeighborRequestActionJobs.
 */
export async function runActionPlan(_plan: JobRunPlan): Promise<JobRunResult> {
  return {
    ok: false,
    jobId: _plan.job.id,
    skipped: true,
    reason: "use_runNeighborRequestActionJobs",
  };
}

function neighborJobMatchesTestPostUrl(
  job: ActionJobRow,
  testPostUrl: string,
): boolean {
  const wantBlogId = extractBlogIdFromUrl(testPostUrl);
  const jobBlogId = resolveNeighborBlogId(job.target_ref);
  if (
    wantBlogId &&
    jobBlogId &&
    wantBlogId.toLowerCase() === jobBlogId.toLowerCase()
  ) {
    return true;
  }

  // Also allow exact post/blog URL key match when fixtures store post_url.
  const wantKey = normalizeLikeUrlKey(testPostUrl);
  const raw = jobPostUrlRaw(job);
  if (raw && normalizeLikeUrlKey(raw) === wantKey) return true;

  const ref = job.target_ref ?? {};
  for (const key of ["blog_url", "profile_url", "url", "post_url"]) {
    const v = ref[key];
    if (typeof v !== "string" || !v.trim()) continue;
    if (normalizeLikeUrlKey(v) === wantKey) return true;
    const id = extractBlogIdFromUrl(v);
    if (
      wantBlogId &&
      id &&
      wantBlogId.toLowerCase() === id.toLowerCase()
    ) {
      return true;
    }
  }
  return false;
}

/** Fetch runnable neighbor_request jobs (max 1; TEST_POST_URL → same blog_id). */
export async function listRunnableNeighborRequestJobs(
  db: DatabaseClient,
  limit = NEIGHBOR_REQUEST_JOB_LIMIT,
): Promise<ActionJobRow[]> {
  const safeLimit = Math.max(1, Math.min(limit, NEIGHBOR_REQUEST_JOB_LIMIT));
  const testPostUrl = process.env.WORKER_TEST_POST_URL?.trim() || "";

  if (!testPostUrl) {
    const { data, error } = await db
      .from("action_jobs")
      .select(
        "id, person_id, channel, action_type, risk, status, draft_body, target_ref, scheduled_for, created_at, updated_at, error",
      )
      .in("status", [...RUNNABLE_JOB_STATUSES])
      .eq("action_type", NEIGHBOR_REQUEST_ACTION_TYPE)
      .order("created_at", { ascending: true })
      .limit(Math.max(safeLimit * 20, 50));

    if (error) {
      throw new Error(`listRunnableNeighborRequestJobs: ${error.message}`);
    }
    return gateExecutable((data ?? []) as ActionJobRow[], safeLimit);
  }

  const testBlogId = extractBlogIdFromUrl(testPostUrl);
  if (!testBlogId) {
    console.error(
      `[worker] WORKER_TEST_POST_URL invalid for neighbor_request: ${testPostUrl}`,
    );
    return [];
  }

  console.info(
    `[worker] neighbor_request TEST MODE filter WORKER_TEST_POST_URL=${testPostUrl} blogId=${testBlogId}`,
  );

  const { data, error } = await db
    .from("action_jobs")
    .select(
      "id, person_id, channel, action_type, risk, status, draft_body, target_ref, scheduled_for, created_at, updated_at, error",
    )
    .in("status", [...RUNNABLE_JOB_STATUSES])
    .eq("action_type", NEIGHBOR_REQUEST_ACTION_TYPE)
    .order("created_at", { ascending: true })
    .limit(100);

  if (error) {
    throw new Error(`listRunnableNeighborRequestJobs: ${error.message}`);
  }

  const candidates = ((data ?? []) as ActionJobRow[]).filter((job) =>
    neighborJobMatchesTestPostUrl(job, testPostUrl),
  );

  if (candidates.length === 0) {
    console.info(
      `[worker] neighbor_request TEST MODE: no planned/approved job matching blog`,
    );
    return [];
  }

  candidates.sort((a, b) => {
    const aw = isWorkerTestJob(a) ? 0 : 1;
    const bw = isWorkerTestJob(b) ? 0 : 1;
    if (aw !== bw) return aw - bw;
    return a.created_at.localeCompare(b.created_at);
  });

  const gated = gateExecutable(candidates, safeLimit);
  if (gated.length === 0) {
    console.info(
      `[worker] neighbor_request TEST MODE: matched blog but blocked by status gate`,
    );
    return [];
  }

  const matched = gated[0]!;
  console.info(`[worker] neighbor_request TEST MODE matched job=${matched.id}`, {
    worker_test: isWorkerTestJob(matched),
    status: matched.status,
    blog_id: resolveNeighborBlogId(matched.target_ref),
    blog_url: resolveNeighborBlogUrl(matched.target_ref),
  });
  return [matched];
}

/**
 * Claim + execute at most one neighbor_request job.
 */
export async function runNeighborRequestActionJobs(
  db: DatabaseClient,
  context: BrowserContext | null,
  limit = NEIGHBOR_REQUEST_JOB_LIMIT,
): Promise<{
  picked: number;
  executed: number;
  failed: number;
  skippedNoUrl: number;
  skippedClaim: number;
  skippedSafety: number;
  dryRun: number;
}> {
  const jobs = await listRunnableNeighborRequestJobs(db, limit);
  let executed = 0;
  let failed = 0;
  let skippedNoUrl = 0;
  let skippedClaim = 0;
  let skippedSafety = 0;
  let dryRunCount = 0;

  console.info(
    `[worker] neighbor_request queue size=${jobs.length} limit=${NEIGHBOR_REQUEST_JOB_LIMIT} dryRun=${isDryRun()}`,
  );

  for (const job of jobs) {
    const blogId = resolveNeighborBlogId(job.target_ref);
    const blogUrl = resolveNeighborBlogUrl(job.target_ref);
    logActionEvent({
      phase: "pick",
      jobId: job.id,
      actionType: "neighbor_request",
      blogId,
      targetUrl: blogUrl,
      status: job.status,
    });

    const testPostUrl = process.env.WORKER_TEST_POST_URL?.trim() || "";
    if (testPostUrl && !neighborJobMatchesTestPostUrl(job, testPostUrl)) {
      logActionEvent({
        phase: "skip",
        jobId: job.id,
        actionType: "neighbor_request",
        blogId,
        targetUrl: blogUrl,
        skipReason: "test_mode_url_mismatch",
      });
      continue;
    }

    if (!blogUrl) {
      logActionEvent({
        phase: "skip",
        jobId: job.id,
        actionType: "neighbor_request",
        blogId,
        skipReason: "missing_blog_url",
      });
      skippedNoUrl += 1;
      continue;
    }

    const pre = await preflightAction(db, job, {
      blogId,
      targetUrl: blogUrl,
    });
    if (!pre.ok) {
      skippedSafety += 1;
      continue;
    }

    if (isDryRun()) {
      dryRunCount += 1;
      logActionEvent({
        phase: "dry_run",
        jobId: job.id,
        actionType: "neighbor_request",
        blogId,
        targetUrl: blogUrl,
        status: job.status,
        result: "would_execute",
      });
      continue;
    }

    const claimed = await claimJobRunning(db, job.id);
    if (!claimed) {
      logActionEvent({
        phase: "skip",
        jobId: job.id,
        actionType: "neighbor_request",
        blogId,
        targetUrl: blogUrl,
        skipReason: "claim_lost",
      });
      skippedClaim += 1;
      continue;
    }
    logActionEvent({
      phase: "claim",
      jobId: job.id,
      actionType: "neighbor_request",
      blogId,
      targetUrl: blogUrl,
      status: "running",
    });

    const delayMs = await maybeDelayBeforeAction("neighbor_request");
    if (delayMs > 0) {
      logActionEvent({
        phase: "delay",
        jobId: job.id,
        actionType: "neighbor_request",
        blogId,
        targetUrl: blogUrl,
        extra: { delayMs },
      });
    }

    const result = await executeNeighborRequest(context!, {
      jobId: job.id,
      targetRef: job.target_ref,
      draftBody: job.draft_body,
    });

    if (result.ok) {
      const note = result.alreadyNeighbor
        ? `neighbor_request already_neighbor ${result.url}`
        : result.alreadyPending
          ? `neighbor_request already_pending ${result.url}`
          : `neighbor_request ${result.url}`;
      await updateJobResult(db, {
        ok: true,
        jobId: job.id,
        note,
      });
      executed += 1;
      // Phase 4-1: track request outcome (non-blocking)
      if (blogId) {
        await recordNeighborPerformanceOnExecute(db, {
          actionJobId: job.id,
          blogId,
          blogUrl: result.url || blogUrl,
          alreadyNeighbor: result.alreadyNeighbor,
          alreadyPending: result.alreadyPending,
          targetRef: job.target_ref,
        });
      }
      logActionEvent({
        phase: "result",
        jobId: job.id,
        actionType: "neighbor_request",
        blogId,
        targetUrl: result.url,
        result: "executed",
        extra: {
          alreadyNeighbor: result.alreadyNeighbor,
          alreadyPending: result.alreadyPending,
        },
      });
    } else {
      await updateJobResult(db, {
        ok: false,
        jobId: job.id,
        error: result.error,
      });
      failed += 1;
      logActionEvent({
        phase: "result",
        jobId: job.id,
        actionType: "neighbor_request",
        blogId,
        targetUrl: blogUrl,
        result: "failed",
        skipReason: result.error,
      });
    }
  }

  return {
    picked: jobs.length,
    executed,
    failed,
    skippedNoUrl,
    skippedClaim,
    skippedSafety,
    dryRun: dryRunCount,
  };
}

export async function claimJobRunning(
  db: DatabaseClient,
  jobId: string,
): Promise<boolean> {
  const { data, error } = await db
    .from("action_jobs")
    .update({
      status: "running",
      updated_at: new Date().toISOString(),
      error: null,
    })
    .eq("id", jobId)
    .in("status", [...RUNNABLE_JOB_STATUSES])
    .select("id")
    .maybeSingle();

  if (error) {
    throw new Error(`claimJobRunning: ${error.message}`);
  }
  return Boolean(data?.id);
}

/**
 * Persist execution result. Success → status `executed` (app schema).
 */
export async function updateJobResult(
  db: DatabaseClient,
  result:
    | { ok: true; jobId: string; note?: string }
    | { ok: false; jobId: string; error: string },
): Promise<void> {
  if (result.ok) {
    const { error } = await db
      .from("action_jobs")
      .update({
        status: "executed",
        executed_at: new Date().toISOString(),
        error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", result.jobId)
      .in("status", ["running", "planned", "approved"]);
    if (error) throw new Error(`updateJobResult executed: ${error.message}`);
    return;
  }

  const { error } = await db
    .from("action_jobs")
    .update({
      status: "failed",
      error: result.error.slice(0, 2000),
      updated_at: new Date().toISOString(),
    })
    .eq("id", result.jobId)
    .in("status", ["running", "planned", "approved"]);
  if (error) throw new Error(`updateJobResult failed: ${error.message}`);
}

export async function detectPendingActionJobs(
  db: DatabaseClient,
  limit = 20,
): Promise<{ jobs: ActionJobRow[]; plans: JobRunPlan[] }> {
  const jobs = await listRunnableCdpJobs(db, limit);
  const plans = buildRunPlans(jobs);
  console.info(
    `[cdp-worker] runnable jobs detected count=${jobs.length} types=${CDP_WORKER_ACTION_TYPES.join(",")}`,
  );
  for (const plan of plans) {
    console.info("[cdp-worker] job", {
      id: plan.job.id,
      action_type: plan.actionType,
      status: plan.job.status,
      risk: plan.job.risk,
      blogId: plan.hints.blogId,
      postUrl: plan.hints.postUrl,
      hasDraft: Boolean(plan.hints.draftBody),
    });
  }
  return { jobs, plans };
}

/**
 * Claim + execute visit jobs.
 */
export async function runVisitActionJobs(
  db: DatabaseClient,
  context: BrowserContext | null,
  limit = 10,
): Promise<{
  picked: number;
  executed: number;
  failed: number;
  skippedClaim: number;
  skippedSafety: number;
  dryRun: number;
}> {
  const jobs = await listRunnableVisitJobs(db, limit);
  let executed = 0;
  let failed = 0;
  let skippedClaim = 0;
  let skippedSafety = 0;
  let dryRunCount = 0;

  console.info(`[worker] visit queue size=${jobs.length} dryRun=${isDryRun()}`);

  for (const job of jobs) {
    const targetUrl = resolveVisitUrl(job.target_ref);
    logActionEvent({
      phase: "pick",
      jobId: job.id,
      actionType: "visit",
      targetUrl,
      status: job.status,
    });

    const pre = await preflightAction(db, job, { targetUrl });
    if (!pre.ok) {
      skippedSafety += 1;
      continue;
    }

    if (isDryRun()) {
      dryRunCount += 1;
      logActionEvent({
        phase: "dry_run",
        jobId: job.id,
        actionType: "visit",
        targetUrl,
        status: job.status,
        result: "would_execute",
      });
      continue;
    }

    const claimed = await claimJobRunning(db, job.id);
    if (!claimed) {
      skippedClaim += 1;
      logActionEvent({
        phase: "skip",
        jobId: job.id,
        actionType: "visit",
        skipReason: "claim_lost",
      });
      continue;
    }

    const visitResult = await executeVisit(context!, {
      jobId: job.id,
      targetRef: job.target_ref,
    });

    if (visitResult.ok) {
      await updateJobResult(db, {
        ok: true,
        jobId: job.id,
        note: `visit ${visitResult.url}`,
      });
      executed += 1;
      logActionEvent({
        phase: "result",
        jobId: job.id,
        actionType: "visit",
        targetUrl: visitResult.url,
        result: "executed",
      });
    } else {
      await updateJobResult(db, {
        ok: false,
        jobId: job.id,
        error: visitResult.error,
      });
      failed += 1;
      logActionEvent({
        phase: "result",
        jobId: job.id,
        actionType: "visit",
        targetUrl,
        result: "failed",
        skipReason: visitResult.error,
      });
    }
  }

  return {
    picked: jobs.length,
    executed,
    failed,
    skippedClaim,
    skippedSafety,
    dryRun: dryRunCount,
  };
}

/**
 * Claim + execute at most one like job (ops safety).
 * Jobs without postUrl are skipped (not claimed).
 */
export async function runLikeActionJobs(
  db: DatabaseClient,
  context: BrowserContext | null,
  limit = LIKE_JOB_LIMIT,
): Promise<{
  picked: number;
  executed: number;
  failed: number;
  skippedNoUrl: number;
  skippedClaim: number;
  skippedSafety: number;
  dryRun: number;
}> {
  const jobs = await listRunnableLikeJobs(db, limit);
  let executed = 0;
  let failed = 0;
  let skippedNoUrl = 0;
  let skippedClaim = 0;
  let skippedSafety = 0;
  let dryRunCount = 0;

  console.info(
    `[worker] like queue size=${jobs.length} limit=${LIKE_JOB_LIMIT} dryRun=${isDryRun()}`,
  );

  for (const job of jobs) {
    const postUrl = resolveLikePostUrl(job.target_ref);
    const blogId =
      typeof job.target_ref?.blog_id === "string"
        ? job.target_ref.blog_id
        : null;
    logActionEvent({
      phase: "pick",
      jobId: job.id,
      actionType: "like",
      blogId,
      targetUrl: postUrl,
      status: job.status,
    });

    const testPostUrl = process.env.WORKER_TEST_POST_URL?.trim() || "";
    if (testPostUrl && !likeJobMatchesTestPostUrl(job, testPostUrl)) {
      logActionEvent({
        phase: "skip",
        jobId: job.id,
        actionType: "like",
        blogId,
        targetUrl: postUrl,
        skipReason: "test_mode_url_mismatch",
      });
      continue;
    }

    if (!postUrl) {
      logActionEvent({
        phase: "skip",
        jobId: job.id,
        actionType: "like",
        skipReason: "missing_post_url",
      });
      skippedNoUrl += 1;
      continue;
    }

    const pre = await preflightAction(db, job, {
      blogId,
      targetUrl: postUrl,
    });
    if (!pre.ok) {
      skippedSafety += 1;
      continue;
    }

    if (isDryRun()) {
      dryRunCount += 1;
      logActionEvent({
        phase: "dry_run",
        jobId: job.id,
        actionType: "like",
        blogId,
        targetUrl: postUrl,
        status: job.status,
        result: "would_execute",
      });
      continue;
    }

    const claimed = await claimJobRunning(db, job.id);
    if (!claimed) {
      skippedClaim += 1;
      logActionEvent({
        phase: "skip",
        jobId: job.id,
        actionType: "like",
        targetUrl: postUrl,
        skipReason: "claim_lost",
      });
      continue;
    }

    const likeResult = await executeLike(context!, {
      jobId: job.id,
      targetRef: job.target_ref,
    });

    if (likeResult.ok) {
      await updateJobResult(db, {
        ok: true,
        jobId: job.id,
        note: likeResult.alreadyLiked
          ? `like already_liked ${likeResult.url}`
          : `like ${likeResult.url}`,
      });
      executed += 1;
      logActionEvent({
        phase: "result",
        jobId: job.id,
        actionType: "like",
        blogId,
        targetUrl: likeResult.url,
        result: likeResult.alreadyLiked ? "executed_already_liked" : "executed",
      });
    } else {
      await updateJobResult(db, {
        ok: false,
        jobId: job.id,
        error: likeResult.error,
      });
      failed += 1;
      logActionEvent({
        phase: "result",
        jobId: job.id,
        actionType: "like",
        blogId,
        targetUrl: postUrl,
        result: "failed",
        skipReason: likeResult.error,
      });
    }
  }

  return {
    picked: jobs.length,
    executed,
    failed,
    skippedNoUrl,
    skippedClaim,
    skippedSafety,
    dryRun: dryRunCount,
  };
}

/** Fetch runnable comment jobs (max COMMENT_JOB_LIMIT; TEST_POST_URL filter). */
export async function listRunnableCommentJobs(
  db: DatabaseClient,
  limit = COMMENT_JOB_LIMIT,
): Promise<ActionJobRow[]> {
  const safeLimit = Math.max(1, Math.min(limit, COMMENT_JOB_LIMIT));
  const testPostUrl = process.env.WORKER_TEST_POST_URL?.trim() || "";

  if (!testPostUrl) {
    const { data, error } = await db
      .from("action_jobs")
      .select(
        "id, person_id, channel, action_type, risk, status, draft_body, target_ref, scheduled_for, created_at, updated_at, error",
      )
      .in("status", [...RUNNABLE_JOB_STATUSES])
      .eq("action_type", COMMENT_ACTION_TYPE)
      .order("created_at", { ascending: true })
      .limit(Math.max(safeLimit * 20, 50));

    if (error) {
      throw new Error(`listRunnableCommentJobs: ${error.message}`);
    }
    return gateExecutable((data ?? []) as ActionJobRow[], safeLimit);
  }

  if (!resolveLikePostUrl({ post_url: testPostUrl })) {
    console.error(
      `[worker] WORKER_TEST_POST_URL invalid for comment: ${testPostUrl}`,
    );
    return [];
  }

  console.info(
    `[worker] comment TEST MODE filter WORKER_TEST_POST_URL=${testPostUrl}`,
  );

  const { data, error } = await db
    .from("action_jobs")
    .select(
      "id, person_id, channel, action_type, risk, status, draft_body, target_ref, scheduled_for, created_at, updated_at, error",
    )
    .in("status", [...RUNNABLE_JOB_STATUSES])
    .eq("action_type", COMMENT_ACTION_TYPE)
    .order("created_at", { ascending: true })
    .limit(100);

  if (error) {
    throw new Error(`listRunnableCommentJobs: ${error.message}`);
  }

  const candidates = ((data ?? []) as ActionJobRow[]).filter((job) =>
    likeJobMatchesTestPostUrl(job, testPostUrl),
  );

  if (candidates.length === 0) {
    console.info(
      `[worker] comment TEST MODE: no planned/approved comment matching URL`,
    );
    return [];
  }

  candidates.sort((a, b) => {
    const aw = isWorkerTestJob(a) ? 0 : 1;
    const bw = isWorkerTestJob(b) ? 0 : 1;
    if (aw !== bw) return aw - bw;
    return a.created_at.localeCompare(b.created_at);
  });

  const gated = gateExecutable(candidates, safeLimit);
  if (gated.length === 0) {
    console.info(
      `[worker] comment TEST MODE: matched URL but blocked by status gate`,
    );
    return [];
  }

  const matched = gated[0]!;
  console.info(`[worker] comment TEST MODE matched job=${matched.id}`, {
    worker_test: isWorkerTestJob(matched),
    status: matched.status,
    post_url: jobPostUrlRaw(matched),
  });
  return [matched];
}

/**
 * Claim + execute at most one comment job.
 */
export async function runCommentActionJobs(
  db: DatabaseClient,
  context: BrowserContext | null,
  limit = COMMENT_JOB_LIMIT,
): Promise<{
  picked: number;
  executed: number;
  failed: number;
  skippedNoUrl: number;
  skippedNoDraft: number;
  skippedClaim: number;
  skippedSafety: number;
  dryRun: number;
}> {
  const jobs = await listRunnableCommentJobs(db, limit);
  let executed = 0;
  let failed = 0;
  let skippedNoUrl = 0;
  let skippedNoDraft = 0;
  let skippedClaim = 0;
  let skippedSafety = 0;
  let dryRunCount = 0;

  console.info(
    `[worker] comment queue size=${jobs.length} limit=${COMMENT_JOB_LIMIT} dryRun=${isDryRun()}`,
  );

  for (const job of jobs) {
    const postUrl = resolveLikePostUrl(job.target_ref);
    const blogId =
      typeof job.target_ref?.blog_id === "string"
        ? job.target_ref.blog_id
        : null;
    logActionEvent({
      phase: "pick",
      jobId: job.id,
      actionType: "comment",
      blogId,
      targetUrl: postUrl,
      status: job.status,
    });

    const testPostUrl = process.env.WORKER_TEST_POST_URL?.trim() || "";
    if (testPostUrl && !likeJobMatchesTestPostUrl(job, testPostUrl)) {
      logActionEvent({
        phase: "skip",
        jobId: job.id,
        actionType: "comment",
        blogId,
        targetUrl: postUrl,
        skipReason: "test_mode_url_mismatch",
      });
      continue;
    }

    if (!postUrl) {
      logActionEvent({
        phase: "skip",
        jobId: job.id,
        actionType: "comment",
        skipReason: "missing_post_url",
      });
      skippedNoUrl += 1;
      continue;
    }

    const body = resolveCommentBody(job.draft_body, job.target_ref);
    if (!body) {
      logActionEvent({
        phase: "skip",
        jobId: job.id,
        actionType: "comment",
        targetUrl: postUrl,
        skipReason: "missing_draft",
      });
      skippedNoDraft += 1;
      continue;
    }

    const pre = await preflightAction(db, job, {
      blogId,
      targetUrl: postUrl,
    });
    if (!pre.ok) {
      skippedSafety += 1;
      continue;
    }

    if (isDryRun()) {
      dryRunCount += 1;
      logActionEvent({
        phase: "dry_run",
        jobId: job.id,
        actionType: "comment",
        blogId,
        targetUrl: postUrl,
        status: job.status,
        result: "would_execute",
      });
      continue;
    }

    const claimed = await claimJobRunning(db, job.id);
    if (!claimed) {
      skippedClaim += 1;
      logActionEvent({
        phase: "skip",
        jobId: job.id,
        actionType: "comment",
        targetUrl: postUrl,
        skipReason: "claim_lost",
      });
      continue;
    }

    const commentResult = await executeComment(context!, {
      jobId: job.id,
      targetRef: job.target_ref,
      draftBody: job.draft_body,
    });

    if (commentResult.ok) {
      await updateJobResult(db, {
        ok: true,
        jobId: job.id,
        note: `comment ${commentResult.url}`,
      });
      executed += 1;
      logActionEvent({
        phase: "result",
        jobId: job.id,
        actionType: "comment",
        blogId,
        targetUrl: commentResult.url,
        result: "executed",
      });
    } else {
      await updateJobResult(db, {
        ok: false,
        jobId: job.id,
        error: commentResult.error,
      });
      failed += 1;
      logActionEvent({
        phase: "result",
        jobId: job.id,
        actionType: "comment",
        blogId,
        targetUrl: postUrl,
        result: "failed",
        skipReason: commentResult.error,
      });
    }
  }

  return {
    picked: jobs.length,
    executed,
    failed,
    skippedNoUrl,
    skippedNoDraft,
    skippedClaim,
    skippedSafety,
    dryRun: dryRunCount,
  };
}

