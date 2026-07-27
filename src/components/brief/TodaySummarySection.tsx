"use client";

import { TodaySummaryCard } from "@/components/brief/TodaySummaryCard";
import { useTodaySummary } from "@/components/brief/useTodaySummary";
import { Skeleton } from "@/components/ui/skeleton";

function TodaySummarySkeleton() {
  return (
    <section className="rounded-xl border border-border/70 bg-card p-4">
      <Skeleton className="h-5 w-36" />
      <div className="mt-4 space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="rounded-xl border border-border/70 bg-card p-4"
          >
            <Skeleton className="h-4 w-28" />
            <Skeleton className="mt-3 h-9 w-16" />
            <Skeleton className="mt-2 h-3 w-24" />
            <div className="mt-4 border-t border-border/60 pt-3">
              <Skeleton className="h-3 w-10" />
              <Skeleton className="mt-2 h-2 w-full rounded-full" />
              <Skeleton className="mt-2 h-3 w-20" />
            </div>
            <div className="mt-3 flex justify-end">
              <Skeleton className="h-8 w-20 rounded-md" />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function TodaySummarySection() {
  const { data, isLoading } = useTodaySummary();

  if (!data && isLoading) {
    return <TodaySummarySkeleton />;
  }

  if (!data) {
    return null;
  }

  return <TodaySummaryCard data={data} />;
}
