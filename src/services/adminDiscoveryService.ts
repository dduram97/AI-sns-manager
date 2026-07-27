/**
 * Phase 3-5: Admin discovery candidate list / approve / exclude.
 */

import { createServiceClient } from "@/lib/supabase";
import { excludeNeighborBlog } from "@/services/neighborService";

export type AdminDiscoveryRow = {
  id: string;
  blogId: string;
  blogUrl: string;
  postUrl: string | null;
  keyword: string;
  score: number | null;
  candidateStatus: string;
  skipReason: string | null;
  lastActiveAt: string | null;
  blogName: string | null;
  actionJobId: string | null;
  jobStatus: string | null;
  jobActionType: string | null;
  discoveredAt: string;
};

export type AdminDiscoveryScreenData = {
  rows: AdminDiscoveryRow[];
  counts: {
    total: number;
    planned: number;
    approved: number;
    skipped: number;
    jobCreated: number;
  };
};

function scoreFromRow(row: {
  candidate_score?: number | null;
  meta?: Record<string, unknown> | null;
}): number | null {
  if (typeof row.candidate_score === "number") return row.candidate_score;
  const meta = row.meta ?? {};
  if (typeof meta.candidate_score === "number") return meta.candidate_score;
  return null;
}

export async function getAdminDiscoveryScreenData(opts?: {
  limit?: number;
}): Promise<AdminDiscoveryScreenData> {
  const db = createServiceClient();
  const limit = Math.max(1, Math.min(200, opts?.limit ?? 80));

  const { data, error } = await db
    .from("discovery_candidates")
    .select(
      "id, blog_id, blog_url, post_url, keyword, candidate_score, status, skip_reason, last_active_at, blog_name, action_job_id, meta, discovered_at",
    )
    .order("discovered_at", { ascending: false })
    .limit(limit);

  type CandidateDbRow = {
    id: string;
    blog_id: string;
    blog_url?: string | null;
    post_url?: string | null;
    keyword?: string | null;
    candidate_score?: number | null;
    status?: string | null;
    skip_reason?: string | null;
    last_active_at?: string | null;
    blog_name?: string | null;
    action_job_id?: string | null;
    meta?: Record<string, unknown> | null;
    discovered_at?: string | null;
  };

  let rowsRaw: CandidateDbRow[] = (data ?? []) as CandidateDbRow[];
  if (error) {
    if (/candidate_score|schema cache/i.test(error.message)) {
      const fallback = await db
        .from("discovery_candidates")
        .select(
          "id, blog_id, blog_url, post_url, keyword, status, skip_reason, last_active_at, blog_name, action_job_id, meta, discovered_at",
        )
        .order("discovered_at", { ascending: false })
        .limit(limit);
      if (fallback.error) {
        throw new Error(
          `getAdminDiscoveryScreenData: ${fallback.error.message}`,
        );
      }
      rowsRaw = (fallback.data ?? []) as CandidateDbRow[];
    } else {
      throw new Error(`getAdminDiscoveryScreenData: ${error.message}`);
    }
  }
  const jobIds = rowsRaw
    .map((r) => (typeof r.action_job_id === "string" ? r.action_job_id : null))
    .filter((id): id is string => Boolean(id));

  const jobMap = new Map<
    string,
    { status: string; action_type: string }
  >();
  if (jobIds.length > 0) {
    const { data: jobs, error: jobErr } = await db
      .from("action_jobs")
      .select("id, status, action_type")
      .in("id", jobIds);
    if (jobErr) {
      console.warn(`[admin] action_jobs lookup: ${jobErr.message}`);
    } else {
      for (const j of jobs ?? []) {
        jobMap.set(String(j.id), {
          status: String(j.status),
          action_type: String(j.action_type),
        });
      }
    }
  }

  const rows: AdminDiscoveryRow[] = rowsRaw.map((r) => {
    const jobId =
      typeof r.action_job_id === "string" ? r.action_job_id : null;
    const job = jobId ? jobMap.get(jobId) : undefined;
    return {
      id: String(r.id),
      blogId: String(r.blog_id),
      blogUrl: String(r.blog_url ?? `https://m.blog.naver.com/${r.blog_id}`),
      postUrl: typeof r.post_url === "string" ? r.post_url : null,
      keyword: String(r.keyword ?? ""),
      score: scoreFromRow(
        r as {
          candidate_score?: number | null;
          meta?: Record<string, unknown> | null;
        },
      ),
      candidateStatus: String(r.status ?? "new"),
      skipReason: typeof r.skip_reason === "string" ? r.skip_reason : null,
      lastActiveAt:
        typeof r.last_active_at === "string" ? r.last_active_at : null,
      blogName: typeof r.blog_name === "string" ? r.blog_name : null,
      actionJobId: jobId,
      jobStatus: job?.status ?? null,
      jobActionType: job?.action_type ?? null,
      discoveredAt: String(r.discovered_at ?? ""),
    };
  });

  // Prefer higher scores first among recent set
  rows.sort((a, b) => {
    const as = a.score ?? -1;
    const bs = b.score ?? -1;
    if (bs !== as) return bs - as;
    return b.discoveredAt.localeCompare(a.discoveredAt);
  });

  const counts = {
    total: rows.length,
    planned: rows.filter((r) => r.jobStatus === "planned").length,
    approved: rows.filter((r) => r.jobStatus === "approved").length,
    skipped: rows.filter((r) => r.candidateStatus === "skipped").length,
    jobCreated: rows.filter((r) => r.candidateStatus === "job_created").length,
  };

  return { rows, counts };
}

