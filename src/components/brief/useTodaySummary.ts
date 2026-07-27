"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { usePathname } from "next/navigation";
import { useEffect } from "react";

import { getTodaySummaryAction } from "@/app/actions/todaySummary";
import { queryKeys } from "@/lib/queryKeys";
import type { TodaySummaryViewModel } from "@/types/todaySummary";

export const todaySummaryQueryKey = ["todaySummary"] as const;

export const TODAY_SUMMARY_REFRESH_EVENT = "today-summary:refresh";

function isTodayRoute(pathname: string): boolean {
  return pathname === "/today" || pathname.startsWith("/today/");
}

export function useTodaySummary() {
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const onTodayRoute = isTodayRoute(pathname);

  const query = useQuery({
    queryKey: todaySummaryQueryKey,
    queryFn: getTodaySummaryAction,
    staleTime: 0,
    gcTime: 5 * 60_000,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchInterval: onTodayRoute ? 2_000 : false,
    placeholderData: (previous) => previous,
  });

  const { refetch } = query;

  useEffect(() => {
    if (!onTodayRoute) return;
    void refetch();
  }, [onTodayRoute, pathname, refetch]);

  useEffect(() => {
    const invalidate = () => {
      void queryClient.invalidateQueries({ queryKey: todaySummaryQueryKey });
    };

    window.addEventListener(TODAY_SUMMARY_REFRESH_EVENT, invalidate);
    document.addEventListener("visibilitychange", invalidate);

    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated") return;
      if (event.query.queryKey[0] !== queryKeys.agentBrief[0]) return;
      invalidate();
    });

    return () => {
      window.removeEventListener(TODAY_SUMMARY_REFRESH_EVENT, invalidate);
      document.removeEventListener("visibilitychange", invalidate);
      unsubscribe();
    };
  }, [queryClient]);

  return query;
}

export type { TodaySummaryViewModel };
