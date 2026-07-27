/**
 * Phase 3-3: CDP worker execution safety (limits / cooldown / delay / dry-run / approve gate).
 */

import type { DatabaseClient } from "../lib/supabase";

export type SafetyActionType = "like" | "comment" | "neighbor_request" | "visit";

export type ActionJobLite = {
  id: string;
  action_type: string;
  status: string;
  target_ref: Record<string, unknown> | null;
  created_at?: string;
};

function envBool(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw == null || raw === "") return defaultValue;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function envInt(name: string, defaultValue: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return defaultValue;
  const n = Number(raw);
  return Number.isFinite(n) ? n : defaultValue;
}

/** Ops: CDP worker executes approved by default. */
export function allowPlannedTestJobs(): boolean {
  return envBool("WORKER_ALLOW_PLANNED_TEST", true);
}

export function isDryRun(): boolean {
  return envBool("WORKER_DRY_RUN", false);
}

export function dailyLimitFor(actionType: SafetyActionType): number {
  switch (actionType) {
    case "like":
      return Math.max(0, envInt("WORKER_DAILY_LIKE_LIMIT", 20));
    case "comment":
      return Math.max(0, envInt("WORKER_DAILY_COMMENT_LIMIT", 10));
    case "neighbor_request":
      return Math.max(0, envInt("WORKER_DAILY_NEIGHBOR_LIMIT", 5));
    case "visit":
      return Math.max(0, envInt("WORKER_DAILY_VISIT_LIMIT", 50));
    default:
      return 0;
  }
}

export function actionCooldownHours(): number {
  return Math.max(0, envInt("WORKER_ACTION_COOLDOWN_HOURS", 24));
}

export function actionDelayRangeMs(): { minMs: number; maxMs: number } {
  const minMs = Math.max(0, envInt("WORKER_ACTION_DELAY_MIN_MS", 3_000));
  const maxMs = Math.max(minMs, envInt("WORKER_ACTION_DELAY_MAX_MS", 8_000));
  return { minMs, maxMs };
}

export function isWorkerTestRef(
  targetRef: Record<string, unknown> | null | undefined,
): boolean {
  return targetRef?.worker_test === true;
}

/**
 * approved → always runnable.
 * planned → only when worker_test=true AND WORKER_ALLOW_PLANNED_TEST.
 */
export function isJobStatusExecutable(job: ActionJobLite): boolean {
  if (job.status === "approved") return true;
  if (
    job.status === "planned" &&
    isWorkerTestRef(job.target_ref) &&
    allowPlannedTestJobs()
  ) {
    return true;
  }
  return false;
}

export function filterExecutableJobs<T extends ActionJobLite>(jobs: T[]): T[] {
  return jobs.filter((j) => isJobStatusExecutable(j));
}

/** Start of today in Asia/Seoul as UTC ISO. */
export function startOfTodayKstIso(now = new Date()): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const ymd = fmt.format(now); // YYYY-MM-DD
  // KST midnight = UTC previous day 15:00
  return new Date(`${ymd}T00:00:00+09:00`).toISOString();
}

export function cooldownSinceIso(now = new Date()): string {
  const hours = actionCooldownHours();
  return new Date(now.getTime() - hours * 3_600_000).toISOString();
}

export function logSafetyConfig(): void {
  console.info("[safety] config", {
    dryRun: isDryRun(),
    allowPlannedTest: allowPlannedTestJobs(),
    dailyLike: dailyLimitFor("like"),
    dailyComment: dailyLimitFor("comment"),
    dailyNeighbor: dailyLimitFor("neighbor_request"),
    cooldownHours: actionCooldownHours(),
    delayMs: actionDelayRangeMs(),
    timestamp: new Date().toISOString(),
  });
}

export function logActionEvent(input: {
  phase: "pick" | "skip" | "dry_run" | "claim" | "delay" | "result";
  jobId: string;
  actionType: string;
  blogId?: string | null;
  targetUrl?: string | null;
  result?: string;
  skipReason?: string;
  status?: string;
  extra?: Record<string, unknown>;
}): void {
  console.info("[worker][action]", {
    phase: input.phase,
    jobId: input.jobId,
    action_type: input.actionType,
    blog_id: input.blogId ?? null,
    target_url: input.targetUrl ?? null,
    status: input.status ?? null,
    result: input.result ?? null,
    skip_reason: input.skipReason ?? null,
    timestamp: new Date().toISOString(),
    ...(input.extra ?? {}),
  });
}

export async function countExecutedToday(
  db: DatabaseClient,
  actionType: SafetyActionType,
): Promise<number> {
  const since = startOfTodayKstIso();
  const { count, error } = await db
    .from("action_jobs")
    .select("id", { count: "exact", head: true })
    .eq("action_type", actionType)
    .eq("status", "executed")
    .gte("executed_at", since);
  if (error) {
    console.warn(
      `[safety] countExecutedToday ${actionType} failed: ${error.message}`,
    );
    return 0;
  }
  return count ?? 0;
}

export async function checkDailyLimit(
  db: DatabaseClient,
  actionType: SafetyActionType,
): Promise<{ ok: true } | { ok: false; reason: string; used: number; limit: number }> {
  const limit = dailyLimitFor(actionType);
  if (limit <= 0) {
    return {
      ok: false,
      reason: `daily_limit_zero:${actionType}`,
      used: 0,
      limit,
    };
  }
  const used = await countExecutedToday(db, actionType);
  if (used >= limit) {
    return {
      ok: false,
      reason: `daily_limit_exceeded:${actionType}:${used}/${limit}`,
      used,
      limit,
    };
  }
  return { ok: true };
}

