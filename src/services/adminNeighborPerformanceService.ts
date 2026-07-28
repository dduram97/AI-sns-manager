/**
 * Phase 4-1: Admin neighbor performance list + status refresh helpers.
 */

import { detailUrl, parseActionJobFailure } from "@/lib/actionJobFailure";
import { resolveCompletedRange } from "@/lib/completedRange";
import { createServiceClient } from "@/lib/supabase";

export type NeighborRequestStatus =
  | "requested"
  | "accepted"
  | "rejected"
  | "unknown";

export type AdminNeighborPerformanceRow = {
  id: string;
  actionJobId: string;
  blogId: string;
  blogUrl: string | null;
  requestStatus: NeighborRequestStatus;
  requestedAt: string | null;
  acceptedAt: string | null;
  lastCheckedAt: string | null;
  candidateScore: number | null;
  profileVisitCount: number;
  postVisitCount: number;
  interactionCount: number;
  engagementScore: number;
  outcomeLabel: string | null;
  daysSinceRequest: number | null;
};

export type AdminNeighborsScreenData = {
  rows: AdminNeighborPerformanceRow[];
  counts: {
    total: number;
    requested: number;
    accepted: number;
    rejected: number;
    unknown: number;
  };
  /** Today's failed neighbor_request jobs (for ops failure visibility). */
  recentFailures: Array<{
    id: string;
    blogId: string | null;
    targetUrl: string | null;
    failedAt: string | null;
    errorCode: string;
    errorMessage: string;
    failedStepLabel: string;
    retryable: boolean;
  }>;
};

function daysBetween(fromIso: string | null, now = Date.now()): number | null {
  if (!fromIso) return null;
  const t = Date.parse(fromIso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / 86_400_000));
}

function deriveStaleOutcome(
  status: NeighborRequestStatus,
  requestedAt: string | null,
  outcomeLabel: string | null,
): string | null {
  if (outcomeLabel) return outcomeLabel;
  if (status !== "requested") return outcomeLabel;
  const days = daysBetween(requestedAt);
  if (days != null && days >= 14) return "stale_no_response";
  return null;
}

export async function getAdminNeighborsScreenData(opts?: {
  limit?: number;
}): Promise<AdminNeighborsScreenData> {
  const db = createServiceClient();
  const limit = Math.max(1, Math.min(300, opts?.limit ?? 100));

  const { data, error } = await db
    .from("neighbor_performance")
    .select(
      "id, action_job_id, blog_id, blog_url, request_status, requested_at, accepted_at, last_checked_at, candidate_score, profile_visit_count, post_visit_count, interaction_count, outcome_label",
    )
    .order("requested_at", { ascending: false, nullsFirst: false })
    .limit(limit);

  if (error) {
    throw new Error(
      `getAdminNeighborsScreenData: ${error.message} (run migration 009_neighbor_performance.sql?)`,
    );
  }

  const rows: AdminNeighborPerformanceRow[] = (data ?? []).map((r) => {
    const profile = Number(r.profile_visit_count ?? 0) || 0;
    const post = Number(r.post_visit_count ?? 0) || 0;
    const interaction = Number(r.interaction_count ?? 0) || 0;
    const status = (String(r.request_status ?? "unknown") ||
      "unknown") as NeighborRequestStatus;
    const requestedAt =
      typeof r.requested_at === "string" ? r.requested_at : null;
    const outcomeLabel = deriveStaleOutcome(
      status,
      requestedAt,
      typeof r.outcome_label === "string" ? r.outcome_label : null,
    );

    return {
      id: String(r.id),
      actionJobId: String(r.action_job_id),
      blogId: String(r.blog_id),
      blogUrl: typeof r.blog_url === "string" ? r.blog_url : null,
      requestStatus: status,
      requestedAt,
      acceptedAt: typeof r.accepted_at === "string" ? r.accepted_at : null,
      lastCheckedAt:
        typeof r.last_checked_at === "string" ? r.last_checked_at : null,
      candidateScore:
        typeof r.candidate_score === "number" ? r.candidate_score : null,
      profileVisitCount: profile,
      postVisitCount: post,
      interactionCount: interaction,
      engagementScore: profile + post + interaction,
      outcomeLabel,
      daysSinceRequest: daysBetween(requestedAt),
    };
  });

  const counts = {
    total: rows.length,
    requested: rows.filter((r) => r.requestStatus === "requested").length,
    accepted: rows.filter((r) => r.requestStatus === "accepted").length,
    rejected: rows.filter((r) => r.requestStatus === "rejected").length,
    unknown: rows.filter((r) => r.requestStatus === "unknown").length,
  };

  const since = resolveCompletedRange({ preset: "today" }).fromIso;
  const { data: failedJobs } = await db
    .from("action_jobs")
    .select("id, target_ref, error, updated_at, status")
    .eq("action_type", "neighbor_request")
    .in("status", ["failed", "permanently_failed"])
    .gte("updated_at", since)
    .order("updated_at", { ascending: false })
    .limit(40);

  const recentFailures = (failedJobs ?? []).map((r) => {
    const ref = (r.target_ref ?? {}) as Record<string, unknown>;
    const error = typeof r.error === "string" ? r.error : null;
    const parsed = parseActionJobFailure({ error, targetRef: ref });
    const blogId =
      typeof ref.blog_id === "string"
        ? ref.blog_id
        : typeof ref.blogId === "string"
          ? ref.blogId
          : null;
    const targetUrl =
      typeof ref.blog_url === "string"
        ? ref.blog_url
        : typeof ref.post_url === "string"
          ? ref.post_url
          : blogId
            ? `https://m.blog.naver.com/${blogId}`
            : detailUrl(parsed?.detail ?? null);
    return {
      id: String(r.id),
      blogId,
      targetUrl,
      failedAt:
        parsed?.failedAt ??
        (typeof r.updated_at === "string" ? r.updated_at : null),
      errorCode: parsed?.errorCode ?? "UNKNOWN",
      errorMessage: parsed?.errorMessage ?? error ?? "실패",
      failedStepLabel: parsed?.failedStepLabel ?? "알 수 없음",
      retryable: parsed?.retryable ?? true,
    };
  });

  return { rows, counts, recentFailures };
}

