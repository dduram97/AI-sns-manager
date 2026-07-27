import type { TodayWeeklyStats } from "@/types/todayDashboard";

export type WeeklyStatsProviderId = "current" | "naver";

/** Supplies "이번 주 블로그 현황" metrics for Today Dashboard. */
export interface WeeklyStatsProvider {
  readonly id: WeeklyStatsProviderId;
  getWeeklyStats(): Promise<TodayWeeklyStats>;
}
