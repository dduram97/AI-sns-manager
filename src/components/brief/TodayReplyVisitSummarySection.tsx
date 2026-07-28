"use client";

import { useEffect, useState } from "react";
import { getReplyVisitSummaryAction } from "@/app/actions/replyVisitTasks";
import { ReplyVisitSummaryCard } from "@/components/neighbor/ReplyVisitSummaryCard";
import type { ReplyVisitSummary } from "@/services/replyVisitTaskService";

/**
 * Today entry for reply-visit workflow — summary only (list lives on /neighbors/reply).
 * Reuses getReplyVisitSummary / reply_visit_tasks (same as 이웃관리).
 */
export function TodayReplyVisitSummarySection() {
  const [summary, setSummary] = useState<ReplyVisitSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void getReplyVisitSummaryAction()
      .then((data) => {
        if (!cancelled) setSummary(data);
      })
      .catch(() => {
        if (!cancelled) {
          setSummary({
            completed: 0,
            total: 0,
            pending: 0,
            lastAnalyzedAt: null,
          });
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <ReplyVisitSummaryCard summary={summary} loading={loading} />
  );
}