export async function approveAdminActionJob(input: {
  jobId: string;
  approvedBy?: string;
}): Promise<{ ok: boolean; errorMessage?: string }> {
  const db = createServiceClient();
  const jobId = input.jobId.trim();
  const approvedBy = (input.approvedBy ?? "admin_ui").trim() || "admin_ui";
  const approvedAt = new Date().toISOString();

  const { data: job, error: fetchErr } = await db
    .from("action_jobs")
    .select("id, action_type, status")
    .eq("id", jobId)
    .maybeSingle();
  if (fetchErr) {
    return { ok: false, errorMessage: fetchErr.message };
  }
  if (!job) return { ok: false, errorMessage: "job을 찾을 수 없습니다." };
  if (job.status === "approved") {
    return { ok: true };
  }
  if (job.status !== "planned") {
    return {
      ok: false,
      errorMessage: `승인 불가 상태: ${job.status}`,
    };
  }

  const patch: Record<string, unknown> = {
    status: "approved",
    approved_at: approvedAt,
    approved_by: approvedBy,
    updated_at: approvedAt,
    error: null,
  };

  let { error: updErr } = await db
    .from("action_jobs")
    .update(patch)
    .eq("id", jobId)
    .eq("status", "planned");

  if (updErr && /approved_at|approved_by|schema cache/i.test(updErr.message)) {
    const fallback = await db
      .from("action_jobs")
      .update({
        status: "approved",
        updated_at: approvedAt,
        error: null,
      })
      .eq("id", jobId)
      .eq("status", "planned");
    updErr = fallback.error;
  }

  if (updErr) return { ok: false, errorMessage: updErr.message };

  console.info(
    `[approve] job=${jobId} action=${job.action_type} approved_by=${approvedBy}`,
  );
  return { ok: true };
}

export async function excludeAdminDiscoveryCandidate(input: {
  candidateId: string;
  blogId: string;
  blogUrl?: string | null;
  blogName?: string | null;
}): Promise<{ ok: boolean; errorMessage?: string }> {
  const db = createServiceClient();
  const blogId = input.blogId.trim();
  if (!blogId) return { ok: false, errorMessage: "blog_id 없음" };

  try {
    await excludeNeighborBlog({
      blogId,
      blogUrl: input.blogUrl ?? undefined,
      blogName: input.blogName ?? undefined,
    });

    await db
      .from("discovery_candidates")
      .update({
        status: "skipped",
        skip_reason: "admin_exclude",
        updated_at: new Date().toISOString(),
      })
      .eq("id", input.candidateId);

    // If linked planned job exists, leave it planned but blocked by exclusion at execute;
    // optionally mark failed note — keep planned for audit; worker cooldown/exclusion handles skip.
    console.info(
      `[admin] exclude candidate=${input.candidateId} blog=${blogId}`,
    );
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}
