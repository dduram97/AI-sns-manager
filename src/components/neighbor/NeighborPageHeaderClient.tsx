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
  dailyLimit,
  todayRemaining,
}: {
  todayExecuted: number;
  dailyLimit: number;
  todayRemaining: number;
}) {
  const { setQuotaHint } = useNeighborPage();

  useEffect(() => {
    setQuotaHint(
      `오늘 ${todayExecuted}/${dailyLimit}건 사용 · 남은 ${todayRemaining}건`,
    );
  }, [dailyLimit, setQuotaHint, todayExecuted, todayRemaining]);

  return null;
}