/**
 * Refresh status from persons.discover_meta when available (no CDP).
 */
export async function refreshNeighborPerformanceFromMeta(input: {
  performanceId: string;
}): Promise<{ ok: boolean; status?: NeighborRequestStatus; errorMessage?: string }> {
  const db = createServiceClient();
  const { data: row, error } = await db
    .from("neighbor_performance")
    .select("id, blog_id, request_status, requested_at")
    .eq("id", input.performanceId)
    .maybeSingle();
  if (error) return { ok: false, errorMessage: error.message };
  if (!row) return { ok: false, errorMessage: "not_found" };

  const blogId = String(row.blog_id);
  const { data: persons } = await db
    .from("persons")
    .select("id, discover_meta")
    .eq("discover_meta->>blog_id", blogId)
    .limit(1);

  const meta = (persons?.[0]?.discover_meta ?? {}) as Record<string, unknown>;
  const relation =
    typeof meta.neighbor_relation_status === "string"
      ? meta.neighbor_relation_status
      : null;

  let status: NeighborRequestStatus = (row.request_status as NeighborRequestStatus) ||
    "unknown";
  let acceptedAt: string | null = null;
  let outcome: string | null = null;

  if (relation === "accepted") {
    status = "accepted";
    acceptedAt = new Date().toISOString();
    outcome = "good_accepted";
  } else if (relation === "requested") {
    status = "requested";
  } else if (relation === "failed" || relation === "rejected") {
    status = "rejected";
    outcome = "bad_rejected";
  } else {
    status = "unknown";
  }

  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {
    request_status: status,
    last_checked_at: now,
    updated_at: now,
    meta: {
      refreshed_from: "persons.discover_meta",
      neighbor_relation_status: relation,
      refreshed_at: now,
    },
  };
  if (status === "accepted") {
    patch.accepted_at = acceptedAt;
    patch.outcome_label = "good_accepted";
  } else if (status === "rejected") {
    patch.outcome_label = "bad_rejected";
  } else if (outcome) {
    patch.outcome_label = outcome;
  }

  const { error: updErr } = await db
    .from("neighbor_performance")
    .update(patch)
    .eq("id", input.performanceId);

  if (updErr) return { ok: false, errorMessage: updErr.message };
  return { ok: true, status };
}

export type AdminActionDetailData = {
  job: {
    id: string;
    actionType: string;
    status: string;
    risk: string;
    createdAt: string;
    executedAt: string | null;
    draftBody: string | null;
    targetRef: Record<string, unknown>;
    error: string | null;
    failure: {
      errorCode: string;
      errorMessage: string;
      failedStep: string;
      failedStepLabel: string;
      retryable: boolean;
      url: string | null;
      steps: string[];
      kind: "failure" | "skipped" | "excluded";
      summary: string;
    } | null;
  };
  candidateScore: number | null;
  blogId: string | null;
  blogUrl: string | null;
  performance: AdminNeighborPerformanceRow | null;
  discovery: {
    id: string;
    score: number | null;
    keyword: string | null;
    status: string;
  } | null;
};

