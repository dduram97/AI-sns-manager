/** Client-safe neighbor AI display helpers (no OpenAI / Playwright). */

export function neighborRecommendGrade(score: number): {
  emoji: string;
  label: string;
  tier: "hot" | "good" | "review" | "low";
} {
  if (score >= 90) return { emoji: "🔥", label: "적극 추천", tier: "hot" };
  if (score >= 70) return { emoji: "👍", label: "추천", tier: "good" };
  if (score >= 50) return { emoji: "👀", label: "검토 필요", tier: "review" };
  return { emoji: "", label: "", tier: "low" };
}

/** Slim mapper for server action payloads — duck-typed to avoid adapter imports. */
export function toNeighborAiRowInput(row: {
  candidate: {
    blogId: string;
    blogName: string;
    postTitle?: string | null;
    snippet?: string | null;
    lastPostAt?: string | null;
    dateText?: string | null;
    keywordRelevance?: number;
  };
  filter: Record<string, unknown> & {
    activityScore?: number;
    commentPotential?: number;
    primaryCategory?: string;
    reasons?: string[];
  };
}): {
  candidate: {
    blogId: string;
    blogName: string;
    postTitle: string | null;
    snippet: string;
    lastPostAt: string | null;
    dateText: string;
    keywordRelevance: number;
  };
  filter: Record<string, unknown>;
} {
  return {
    candidate: {
      blogId: row.candidate.blogId,
      blogName: row.candidate.blogName,
      postTitle: row.candidate.postTitle ?? null,
      snippet: (row.candidate.snippet ?? "").slice(0, 80),
      lastPostAt: row.candidate.lastPostAt ?? null,
      dateText: row.candidate.dateText ?? "",
      keywordRelevance: row.candidate.keywordRelevance ?? 0,
    },
    filter: row.filter,
  };
}
