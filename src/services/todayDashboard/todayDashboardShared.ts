import "server-only";

import { cache } from "react";
import { resolveCompletedRange } from "@/lib/completedRange";
import { rowCountFrom, traceQuery } from "@/lib/dbTrace";
import { createServiceClient } from "@/lib/supabase";
import { createSupervisorRepos } from "@/repositories/index";
import { parseNeighborRelationStatus } from "@/domain/neighbor/relationStatus";
import type { Person, RelationshipState } from "@/workers/types";

export const INTERACTION_SCORE = {
  comment: 5,
  like: 2,
  visit: 1,
  mutualNeighbor: 10,
} as const;

export type DashboardCrmRow = {
  person: Person;
  relationship: RelationshipState;
};

export type DashboardActionJobRow = {
  person_id: string;
  action_type: string;
  executed_at: string | null;
};

export type DashboardRecentPost = {
  person_id: string;
  title: string;
  occurred_at: string;
};

export function daysSince(iso: string | null | undefined, now = Date.now()): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((now - t) / 86_400_000);
}

export function formatRelativeDayKo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const days = daysSince(iso);
  if (days === null) return "—";
  if (days === 0) return "오늘";
  if (days === 1) return "1일 전";
  if (days < 7) return `${days}일 전`;
  return new Date(iso).toLocaleDateString("ko-KR", {
    month: "short",
    day: "numeric",
  });
}

export function temperatureToStars(temperature: number): number {
  if (temperature <= 0) return 1;
  return Math.max(1, Math.min(5, Math.round(temperature / 20)));
}

export function blogUrlFromMeta(meta: Record<string, unknown>): string | null {
  const blogUrl = meta.blog_url;
  if (typeof blogUrl === "string" && blogUrl.trim()) return blogUrl.trim();
  const blogId =
    (typeof meta.blog_id === "string" && meta.blog_id.trim()) ||
    (typeof meta.blogId === "string" && meta.blogId.trim()) ||
    null;
  if (blogId) return `https://m.blog.naver.com/${blogId}`;
  return null;
}

export function blogNameFromPerson(person: Person): string {
  const meta = person.discover_meta ?? {};
  const nickname = meta.nickname;
  if (typeof nickname === "string" && nickname.trim()) return nickname.trim();
  return person.display_name;
}

export function isMutualNeighbor(meta: Record<string, unknown>): boolean {
  return parseNeighborRelationStatus(meta) === "accepted";
}

export function recentPostTitleFromMeta(meta: Record<string, unknown>): string | null {
  const title =
    meta.last_post_title ??
    meta.recent_post_title ??
    meta.latest_post_title;
  return typeof title === "string" && title.trim() ? title.trim() : null;
}

export const loadDashboardCrmRows = cache(async (): Promise<DashboardCrmRow[]> => {
  const repos = createSupervisorRepos(createServiceClient());
  const rows = await repos.person.listCrmRows();
  return rows.map(({ person, relationship }) => ({ person, relationship }));
});

export const loadDashboardActionJobs30d = cache(
  async (): Promise<DashboardActionJobRow[]> => {
    const db = createServiceClient();
    const range = resolveCompletedRange({ preset: "30d" });
    const { data, error } = await traceQuery(
      "action_jobs.dashboard_30d",
      () =>
        db
          .from("action_jobs")
          .select("person_id, action_type, executed_at")
          .eq("status", "executed")
          .gte("executed_at", range.fromIso)
          .lte("executed_at", range.toIso),
      (r) => rowCountFrom(r.data),
    );
    if (error) {
      throw new Error(`loadDashboardActionJobs30d: ${error.message}`);
    }
    return (data ?? []) as DashboardActionJobRow[];
  },
);

export const loadDashboardRecentPosts = cache(
  async (): Promise<DashboardRecentPost[]> => {
    const db = createServiceClient();
    const range = resolveCompletedRange({ preset: "30d" });
    const { data, error } = await traceQuery(
      "perception_events.dashboard_recent_posts",
      () =>
        db
          .from("perception_events")
          .select("person_id, payload, occurred_at")
          .eq("event_type", "new_post")
          .not("person_id", "is", null)
          .gte("occurred_at", range.fromIso)
          .order("occurred_at", { ascending: false })
          .limit(500),
      (r) => rowCountFrom(r.data),
    );
    if (error) {
      throw new Error(`loadDashboardRecentPosts: ${error.message}`);
    }

    const out: DashboardRecentPost[] = [];
    for (const row of data ?? []) {
      const rec = row as {
        person_id?: string;
        payload?: Record<string, unknown>;
        occurred_at?: string;
      };
      const personId = rec.person_id ? String(rec.person_id) : "";
      if (!personId) continue;
      const payload = rec.payload ?? {};
      const title =
        (typeof payload.title === "string" && payload.title.trim()) ||
        (typeof payload.post_title === "string" && payload.post_title.trim()) ||
        "";
      if (!title || !rec.occurred_at) continue;
      out.push({
        person_id: personId,
        title,
        occurred_at: rec.occurred_at,
      });
    }
    return out;
  },
);

export function buildRecentPostTitleByPerson(
  posts: DashboardRecentPost[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const post of posts) {
    if (!map.has(post.person_id)) {
      map.set(post.person_id, post.title);
    }
  }
  return map;
}

export function scoreInteractionJobs(
  jobs: DashboardActionJobRow[],
  mutualNeighborPersonIds: Set<string>,
): Map<string, number> {
  const scores = new Map<string, number>();
  const mutualBonus = new Set<string>();

  for (const job of jobs) {
    const personId = String(job.person_id ?? "");
    if (!personId) continue;

    let delta = 0;
    switch (job.action_type) {
      case "comment":
        delta = INTERACTION_SCORE.comment;
        break;
      case "like":
        delta = INTERACTION_SCORE.like;
        break;
      case "visit":
        delta = INTERACTION_SCORE.visit;
        break;
      default:
        break;
    }
    if (delta > 0) {
      scores.set(personId, (scores.get(personId) ?? 0) + delta);
    }
  }

  for (const personId of mutualNeighborPersonIds) {
    if (mutualBonus.has(personId)) continue;
    mutualBonus.add(personId);
    scores.set(
      personId,
      (scores.get(personId) ?? 0) + INTERACTION_SCORE.mutualNeighbor,
    );
  }

  return scores;
}
