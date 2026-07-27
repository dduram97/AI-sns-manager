import "server-only";

import { cache } from "react";
import { runWithDbTrace } from "@/lib/dbTrace";
import type { TodayTopNeighbor } from "@/types/todayDashboard";
import {
  blogNameFromPerson,
  blogUrlFromMeta,
  buildRecentPostTitleByPerson,
  formatRelativeDayKo,
  isMutualNeighbor,
  loadDashboardActionJobs30d,
  loadDashboardCrmRows,
  loadDashboardRecentPosts,
  recentPostTitleFromMeta,
  scoreInteractionJobs,
  temperatureToStars,
} from "@/services/todayDashboard/todayDashboardShared";

const TOP_LIMIT = 5;

async function loadTopNeighbors(): Promise<TodayTopNeighbor[]> {
  const [crmRows, jobs, recentPosts] = await Promise.all([
    loadDashboardCrmRows(),
    loadDashboardActionJobs30d(),
    loadDashboardRecentPosts(),
  ]);

  const recentPostByPerson = buildRecentPostTitleByPerson(recentPosts);
  const recentPostAtByPerson = new Map<string, string>();
  for (const post of recentPosts) {
    if (!recentPostAtByPerson.has(post.person_id)) {
      recentPostAtByPerson.set(post.person_id, post.occurred_at);
    }
  }
  const mutualNeighborIds = new Set<string>();
  const personById = new Map<string, (typeof crmRows)[number]>();

  for (const row of crmRows) {
    personById.set(row.person.id, row);
    const meta = row.person.discover_meta ?? {};
    if (isMutualNeighbor(meta)) {
      mutualNeighborIds.add(row.person.id);
    }
  }

  const scores = scoreInteractionJobs(jobs, mutualNeighborIds);
  const ranked = [...scores.entries()]
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_LIMIT);

  const results: TodayTopNeighbor[] = [];
  for (const [personId, interactionScore] of ranked) {
    const row = personById.get(personId);
    if (!row) continue;

    const meta = row.person.discover_meta ?? {};
    const blogUrl = blogUrlFromMeta(meta);
    if (!blogUrl) continue;

    const recentPostTitle =
      recentPostByPerson.get(personId) ??
      recentPostTitleFromMeta(meta) ??
      "최근 글 정보 없음";
    const recentPostAt = formatRelativeDayKo(
      recentPostAtByPerson.get(personId) ??
        (typeof meta.last_post_at === "string" ? meta.last_post_at : null),
    );

    results.push({
      id: personId,
      blogName: blogNameFromPerson(row.person),
      stars: temperatureToStars(row.relationship.temperature),
      lastVisit: formatRelativeDayKo(row.relationship.last_visit_at),
      lastComment: formatRelativeDayKo(row.relationship.last_comment_at),
      lastLike: formatRelativeDayKo(row.relationship.last_like_at),
      recentPostTitle,
      recentPostAt,
      interactionScore,
      blogUrl,
      isAccepted: isMutualNeighbor(meta),
    });
  }

  return results;
}

export const getTopNeighbors = cache(async (): Promise<TodayTopNeighbor[]> =>
  runWithDbTrace("today", loadTopNeighbors),
);
