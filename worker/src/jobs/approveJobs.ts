/**
 * Phase 3-4: approve planned action_jobs (esp. discovery neighbor_request).
 * status: planned → approved (existing enum). Sets approved_at / approved_by.
 */

import type { DatabaseClient } from "../lib/supabase";

export type ApproveJobResult =
  | {
      ok: true;
      jobId: string;
      actionType: string;
      previousStatus: string;
      status: "approved";
      approvedAt: string;
      approvedBy: string;
    }
  | { ok: false; jobId?: string; reason: string };

export type ApproveCandidatesSummary = {
  scoreMin: number;
  limit: number;
  scannedCandidates: number;
  matchedJobs: number;
  approved: number;
  skipped: number;
  errors: string[];
  approvedJobIds: string[];
};

function supportsApprovalColumns(errorMessage: string): boolean {
  return !/approved_at|approved_by|schema cache/i.test(errorMessage);
}

export async function approveJobById(
  db: DatabaseClient,
  input: {
    jobId: string;
    approvedBy?: string;
    /** When true, allow re-approve already approved (refresh approved_at). */
    allowAlreadyApproved?: boolean;
  },
): Promise<ApproveJobResult> {
  const jobId = input.jobId.trim();
  const approvedBy = (input.approvedBy ?? "cli").trim() || "cli";
  const approvedAt = new Date().toISOString();

  const { data: job, error: fetchErr } = await db
    .from("action_jobs")
    .select(
      "id, action_type, status, risk, target_ref, draft_body, created_at",
    )
    .eq("id", jobId)
    .maybeSingle();

  if (fetchErr) {
    return { ok: false, jobId, reason: `fetch: ${fetchErr.message}` };
  }
  if (!job) {
    return { ok: false, jobId, reason: "job_not_found" };
  }

  const previousStatus = String(job.status);
  if (previousStatus === "approved" && !input.allowAlreadyApproved) {
    console.info(
      `[approve] job=${jobId} action=${job.action_type} already_approved skip`,
    );
    return {
      ok: false,
      jobId,
      reason: "already_approved",
    };
  }

  if (previousStatus !== "planned" && previousStatus !== "approved") {
    return {
      ok: false,
      jobId,
      reason: `status_not_approvable:${previousStatus}`,
    };
  }

  const patchWithCols: Record<string, unknown> = {
    status: "approved",
    approved_at: approvedAt,
    approved_by: approvedBy,
    updated_at: approvedAt,
    error: null,
  };

  let { data: updated, error: updErr } = await db
    .from("action_jobs")
    .update(patchWithCols)
    .eq("id", jobId)
    .in("status", ["planned", "approved"])
    .select("id, action_type, status")
    .maybeSingle();

  // Migration 008 not applied yet — fall back to status-only approve.
  if (updErr && !supportsApprovalColumns(updErr.message)) {
    console.warn(
      `[approve] approved_at/by columns missing — status-only update (${updErr.message})`,
    );
    const fallback = await db
      .from("action_jobs")
      .update({
        status: "approved",
        updated_at: approvedAt,
        error: null,
      })
      .eq("id", jobId)
      .in("status", ["planned", "approved"])
      .select("id, action_type, status")
      .maybeSingle();
    updated = fallback.data;
    updErr = fallback.error;
  }

  if (updErr) {
    return { ok: false, jobId, reason: `update: ${updErr.message}` };
  }
  if (!updated?.id) {
    return { ok: false, jobId, reason: "claim_lost_or_status_changed" };
  }

  console.info(
    `[approve] job=${jobId} action=${updated.action_type} approved_by=${approvedBy}`,
  );

  return {
    ok: true,
    jobId,
    actionType: String(updated.action_type),
    previousStatus,
    status: "approved",
    approvedAt,
    approvedBy,
  };
}

/**
 * Approve neighbor_request jobs linked from scored discovery_candidates.
 */
export async function approveCandidatesByScore(
  db: DatabaseClient,
  input: {
    scoreMin?: number;
    limit?: number;
    keyword?: string | null;
    approvedBy?: string;
  },
): Promise<ApproveCandidatesSummary> {
  const scoreMin = Math.max(0, Math.min(100, input.scoreMin ?? 70));
  const limit = Math.max(1, Math.min(100, input.limit ?? 10));
  const approvedBy = (input.approvedBy ?? "cli").trim() || "cli";
  const keyword = input.keyword?.trim() || null;

  const summary: ApproveCandidatesSummary = {
    scoreMin,
    limit,
    scannedCandidates: 0,
    matchedJobs: 0,
    approved: 0,
    skipped: 0,
    errors: [],
    approvedJobIds: [],
  };

  let query = db
    .from("discovery_candidates")
    .select(
      "id, blog_id, blog_url, candidate_score, status, action_job_id, keyword, meta, discovered_at",
    )
    .eq("status", "job_created")
    .not("action_job_id", "is", null)
    .order("discovered_at", { ascending: false })
    .limit(Math.max(limit * 5, 50));

  if (keyword) {
    query = query.eq("keyword", keyword);
  }

  const { data: rows, error } = await query;
  if (error) {
    throw new Error(
      `list discovery_candidates: ${error.message} (run migration 006/007?)`,
    );
  }

  return approveFromCandidateRows(
    db,
    (rows ?? []) as CandidateRow[],
    summary,
    scoreMin,
    limit,
    approvedBy,
  );
}

type CandidateRow = {
  id: string;
  blog_id: string;
  blog_url: string | null;
  candidate_score: number | null;
  status: string;
  action_job_id: string | null;
  keyword: string | null;
  meta: Record<string, unknown> | null;
};

function scoreOf(row: CandidateRow): number {
  if (typeof row.candidate_score === "number") return row.candidate_score;
  const meta = row.meta ?? {};
  if (typeof meta.candidate_score === "number") return meta.candidate_score;
  return 0;
}

async function approveFromCandidateRows(
  db: DatabaseClient,
  rows: CandidateRow[],
  summary: ApproveCandidatesSummary,
  scoreMin: number,
  limit: number,
  approvedBy: string,
): Promise<ApproveCandidatesSummary> {
  const ranked = [...rows]
    .map((r) => ({ row: r, score: scoreOf(r) }))
    .filter((x) => x.score >= scoreMin)
    .sort((a, b) => b.score - a.score || a.row.blog_id.localeCompare(b.row.blog_id));

  summary.scannedCandidates = rows.length;

  for (const { row, score } of ranked) {
    if (summary.approved >= limit) break;
    const jobId = row.action_job_id?.trim();
    if (!jobId) {
      summary.skipped += 1;
      continue;
    }
    summary.matchedJobs += 1;

    console.info("[approve] candidate", {
      blogId: row.blog_id,
      score,
      jobId,
      keyword: row.keyword,
    });

    const result = await approveJobById(db, { jobId, approvedBy });
    if (result.ok) {
      summary.approved += 1;
      summary.approvedJobIds.push(result.jobId);
    } else {
      summary.skipped += 1;
      if (result.reason !== "already_approved") {
        summary.errors.push(`${jobId}: ${result.reason}`);
      }
      console.info(
        `[approve] skip job=${jobId} reason=${result.reason} blog=${row.blog_id}`,
      );
    }
  }

  console.info("[approve] candidates done", {
    scoreMin,
    limit,
    scanned: summary.scannedCandidates,
    approved: summary.approved,
    skipped: summary.skipped,
  });

  return summary;
}
