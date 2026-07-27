/**
 * Phase 3-1/3-2: keyword candidate discovery → scored → planned neighbor_request.
 *
 * - Search via Naver Blog Search API
 * - Persist discovery_candidates (+ candidate_score)
 * - Skip blogs already in action_jobs / neighbor relation / exclusions
 * - Low scores skipped; jobs created in score desc order (top-N)
 * - Create planned neighbor_request only (no CDP execute)
 */

import type { DatabaseClient } from "../lib/supabase";
import {
  DISCOVERY_DEFAULT_JOB_MAX,
  DISCOVERY_DEFAULT_MIN_SCORE,
  scoreCandidates,
  sortScoredDescending,
  type ScoredCandidate,
} from "./candidateScore";
import {
  hasNaverSearchApiCredentials,
  searchBlogCandidates,
  type DiscoveredBlogHit,
} from "../naver/naverBlogSearch";

export const DISCOVERY_DEFAULT_KEYWORD =
  process.env.WORKER_DISCOVERY_KEYWORD?.trim() || "일상";
export const DISCOVERY_DEFAULT_LIMIT = 10;

const DEFAULT_MESSAGE =
  "안녕하세요. 관심사가 비슷해 서로이웃 신청드립니다.";

export type CandidateDiscoveryInput = {
  keyword?: string;
  /** Search pool size (Phase 3-2 test: 50). */
  limit?: number;
  /** Max planned jobs to create from top scores. */
  jobMax?: number;
  /** Minimum candidate_score required to create a job. */
  minScore?: number;
  /** When true, search + filter + log only (no DB writes). */
  dryRun?: boolean;
};

export type CandidateDiscoverySummary = {
  keyword: string;
  limit: number;
  jobMax: number;
  minScore: number;
  dryRun: boolean;
  searched: number;
  rawItemCount: number;
  scored: number;
  skippedExistingJob: number;
  skippedNeighbor: number;
  skippedExcluded: number;
  skippedLowScore: number;
  skippedBelowRank: number;
  skippedDuplicateCandidate: number;
  savedCandidates: number;
  createdJobs: number;
  topScores: Array<{ blogId: string; score: number }>;
  errors: string[];
  createdJobIds: string[];
};

function blogKey(id: string): string {
  return id.trim().toLowerCase();
}

