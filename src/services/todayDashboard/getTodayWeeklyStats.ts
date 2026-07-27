import "server-only";

import { cache } from "react";
import { runWithDbTrace } from "@/lib/dbTrace";
import { resolveWeeklyStatsProvider } from "@/services/todayDashboard/resolveWeeklyStatsProvider";
import type { TodayWeeklyStats } from "@/types/todayDashboard";

export const getTodayWeeklyStats = cache(
  async (): Promise<TodayWeeklyStats> => {
    const provider = resolveWeeklyStatsProvider();
    return runWithDbTrace("today", () => provider.getWeeklyStats());
  },
);
