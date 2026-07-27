/**
 * Phase 4-1: create/update neighbor_performance after neighbor_request executed.
 * Minimal coupling — call only from neighbor_request success path.
 */

import type { DatabaseClient } from "../lib/supabase";

export type NeighborRequestStatus =
  | "requested"
  | "accepted"
  | "rejected"
  | "unknown";

export type RecordNeighborPerformanceInput = {
  actionJobId: string;
  blogId: string;
  blogUrl: string;
  alreadyNeighbor: boolean;
  alreadyPending: boolean;
  targetRef?: Record<string, unknown> | null;
};

function scoreFromRef(
  ref: Record<string, unknown> | null | undefined,
): number | null {
  if (!ref) return null;
  if (typeof ref.candidate_score === "number") return ref.candidate_score;
  return null;
}

function mapExecuteStatus(input: {
  alreadyNeighbor: boolean;
  alreadyPending: boolean;
}): NeighborRequestStatus {
  if (input.alreadyNeighbor) return "accepted";
  if (input.alreadyPending) return "requested";
  return "requested";
}

function outcomeFor(status: NeighborRequestStatus): string | null {
  if (status === "accepted") return "good_accepted";
  if (status === "rejected") return "bad_rejected";
  if (status === "requested") return null; // pending — label later if stale
  return null;
}

/**
 * Upsert performance row for an executed neighbor_request job.
 * Failures are logged only — must not fail the action job itself.
 */
export async function recordNeighborPerformanceOnExecute(
  db: DatabaseClient,
  input: RecordNeighborPerformanceInput,
): Promise<void> {
  const now = new Date().toISOString();
  const status = mapExecuteStatus(input);
  const blogId = input.blogId.trim();
  if (!blogId) return;

  const candidateScore = scoreFromRef(input.targetRef);

  // Link discovery_candidates by blog_id when present
  let discoveryCandidateId: string | null = null;
  try {
    const { data: cand } = await db
      .from("discovery_candidates")
      .select("id, candidate_score, meta")
      .eq("blog_id", blogId)
      .order("discovered_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (cand?.id) discoveryCandidateId = String(cand.id);
  } catch {
    // optional link
  }

  const row = {
    action_job_id: input.actionJobId,
    blog_id: blogId,
    blog_url: input.blogUrl,
    request_status: status,
    requested_at: now,
    accepted_at: status === "accepted" ? now : null,
    last_checked_at: now,
    profile_visit_count: 0,
    post_visit_count: 0,
    interaction_count: 0,
    candidate_score: candidateScore,
    discovery_candidate_id: discoveryCandidateId,
    outcome_label: outcomeFor(status),
    meta: {
      phase: "4-1",
      source: "cdp_neighbor_request_execute",
      already_neighbor: input.alreadyNeighbor,
      already_pending: input.alreadyPending,
    },
    updated_at: now,
  };

  const { error } = await db
    .from("neighbor_performance")
    .upsert(row, { onConflict: "action_job_id" });

  if (error) {
    console.warn(
      `[performance] upsert failed job=${input.actionJobId}: ${error.message} (run migration 009_neighbor_performance.sql?)`,
    );
    return;
  }

  console.info("[performance] recorded", {
    jobId: input.actionJobId,
    blogId,
    request_status: status,
    candidate_score: candidateScore,
  });
}