function strMeta(
  meta: Record<string, unknown> | null | undefined,
  ...keys: string[]
): string | null {
  if (!meta) return null;
  for (const key of keys) {
    const v = meta[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

async function loadExcludedBlogIds(db: DatabaseClient): Promise<Set<string>> {
  const set = new Set<string>();
  const { data, error } = await db
    .from("neighbor_exclusions")
    .select("blog_id")
    .limit(5_000);
  if (error) {
    console.warn(`[discovery] neighbor_exclusions: ${error.message}`);
    return set;
  }
  for (const row of data ?? []) {
    const id = typeof row.blog_id === "string" ? row.blog_id : "";
    if (id) set.add(blogKey(id));
  }
  return set;
}

/** Any neighbor_request action_job for blog_id (all statuses). */
async function loadActionJobBlogIds(db: DatabaseClient): Promise<Set<string>> {
  const set = new Set<string>();
  const { data, error } = await db
    .from("action_jobs")
    .select("id, target_ref")
    .eq("action_type", "neighbor_request")
    .order("created_at", { ascending: false })
    .limit(2_000);
  if (error) {
    throw new Error(`loadActionJobBlogIds: ${error.message}`);
  }
  for (const row of data ?? []) {
    const ref = (row.target_ref ?? {}) as Record<string, unknown>;
    const id = strMeta(ref, "blog_id", "blogId");
    if (id) set.add(blogKey(id));
  }
  return set;
}

function asMetaObject(
  raw: unknown,
): Record<string, unknown> | null {
  if (raw == null) return null;
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed || trimmed === "{}" || trimmed === "null") return null;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function isNeighborRelationMeta(meta: Record<string, unknown>): boolean {
  const status = strMeta(meta, "neighbor_relation_status");
  const source = strMeta(meta, "source");
  return (
    status === "accepted" ||
    status === "requested" ||
    source === "existing_sync" ||
    source === "neighbor_request"
  );
}

/**
 * Existing neighbor / requested / buddy-synced blogs from persons.discover_meta.
 * discover_meta is jsonb — never compare against JS `{}` in PostgREST filters
 * (causes: invalid input syntax for type json).
 */
async function loadNeighborRelationBlogIds(
  db: DatabaseClient,
): Promise<Set<string>> {
  const set = new Set<string>();

  const { data, error } = await db
    .from("persons")
    .select("id, discover_meta")
    .or(
      [
        "discover_meta->>neighbor_relation_status.eq.accepted",
        "discover_meta->>neighbor_relation_status.eq.requested",
        "discover_meta->>source.eq.existing_sync",
        "discover_meta->>source.eq.neighbor_request",
      ].join(","),
    )
    .order("updated_at", { ascending: false })
    .limit(3_000);

  if (error) {
    console.warn(
      `[discovery] loadNeighborRelationBlogIds filter failed: ${error.message}; falling back to scan`,
    );
    const fallback = await db
      .from("persons")
      .select("id, discover_meta")
      .order("updated_at", { ascending: false })
      .limit(3_000);
    if (fallback.error) {
      console.warn(
        `[discovery] loadNeighborRelationBlogIds fallback failed: ${fallback.error.message}; continuing with empty neighbor set`,
      );
      return set;
    }
    for (const row of fallback.data ?? []) {
      try {
        const meta = asMetaObject(row.discover_meta);
        if (!meta) continue;
        const blogId = strMeta(meta, "blog_id", "blogId");
        if (!blogId) continue;
        if (isNeighborRelationMeta(meta)) set.add(blogKey(blogId));
      } catch (err) {
        console.warn(
          `[discovery] skip person=${row.id} bad discover_meta`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    return set;
  }

  for (const row of data ?? []) {
    try {
      const meta = asMetaObject(row.discover_meta);
      if (!meta) continue;
      const blogId = strMeta(meta, "blog_id", "blogId");
      if (!blogId) continue;
      if (isNeighborRelationMeta(meta)) set.add(blogKey(blogId));
    } catch (err) {
      console.warn(
        `[discovery] skip person=${row.id} bad discover_meta`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return set;
}

async function supportsCandidateScoreColumn(
  db: DatabaseClient,
): Promise<boolean> {
  const { error } = await db
    .from("discovery_candidates")
    .select("candidate_score")
    .limit(1);
  if (!error) return true;
  console.warn(
    `[discovery] candidate_score column missing — store score in meta only until migration 007 is applied (${error.message})`,
  );
  return false;
}
async function loadExistingDiscoveryRows(
  db: DatabaseClient,
): Promise<Map<string, { id: string; status: string }>> {
  const map = new Map<string, { id: string; status: string }>();
  const { data, error } = await db
    .from("discovery_candidates")
    .select("id, blog_id, status")
    .limit(5_000);
  if (error) {
    throw new Error(
      `loadExistingDiscoveryRows: ${error.message} (run migration 006/007?)`,
    );
  }
  for (const row of data ?? []) {
    const id = typeof row.blog_id === "string" ? row.blog_id : "";
    if (!id) continue;
    map.set(blogKey(id), {
      id: String(row.id),
      status: String(row.status ?? "new"),
    });
  }
  return map;
}

async function ensurePersonAndWorkflow(
  db: DatabaseClient,
  hit: DiscoveredBlogHit,
  score: number,
): Promise<{ personId: string; workflowId: string }> {
  const { data: existingPersons, error: findErr } = await db
    .from("persons")
    .select("id, discover_meta, active_workflow_id")
    .eq("discover_meta->>blog_id", hit.blogId)
    .limit(1);
  if (findErr) throw new Error(`find person: ${findErr.message}`);

  let personId = existingPersons?.[0]?.id
    ? String(existingPersons[0].id)
    : null;

  if (!personId) {
    const { data: person, error: personErr } = await db
      .from("persons")
      .insert({
        display_name: hit.blogName.slice(0, 80) || hit.blogId,
        discover_meta: {
          blog_id: hit.blogId,
          blog_url: hit.blogUrl,
          post_url: hit.postUrl,
          last_active_at: hit.lastActiveAt,
          nickname: hit.blogName.slice(0, 80) || hit.blogId,
          snippet: hit.snippet,
          source: "candidate_discovery",
          collected_at: new Date().toISOString(),
          matched_keywords: [hit.keyword],
          candidate_score: score,
        },
      })
      .select("id")
      .single();
    if (personErr) throw new Error(`create person: ${personErr.message}`);
    personId = String(person.id);

    await db.from("relationship_states").upsert({
      person_id: personId,
      stage: "discover",
      score: 0,
      temperature: 0,
    });

    await db.from("channel_identities").upsert(
      {
        person_id: personId,
        channel: "blog",
        external_key: hit.blogId,
        state: {},
        profile_snapshot: {
          blog_id: hit.blogId,
          blog_url: hit.blogUrl,
        },
      },
      { onConflict: "channel,external_key" },
    );
  } else {
    const prev = asMetaObject(existingPersons?.[0]?.discover_meta) ?? {};
    await db
      .from("persons")
      .update({
        discover_meta: {
          ...prev,
          blog_id: hit.blogId,
          blog_url: hit.blogUrl,
          post_url: hit.postUrl ?? prev.post_url ?? null,
          last_active_at: hit.lastActiveAt ?? prev.last_active_at ?? null,
          source: prev.source ?? "candidate_discovery",
          candidate_score: score,
          discovery_refreshed_at: new Date().toISOString(),
        },
        updated_at: new Date().toISOString(),
      })
      .eq("id", personId);
  }

  const { data: existingWf, error: wfLookupErr } = await db
    .from("workflows")
    .select("id")
    .eq("person_id", personId)
    .in("current_state", ["active", "waiting", "blocked"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (wfLookupErr) throw new Error(`lookup workflow: ${wfLookupErr.message}`);

  if (existingWf?.id) {
    return { personId, workflowId: String(existingWf.id) };
  }

  const { data: wf, error: wfErr } = await db
    .from("workflows")
    .insert({
      person_id: personId,
      current_stage: "discover",
      current_state: "active",
      next_action: "neighbor_request",
      priority: 5,
      goal: "candidate_discovery_neighbor_request",
    })
    .select("id")
    .single();
  if (wfErr) throw new Error(`create workflow: ${wfErr.message}`);

  await db
    .from("persons")
    .update({ active_workflow_id: wf.id })
    .eq("id", personId);

  return { personId, workflowId: String(wf.id) };
}

async function upsertCandidateRow(
  db: DatabaseClient,
  hit: ScoredCandidate,
  patch: {
    status: "new" | "skipped" | "job_created";
    skipReason?: string | null;
    actionJobId?: string | null;
    personId?: string | null;
  },
  opts?: { writeScoreColumn?: boolean },
): Promise<string> {
  const row: Record<string, unknown> = {
    blog_id: hit.blogId,
    blog_url: hit.blogUrl,
    post_url: hit.postUrl,
    last_active_at: hit.lastActiveAt,
    keyword: hit.keyword,
    blog_name: hit.blogName,
    snippet: hit.snippet,
    post_title: hit.postTitle,
    status: patch.status,
    skip_reason: patch.skipReason ?? null,
    action_job_id: patch.actionJobId ?? null,
    person_id: patch.personId ?? null,
    meta: {
      phase: "3-2",
      source: "naver_blog_search_api",
      candidate_score: hit.score,
      score_breakdown: hit.scoreBreakdown,
    },
    updated_at: new Date().toISOString(),
  };
  if (opts?.writeScoreColumn !== false) {
    row.candidate_score = hit.score;
  }

  const { data, error } = await db
    .from("discovery_candidates")
    .upsert(row, { onConflict: "blog_id" })
    .select("id")
    .single();
  if (error) {
    throw new Error(
      `upsert discovery_candidates: ${error.message} (run migration 007_candidate_score.sql?)`,
    );
  }
  return String(data.id);
}

async function createPlannedNeighborJob(
  db: DatabaseClient,
  hit: ScoredCandidate,
  personId: string,
  workflowId: string,
): Promise<string> {
  const draftBody =
    process.env.WORKER_DISCOVERY_MESSAGE?.trim() || DEFAULT_MESSAGE;

  const targetRef = {
    blog_id: hit.blogId,
    blog_url: hit.blogUrl,
    post_url: hit.postUrl,
    last_active_at: hit.lastActiveAt,
    title: hit.blogName,
    keyword: hit.keyword,
    candidate_score: hit.score,
    score_breakdown: hit.scoreBreakdown,
    source: "candidate_discovery",
    // Phase 3-3: discovery jobs stay planned until approved (not worker_test).
    smoke: "cdp_worker_discovery",
  };

  const { data: job, error } = await db
    .from("action_jobs")
    .insert({
      parent_workflow_id: workflowId,
      person_id: personId,
      channel: "blog",
      action_type: "neighbor_request",
      risk: "high",
      status: "planned",
      draft_body: draftBody,
      target_ref: targetRef,
      inbox_priority: Math.max(0, hit.score),
    })
    .select("id")
    .single();

  if (error) {
    throw new Error(`create action_job: ${error.message}`);
  }
  return String(job.id);
}

/**
 * Run discovery: search → score → store → top-N planned neighbor_request.
 * Does NOT execute CDP neighbor_request.
 */
export async function runCandidateDiscovery(
  db: DatabaseClient,
  input: CandidateDiscoveryInput = {},
): Promise<CandidateDiscoverySummary> {
  const keyword = (input.keyword ?? DISCOVERY_DEFAULT_KEYWORD).trim();
  const limit = Math.max(
    1,
    Math.min(100, input.limit ?? DISCOVERY_DEFAULT_LIMIT),
  );
  const jobMax = Math.max(
    1,
    Math.min(
      limit,
      input.jobMax ??
        (Number.isFinite(DISCOVERY_DEFAULT_JOB_MAX)
          ? DISCOVERY_DEFAULT_JOB_MAX
          : 10),
    ),
  );
  const minScore = Math.max(
    0,
    Math.min(
      100,
      input.minScore ??
        (Number.isFinite(DISCOVERY_DEFAULT_MIN_SCORE)
          ? DISCOVERY_DEFAULT_MIN_SCORE
          : 55),
    ),
  );
  const dryRun = Boolean(input.dryRun);

  const summary: CandidateDiscoverySummary = {
    keyword,
    limit,
    jobMax,
    minScore,
    dryRun,
    searched: 0,
    rawItemCount: 0,
    scored: 0,
    skippedExistingJob: 0,
    skippedNeighbor: 0,
    skippedExcluded: 0,
    skippedLowScore: 0,
    skippedBelowRank: 0,
    skippedDuplicateCandidate: 0,
    savedCandidates: 0,
    createdJobs: 0,
    topScores: [],
    errors: [],
    createdJobIds: [],
  };

  console.info("[discovery] start", {
    keyword,
    limit,
    jobMax,
    minScore,
    dryRun,
  });

  if (!hasNaverSearchApiCredentials()) {
    throw new Error(
      "NAVER_CLIENT_ID / NAVER_CLIENT_SECRET required for candidate discovery",
    );
  }

  const search = await searchBlogCandidates({ keyword, maxTotal: limit });
  summary.searched = search.hits.length;
  summary.rawItemCount = search.rawItemCount;
  console.info("[discovery] search done", {
    hits: search.hits.length,
    rawItemCount: search.rawItemCount,
    duplicatesRemoved: search.duplicatesRemoved,
  });

  const scoredAll = sortScoredDescending(scoreCandidates(search.hits));
  summary.scored = scoredAll.length;
  summary.topScores = scoredAll.slice(0, 15).map((c) => ({
    blogId: c.blogId,
    score: c.score,
  }));
  console.info("[discovery] scored", {
    count: scoredAll.length,
    top: summary.topScores.slice(0, 5),
    minScore,
    jobMax,
  });

  const [excluded, jobBlogs, neighborBlogs, priorRows, writeScoreColumn] =
    await Promise.all([
      loadExcludedBlogIds(db),
      loadActionJobBlogIds(db),
      loadNeighborRelationBlogIds(db),
      dryRun
        ? Promise.resolve(new Map<string, { id: string; status: string }>())
        : loadExistingDiscoveryRows(db),
      dryRun ? Promise.resolve(true) : supportsCandidateScoreColumn(db),
    ]);

  const scoreOpts = { writeScoreColumn };

  type SoftSkip = { hit: ScoredCandidate; reason: string };
  const hardSkipped: SoftSkip[] = [];
  const eligible: ScoredCandidate[] = [];

  for (const hit of scoredAll) {
    const key = blogKey(hit.blogId);
    console.info("[discovery] candidate", {
      blogId: hit.blogId,
      score: hit.score,
      breakdown: hit.scoreBreakdown,
      postUrl: hit.postUrl,
      lastActiveAt: hit.lastActiveAt,
    });

    if (excluded.has(key)) {
      summary.skippedExcluded += 1;
      hardSkipped.push({ hit, reason: "neighbor_exclusion" });
      continue;
    }
    if (jobBlogs.has(key)) {
      summary.skippedExistingJob += 1;
      hardSkipped.push({ hit, reason: "existing_action_job" });
      continue;
    }
    if (neighborBlogs.has(key)) {
      summary.skippedNeighbor += 1;
      hardSkipped.push({ hit, reason: "existing_neighbor_relation" });
      continue;
    }

    const prior = priorRows.get(key);
    if (prior && prior.status === "job_created") {
      summary.skippedDuplicateCandidate += 1;
      hardSkipped.push({ hit, reason: "existing_discovery_job" });
      continue;
    }

    eligible.push(hit);
  }

  // Persist hard skips with scores (do not downgrade job_created → skipped).
  if (!dryRun) {
    for (const { hit, reason } of hardSkipped) {
      try {
        const key = blogKey(hit.blogId);
        const prior = priorRows.get(key);
        if (prior?.status === "job_created") {
          const patch: Record<string, unknown> = {
            post_url: hit.postUrl,
            last_active_at: hit.lastActiveAt,
            keyword: hit.keyword,
            blog_name: hit.blogName,
            snippet: hit.snippet,
            post_title: hit.postTitle,
            meta: {
              phase: "3-2",
              source: "naver_blog_search_api",
              candidate_score: hit.score,
              score_breakdown: hit.scoreBreakdown,
            },
            updated_at: new Date().toISOString(),
          };
          if (writeScoreColumn) patch.candidate_score = hit.score;
          await db
            .from("discovery_candidates")
            .update(patch)
            .eq("blog_id", hit.blogId);
          summary.savedCandidates += 1;
          continue;
        }
        await upsertCandidateRow(
          db,
          hit,
          {
            status: "skipped",
            skipReason: reason,
          },
          scoreOpts,
        );
        summary.savedCandidates += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        summary.errors.push(`${hit.blogId}: ${message}`);
      }
    }
  }

  // Eligible already score-desc from scoredAll order (we pushed in that order).
  let jobsCreated = 0;
  for (const hit of eligible) {
    const key = blogKey(hit.blogId);

    if (hit.score < minScore) {
      summary.skippedLowScore += 1;
      if (!dryRun) {
        try {
          await upsertCandidateRow(
            db,
            hit,
            {
              status: "skipped",
              skipReason: `low_score:${hit.score}<${minScore}`,
            },
            scoreOpts,
          );
          summary.savedCandidates += 1;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          summary.errors.push(`${hit.blogId}: ${message}`);
        }
      }
      continue;
    }

    if (jobsCreated >= jobMax) {
      summary.skippedBelowRank += 1;
      if (!dryRun) {
        try {
          await upsertCandidateRow(
            db,
            hit,
            {
              status: "skipped",
              skipReason: `below_rank:jobMax=${jobMax}`,
            },
            scoreOpts,
          );
          summary.savedCandidates += 1;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          summary.errors.push(`${hit.blogId}: ${message}`);
        }
      }
      continue;
    }

    if (dryRun) {
      summary.savedCandidates += 1;
      summary.createdJobs += 1;
      jobsCreated += 1;
      console.info("[discovery] dry-run would create job", {
        blogId: hit.blogId,
        score: hit.score,
        rank: jobsCreated,
      });
      continue;
    }

    try {
      const candidateId = await upsertCandidateRow(
        db,
        hit,
        {
          status: "new",
        },
        scoreOpts,
      );
      summary.savedCandidates += 1;

      const { personId, workflowId } = await ensurePersonAndWorkflow(
        db,
        hit,
        hit.score,
      );
      const jobId = await createPlannedNeighborJob(
        db,
        hit,
        personId,
        workflowId,
      );

      const donePatch: Record<string, unknown> = {
        status: "job_created",
        action_job_id: jobId,
        person_id: personId,
        updated_at: new Date().toISOString(),
      };
      if (writeScoreColumn) donePatch.candidate_score = hit.score;
      await db
        .from("discovery_candidates")
        .update(donePatch)
        .eq("id", candidateId);

      jobBlogs.add(key);
      priorRows.set(key, { id: candidateId, status: "job_created" });
      summary.createdJobs += 1;
      summary.createdJobIds.push(jobId);
      jobsCreated += 1;
      console.info("[discovery] job_created", {
        jobId,
        blogId: hit.blogId,
        score: hit.score,
        rank: jobsCreated,
        personId,
        status: "planned",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      summary.errors.push(`${hit.blogId}: ${message}`);
      console.error(`[discovery] failed blogId=${hit.blogId}`, message);
    }
  }

  console.info("[discovery] done", {
    keyword: summary.keyword,
    searched: summary.searched,
    scored: summary.scored,
    savedCandidates: summary.savedCandidates,
    createdJobs: summary.createdJobs,
    skippedLowScore: summary.skippedLowScore,
    skippedBelowRank: summary.skippedBelowRank,
    skippedExistingJob: summary.skippedExistingJob,
    skippedNeighbor: summary.skippedNeighbor,
    skippedExcluded: summary.skippedExcluded,
    errors: summary.errors.length,
  });

  return summary;
}
