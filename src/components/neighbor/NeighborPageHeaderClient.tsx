"use client";

import { useEffect } from "react";
import { NeighborPageHeader } from "@/components/neighbor/NeighborPageHeader";
import { useNeighborPage } from "@/components/neighbor/NeighborPageContext";

export function NeighborPageHeaderClient() {
  const { quotaHint } = useNeighborPage();
  return <NeighborPageHeader quotaHint={quotaHint} />;
}

/** Sync quota line once settings arrive from NeighborScreen. */
export function NeighborQuotaHintSync({
  todayExecuted,
  todayFailed = 0,
  todayExcluded = 0,
  dailyLimit,
  todayRemaining,
}: {
  todayExecuted: number;
  todayFailed?: number;
  todayExcluded?: number;
  dailyLimit: number;
  todayRemaining: number;
}) {
  const { setQuotaHint } = useNeighborPage();

  useEffect(() => {
    setQuotaHint(
      `오늘 신청 ${todayExecuted}/${dailyLimit} · 성공 ${todayExecuted}건 · 실패 ${todayFailed}건 · 제외 ${todayExcluded}건 · 남은 한도 ${todayRemaining}건`,
    );
  }, [
    dailyLimit,
    setQuotaHint,
    todayExecuted,
    todayExcluded,
    todayFailed,
    todayRemaining,
  ]);

  return null;
}