function strRef(
  ref: Record<string, unknown> | null | undefined,
  ...keys: string[]
): string | null {
  if (!ref) return null;
  for (const key of keys) {
    const v = ref[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

export function normalizeUrlKey(url: string): string {
  try {
    const u = new URL(url.trim());
    let host = u.hostname.toLowerCase();
    if (host === "blog.naver.com" || host.endsWith(".blog.naver.com")) {
      host = "m.blog.naver.com";
    }
    const path = u.pathname.replace(/\/+$/, "") || "/";
    return `${host}${path}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase().replace(/\/+$/, "");
  }
}

/**
 * like/comment: block if same post_url was executed/failed recently.
 * neighbor_request: block if same blog_id has executed/failed/pending_approval/running recently.
 */
export async function checkCooldown(
  db: DatabaseClient,
  input: {
    actionType: SafetyActionType;
    jobId: string;
    blogId?: string | null;
    postUrl?: string | null;
  },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const hours = actionCooldownHours();
  if (hours <= 0) return { ok: true };

  const since = cooldownSinceIso();

  if (input.actionType === "neighbor_request") {
    const blogId = input.blogId?.trim();
    if (!blogId) return { ok: true };

    const { data, error } = await db
      .from("action_jobs")
      .select("id, status, target_ref, executed_at, updated_at, created_at")
      .eq("action_type", "neighbor_request")
      .in("status", [
        "executed",
        "failed",
        "pending_approval",
        "running",
        "permanently_failed",
      ])
      .neq("id", input.jobId)
      .gte("updated_at", since)
      .order("updated_at", { ascending: false })
      .limit(300);

    if (error) {
      console.warn(`[safety] neighbor cooldown query failed: ${error.message}`);
      return { ok: true };
    }

    const key = blogId.toLowerCase();
    for (const row of data ?? []) {
      const ref = (row.target_ref ?? {}) as Record<string, unknown>;
      const other =
        strRef(ref, "blog_id", "blogId")?.toLowerCase() ?? null;
      if (other === key) {
        return {
          ok: false,
          reason: `cooldown_neighbor:${row.status}:blog_id=${blogId}:hours=${hours}`,
        };
      }
    }
    return { ok: true };
  }

  if (input.actionType === "like" || input.actionType === "comment") {
    const postUrl = input.postUrl?.trim();
    if (!postUrl) return { ok: true };
    const want = normalizeUrlKey(postUrl);

    const { data, error } = await db
      .from("action_jobs")
      .select("id, status, target_ref, updated_at")
      .eq("action_type", input.actionType)
      .in("status", ["executed", "failed", "running", "permanently_failed"])
      .neq("id", input.jobId)
      .gte("updated_at", since)
      .order("updated_at", { ascending: false })
      .limit(300);

    if (error) {
      console.warn(
        `[safety] ${input.actionType} cooldown query failed: ${error.message}`,
      );
      return { ok: true };
    }

    for (const row of data ?? []) {
      const ref = (row.target_ref ?? {}) as Record<string, unknown>;
      const raw =
        strRef(ref, "post_url", "url", "permalink") ??
        null;
      if (!raw) continue;
      if (normalizeUrlKey(raw) === want) {
        return {
          ok: false,
          reason: `cooldown_${input.actionType}:${row.status}:post_url:hours=${hours}`,
        };
      }
    }
  }

  return { ok: true };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function maybeDelayBeforeAction(
  actionType: SafetyActionType,
): Promise<number> {
  if (actionType !== "neighbor_request") return 0;
  if (isDryRun()) return 0;
  const { minMs, maxMs } = actionDelayRangeMs();
  if (maxMs <= 0) return 0;
  const ms =
    minMs >= maxMs
      ? minMs
      : minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
  if (ms > 0) {
    console.info(`[safety] delay action_type=${actionType} ms=${ms}`);
    await sleep(ms);
  }
  return ms;
}

/**
 * Shared preflight before claim. Does not claim / mutate status.
 */
export async function preflightAction(
  db: DatabaseClient,
  job: ActionJobLite,
  hints: { blogId?: string | null; targetUrl?: string | null },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const actionType = job.action_type as SafetyActionType;

  if (!isJobStatusExecutable(job)) {
    const reason =
      job.status === "planned" && !isWorkerTestRef(job.target_ref)
        ? "planned_requires_approval"
        : job.status === "planned" && !allowPlannedTestJobs()
          ? "planned_test_disabled"
          : `status_not_executable:${job.status}`;
    logActionEvent({
      phase: "skip",
      jobId: job.id,
      actionType,
      blogId: hints.blogId,
      targetUrl: hints.targetUrl,
      status: job.status,
      skipReason: reason,
    });
    return { ok: false, reason };
  }

  const daily = await checkDailyLimit(db, actionType);
  if (!daily.ok) {
    logActionEvent({
      phase: "skip",
      jobId: job.id,
      actionType,
      blogId: hints.blogId,
      targetUrl: hints.targetUrl,
      status: job.status,
      skipReason: daily.reason,
      extra: { used: daily.used, limit: daily.limit },
    });
    return { ok: false, reason: daily.reason };
  }

  const cool = await checkCooldown(db, {
    actionType,
    jobId: job.id,
    blogId: hints.blogId,
    postUrl: hints.targetUrl,
  });
  if (!cool.ok) {
    logActionEvent({
      phase: "skip",
      jobId: job.id,
      actionType,
      blogId: hints.blogId,
      targetUrl: hints.targetUrl,
      status: job.status,
      skipReason: cool.reason,
    });
    return { ok: false, reason: cool.reason };
  }

  return { ok: true };
}
