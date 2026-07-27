import "server-only";

import { currentWeeklyStatsProvider } from "@/services/todayDashboard/currentWeeklyStatsProvider";
import { naverDashboardProvider } from "@/services/todayDashboard/naverDashboardProvider";
import type {
  WeeklyStatsProvider,
  WeeklyStatsProviderId,
} from "@/services/todayDashboard/WeeklyStatsProvider";

const PROVIDERS: Record<WeeklyStatsProviderId, WeeklyStatsProvider> = {
  current: currentWeeklyStatsProvider,
  naver: naverDashboardProvider,
};

function parseProviderId(raw: string | undefined): WeeklyStatsProviderId {
  const id = raw?.trim().toLowerCase();
  if (id === "naver") return "naver";
  return "current";
}

/** Default: current (action_jobs / outcome_daily). Set TODAY_WEEKLY_STATS_PROVIDER=naver to switch. */
export function resolveWeeklyStatsProvider(
  override?: WeeklyStatsProviderId,
): WeeklyStatsProvider {
  const id =
    override ?? parseProviderId(process.env.TODAY_WEEKLY_STATS_PROVIDER);
  return PROVIDERS[id];
}
