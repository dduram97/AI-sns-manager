import "server-only";

import { cache } from "react";
import { runWithDbTrace } from "@/lib/dbTrace";
import { parseNeighborRelationStatus } from "@/domain/neighbor/relationStatus";
import type { TodayRecommendedNeighbor } from "@/types/todayDashboard";
import {
  blogNameFromPerson,
  blogUrlFromMeta,
  daysSince,
  formatRelativeDayKo,
  loadDashboardCrmRows,
  recentPostTitleFromMeta,
  temperatureToStars,
} from "@/services/todayDashboard/todayDashboardShared";

const TOP_LIMIT = 5;
const MIN_SCORE = 20;

type ScoredCandidate = {
  personId: string;
  score: number;
  reasons: string[];
  blogName: string;
  stars: number;
  blogUrl: string;
};

function scoreRecommendedCandidate(input: {
  meta: Record<string, unknown>;
  relationship: {
    stage: string;
    temperature: number;
    last_visit_at: string | null;
    last_comment_at: string | null;
    last_like_at: string | null;
  };
  personId: string;
  blogName: string;
  blogUrl: string;
}): ScoredCandidate | null {
  const { meta, relationship, personId, blogName, blogUrl } = input;

  if (meta.neighbor_excluded === true) return null;
  if (meta.verify === true) return null;
  if (relationship.stage === "risk") return null;

  const relation = parseNeighborRelationStatus(meta);
  if (relation === "accepted") return null;

  let score = 0;
  const reasons: string[] = [];

  const daysSinceVisit = daysSince(relationship.last_visit_at);
  if (daysSinceVisit === null || daysSinceVisit >= 5) {
    score += 25;
    reasons.push(
      daysSinceVisit === null
        ? "아직 방문 기록 없음"
        : `최근 ${daysSinceVisit}일 방문 안 함`,
    );
  }

  const lastPostAt =
    (typeof meta.last_post_at === "string" && meta.last_post_at) || null;
  const daysSincePost = daysSince(lastPostAt);
  if (daysSincePost !== null && daysSincePost <= 7) {
    score += 30;
    reasons.push(
      daysSincePost === 0
        ? "오늘 새 글 등록"
        : `최근 새 글 ${daysSincePost}일 전 등록`,
    );
  }

  const daysSinceComment = daysSince(relationship.last_comment_at);
  if (
    relationship.last_comment_at &&
    (daysSinceComment === null || daysSinceComment >= 14)
  ) {
    score += 20;
    reasons.push("예전에는 댓글 자주 작성");
  }

  const daysSinceLike = daysSince(relationship.last_like_at);
  if (
    relationship.last_like_at &&
    daysSinceLike !== null &&
    daysSinceLike <= 14 &&
    (daysSinceComment === null || daysSinceComment >= 7)
  ) {
    score += 15;
    reasons.push("공감은 꾸준히 주고 있음");
  }

  if (
    daysSincePost !== null &&
    daysSincePost <= 7 &&
    !relationship.last_comment_at
  ) {
    score += 20;
    reasons.push("새 글 · 댓글 없음");
  }

  if (relationship.temperature >= 50 && reasons.length === 0) {
    score += 10;
    reasons.push("관계 온도가 높음");
  }

  if (score < MIN_SCORE) return null;

  return {
    personId,
    score,
    reasons: reasons.slice(0, 3),
    blogName,
    stars: temperatureToStars(relationship.temperature),
    blogUrl,
  };
}

async function loadRecommendedNeighbors(): Promise<TodayRecommendedNeighbor[]> {
  const crmRows = await loadDashboardCrmRows();

  const candidates: ScoredCandidate[] = [];
  for (const row of crmRows) {
    const meta = row.person.discover_meta ?? {};
    const blogUrl = blogUrlFromMeta(meta);
    if (!blogUrl) continue;

    const scored = scoreRecommendedCandidate({
      meta,
      relationship: row.relationship,
      personId: row.person.id,
      blogName: blogNameFromPerson(row.person),
      blogUrl,
    });
    if (scored) candidates.push(scored);
  }

  candidates.sort((a, b) => b.score - a.score);

  const rowByPersonId = new Map(crmRows.map((row) => [row.person.id, row]));

  return candidates.slice(0, TOP_LIMIT).map((item) => {
    const row = rowByPersonId.get(item.personId);
    const meta = row?.person.discover_meta ?? {};
    const blogId =
      (typeof meta.blog_id === "string" && meta.blog_id.trim()) ||
      (typeof meta.blogId === "string" && meta.blogId.trim()) ||
      "";

    return {
      id: item.personId,
      blogName: item.blogName,
      stars: item.stars,
      reasons: item.reasons,
      recentPostTitle: recentPostTitleFromMeta(meta) ?? "최근 글 정보 없음",
      recentPostAt: formatRelativeDayKo(
        typeof meta.last_post_at === "string" ? meta.last_post_at : null,
      ),
      lastVisit: formatRelativeDayKo(row?.relationship.last_visit_at ?? null),
      lastComment: formatRelativeDayKo(row?.relationship.last_comment_at ?? null),
      recommendScore: item.score,
      blogId,
      blogUrl: item.blogUrl,
    };
  });
}

export const getRecommendedNeighbors = cache(
  async (): Promise<TodayRecommendedNeighbor[]> =>
    runWithDbTrace("today", loadRecommendedNeighbors),
);