export async function getAdminActionDetail(
  jobId: string,
): Promise<AdminActionDetailData | null> {
  const db = createServiceClient();
  const { data: job, error } = await db
    .from("action_jobs")
    .select(
      "id, action_type, status, risk, draft_body, target_ref, created_at, executed_at, error",
    )
    .eq("id", jobId)
    .maybeSingle();
  if (error || !job) return null;

  const ref = (job.target_ref ?? {}) as Record<string, unknown>;
  const jobError = typeof job.error === "string" ? job.error : null;
  const status = String(job.status ?? "");
  const parsed = parseActionJobFailure({
    error: jobError,
    targetRef: ref,
    status,
  });
  const isFailed =
    status === "failed" || status === "permanently_failed";
  const isSoft =
    status === "skipped" ||
    status === "excluded" ||
    (parsed != null && parsed.kind !== "failure");
  const blogId =
    typeof ref.blog_id === "string"
      ? ref.blog_id
      : typeof ref.blogId === "string"
        ? ref.blogId
        : null;
  const blogUrl =
    typeof ref.blog_url === "string"
      ? ref.blog_url
      : typeof ref.post_url === "string"
        ? ref.post_url
        : blogId
          ? `https://m.blog.naver.com/${blogId}`
          : null;
  const candidateScore =
    typeof ref.candidate_score === "number" ? ref.candidate_score : null;

  let performance: AdminNeighborPerformanceRow | null = null;
  const { data: perf } = await db
    .from("neighbor_performance")
    .select(
      "id, action_job_id, blog_id, blog_url, request_status, requested_at, accepted_at, last_checked_at, candidate_score, profile_visit_count, post_visit_count, interaction_count, outcome_label",
    )
    .eq("action_job_id", jobId)
    .maybeSingle();

  if (perf) {
    const profile = Number(perf.profile_visit_count ?? 0) || 0;
    const post = Number(perf.post_visit_count ?? 0) || 0;
    const interaction = Number(perf.interaction_count ?? 0) || 0;
    const status = String(perf.request_status ?? "unknown") as NeighborRequestStatus;
    const requestedAt =
      typeof perf.requested_at === "string" ? perf.requested_at : null;
    performance = {
      id: String(perf.id),
      actionJobId: String(perf.action_job_id),
      blogId: String(perf.blog_id),
      blogUrl: typeof perf.blog_url === "string" ? perf.blog_url : null,
      requestStatus: status,
      requestedAt,
      acceptedAt: typeof perf.accepted_at === "string" ? perf.accepted_at : null,
      lastCheckedAt:
        typeof perf.last_checked_at === "string" ? perf.last_checked_at : null,
      candidateScore:
        typeof perf.candidate_score === "number"
          ? perf.candidate_score
          : candidateScore,
      profileVisitCount: profile,
      postVisitCount: post,
      interactionCount: interaction,
      engagementScore: profile + post + interaction,
      outcomeLabel: typeof perf.outcome_label === "string" ? perf.outcome_label : null,
      daysSinceRequest: daysBetween(requestedAt),
    };
  }

  let discovery: AdminActionDetailData["discovery"] = null;
  if (blogId) {
    const { data: cand } = await db
      .from("discovery_candidates")
      .select("id, candidate_score, keyword, status, meta")
      .eq("blog_id", blogId)
      .order("discovered_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (cand) {
      const meta = (cand.meta ?? {}) as Record<string, unknown>;
      discovery = {
        id: String(cand.id),
        score:
          typeof cand.candidate_score === "number"
            ? cand.candidate_score
            : typeof meta.candidate_score === "number"
              ? meta.candidate_score
              : candidateScore,
        keyword: typeof cand.keyword === "string" ? cand.keyword : null,
        status: String(cand.status ?? ""),
      };
    }
  }

  return {
    job: {
      id: String(job.id),
      actionType: String(job.action_type),
      status: String(job.status),
      risk: String(job.risk),
      createdAt: String(job.created_at),
      executedAt: typeof job.executed_at === "string" ? job.executed_at : null,
      draftBody: typeof job.draft_body === "string" ? job.draft_body : null,
      targetRef: ref,
      error: jobError,
      failure:
        (isFailed || isSoft) && parsed
          ? {
              errorCode: parsed.errorCode,
              errorMessage: parsed.errorMessage,
              failedStep: parsed.failedStep,
              failedStepLabel: parsed.failedStepLabel,
              retryable: parsed.retryable,
              url: detailUrl(parsed.detail) ?? blogUrl,
              steps: parsed.steps,
              kind: parsed.kind,
              summary: parsed.summary,
            }
          : null,
    },
    candidateScore: candidateScore ?? discovery?.score ?? null,
    blogId,
    blogUrl,
    performance,
    discovery,
  };
}
