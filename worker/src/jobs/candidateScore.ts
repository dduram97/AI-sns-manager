/**
 * Phase 3-2: score discovery candidates (0–100).
 *
 * Components:
 * - recency (last_active_at): up to 40
 * - post activity (post_url / title / snippet): up to 30
 * - keyword relevance (title / snippet / name): up to 30
 */

import type { DiscoveredBlogHit } from "../naver/naverBlogSearch";

export type CandidateScoreBreakdown = {
  total: number;
  recency: number;
  postActivity: number;
  keywordRelevance: number;
  ageDays: number | null;
};

export type ScoredCandidate = DiscoveredBlogHit & {
  score: number;
  scoreBreakdown: CandidateScoreBreakdown;
};

/** Default minimum score to create a neighbor_request job. */
export const DISCOVERY_DEFAULT_MIN_SCORE = Number(
  process.env.WORKER_DISCOVERY_MIN_SCORE ?? 55,
);

/** Max planned jobs created per discovery run (top-N after scoring). */
export const DISCOVERY_DEFAULT_JOB_MAX = Number(
  process.env.WORKER_DISCOVERY_JOB_MAX ?? 10,
);

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, (Date.now() - t) / 86_400_000);
}

function scoreRecency(lastActiveAt: string | null): {
  score: number;
  ageDays: number | null;
} {
  const ageDays = daysSince(lastActiveAt);
  if (ageDays == null) return { score: 0, ageDays: null };
  if (ageDays <= 3) return { score: 40, ageDays };
  if (ageDays <= 7) return { score: 32, ageDays };
  if (ageDays <= 14) return { score: 24, ageDays };
  if (ageDays <= 30) return { score: 16, ageDays };
  if (ageDays <= 90) return { score: 8, ageDays };
  return { score: 2, ageDays };
}

function scorePostActivity(hit: DiscoveredBlogHit): number {
  let score = 0;
  if (hit.postUrl) score += 15;
  if (hit.postTitle && hit.postTitle.trim().length >= 4) score += 8;
  if (hit.snippet && hit.snippet.trim().length >= 40) score += 7;
  return Math.min(30, score);
}

function scoreKeywordRelevance(hit: DiscoveredBlogHit): number {
  const keyword = hit.keyword.trim().toLowerCase();
  if (!keyword) return 0;

  const title = (hit.postTitle ?? "").toLowerCase();
  const snippet = (hit.snippet ?? "").toLowerCase();
  const name = (hit.blogName ?? "").toLowerCase();

  let score = 0;
  if (title.includes(keyword)) score += 15;
  if (snippet.includes(keyword)) score += 10;
  if (name.includes(keyword)) score += 5;

  // Soft partial: keyword chars appearing as consecutive substring already covered;
  // bonus if haystack is rich and keyword is short everyday term already matched above.
  if (score === 0) {
    // Token overlap for multi-word keywords
    const parts = keyword.split(/\s+/).filter((p) => p.length >= 2);
    let partHits = 0;
    for (const p of parts) {
      if (title.includes(p) || snippet.includes(p) || name.includes(p)) {
        partHits += 1;
      }
    }
    if (parts.length > 0) {
      score += Math.round((partHits / parts.length) * 12);
    }
  }

  return Math.min(30, score);
}

export function computeCandidateScore(
  hit: DiscoveredBlogHit,
): CandidateScoreBreakdown {
  const recency = scoreRecency(hit.lastActiveAt);
  const postActivity = scorePostActivity(hit);
  const keywordRelevance = scoreKeywordRelevance(hit);
  const total = Math.max(
    0,
    Math.min(100, recency.score + postActivity + keywordRelevance),
  );
  return {
    total,
    recency: recency.score,
    postActivity,
    keywordRelevance,
    ageDays: recency.ageDays,
  };
}

export function scoreCandidates(hits: DiscoveredBlogHit[]): ScoredCandidate[] {
  return hits.map((hit) => {
    const breakdown = computeCandidateScore(hit);
    return {
      ...hit,
      score: breakdown.total,
      scoreBreakdown: breakdown,
    };
  });
}

/** Sort highest score first; stable by blogId. */
export function sortScoredDescending(
  scored: ScoredCandidate[],
): ScoredCandidate[] {
  return [...scored].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.blogId.localeCompare(b.blogId);
  });
}
