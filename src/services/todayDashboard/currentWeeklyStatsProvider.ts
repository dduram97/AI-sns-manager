import "server-only";

import { resolveWeekRange } from "@/lib/completedRange";
import { rowCountFrom, traceQuery } from "@/lib/dbTrace";
import { createServiceClient } from "@/lib/supabase";
import { num } from "@/repositories/shared";
import type { TodayWeeklyStats } from "@/types/todayDashboard";
import type { WeeklyStatsProvider } from "@/services/todayDashboard/WeeklyStatsProvider";

/**
 * Agent 실행 활동(action_jobs / outcome_daily / persons) 기반 집계.
 * 내 블로그 inbound 지표가 아닌, 현재 DB에 저장된 outbound·관계 데이터를 사용합니다.
 */
async function loadCurrentWeeklyStats(): Promise<TodayWeeklyStats> {
  const db = createServiceClient();
  const { fromIso, toIso, fromDate, toDate } = resolveWeekRange();

  const [outcomeRes, visitsRes, commentsRes, neighborsRes] = await Promise.all([
    traceQuery(
      "outcome_daily.week",
      () =>
        db
          .from("outcome_daily")
          .select("auto_visit_count, auto_like_count")
          .gte("date", fromDate)
          .lte("date", toDate),
      (r) => rowCountFrom(r.data),
    ),
    traceQuery(
      "action_jobs.week_visits",
      () =>
        db
          .from("action_jobs")
          .select("person_id")
          .eq("action_type", "visit")
          .eq("status", "executed")
          .gte("executed_at", fromIso)
          .lte("executed_at", toIso),
      (r) => rowCountFrom(r.data),
    ),
    traceQuery(
      "action_jobs.week_comments",
      () =>
        db
          .from("action_jobs")
          .select("id", { count: "exact", head: true })
          .eq("action_type", "comment")
          .eq("status", "executed")
          .gte("executed_at", fromIso)
          .lte("executed_at", toIso),
      (r) => rowCountFrom(null, r.count),
    ),
    traceQuery(
      "persons.week_neighbors",
      () =>
        db
          .from("persons")
          .select("id", { count: "exact", head: true })
          .filter("discover_meta->>neighbor_relation_status", "eq", "accepted")
          .gte("discover_meta->>neighbor_accepted_at", fromIso)
          .lte("discover_meta->>neighbor_accepted_at", toIso),
      (r) => rowCountFrom(null, r.count),
    ),
  ]);

  if (outcomeRes.error) {
    throw new Error(
      `currentWeeklyStatsProvider outcome_daily: ${outcomeRes.error.message}`,
    );
  }
  if (visitsRes.error) {
    throw new Error(
      `currentWeeklyStatsProvider week_visits: ${visitsRes.error.message}`,
    );
  }
  if (commentsRes.error) {
    throw new Error(
      `currentWeeklyStatsProvider week_comments: ${commentsRes.error.message}`,
    );
  }
  if (neighborsRes.error) {
    throw new Error(
      `currentWeeklyStatsProvider week_neighbors: ${neighborsRes.error.message}`,
    );
  }

  const visitPersonIds = new Set<string>();
  for (const row of visitsRes.data ?? []) {
    const personId = String((row as { person_id?: string }).person_id ?? "");
    if (personId) visitPersonIds.add(personId);
  }

  let likes = 0;
  let visitFallback = 0;
  for (const row of outcomeRes.data ?? []) {
    const rec = row as {
      auto_visit_count?: unknown;
      auto_like_count?: unknown;
    };
    visitFallback += num(rec.auto_visit_count);
    likes += num(rec.auto_like_count);
  }

  return {
    visitors: visitPersonIds.size > 0 ? visitPersonIds.size : visitFallback,
    likes,
    comments: commentsRes.count ?? 0,
    newNeighbors: neighborsRes.count ?? 0,
  };
}

export const currentWeeklyStatsProvider: WeeklyStatsProvider = {
  id: "current",
  getWeeklyStats: loadCurrentWeeklyStats,
};
