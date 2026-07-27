import "server-only";

import type { TodayWeeklyStats } from "@/types/todayDashboard";
import type { WeeklyStatsProvider } from "@/services/todayDashboard/WeeklyStatsProvider";

const EMPTY_WEEKLY_STATS: TodayWeeklyStats = {
  visitors: 0,
  likes: 0,
  comments: 0,
  newNeighbors: 0,
};

/**
 * 내 블로그 상태(방문자·받은 공감·받은 댓글·새 서로이웃)용 Provider.
 * 네이버 대시보드/통계 수집 로직은 추후 이 파일에 연결합니다.
 */
async function loadNaverWeeklyStats(): Promise<TodayWeeklyStats> {
  // TODO: Naver blog dashboard metrics (inbound visitors, received likes/comments, new mutual neighbors)
  return EMPTY_WEEKLY_STATS;
}

export const naverDashboardProvider: WeeklyStatsProvider = {
  id: "naver",
  getWeeklyStats: loadNaverWeeklyStats,
};
