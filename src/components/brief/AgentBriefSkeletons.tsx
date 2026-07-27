import { Skeleton } from "@/components/ui/skeleton";

export function AgentBriefStatusSkeleton() {
  return (
    <section className="rounded-xl border border-border/70 bg-card p-4">
      <Skeleton className="h-3 w-24" />
      <div className="mt-3 flex items-center gap-2">
        <Skeleton className="h-2.5 w-2.5 rounded-full" />
        <Skeleton className="h-6 w-28" />
      </div>
      <div className="mt-4 space-y-2">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
      </div>
    </section>
  );
}

export function AgentBriefKpiSkeleton() {
  return (
    <section>
      <Skeleton className="mb-2 h-3 w-16" />
      <div className="grid grid-cols-3 gap-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-[72px] rounded-lg" />
        ))}
      </div>
    </section>
  );
}

export function AgentBriefActivitySkeleton() {
  return (
    <section className="rounded-xl border border-border/70 bg-card p-4">
      <Skeleton className="h-3 w-32" />
      <div className="mt-3 space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-4 w-full" />
        ))}
      </div>
    </section>
  );
}

export function AgentBriefApprovalSkeleton() {
  return (
    <section className="rounded-xl border border-border/70 bg-card p-4">
      <Skeleton className="h-3 w-28" />
      <Skeleton className="mt-3 h-9 w-20" />
      <Skeleton className="mt-3 h-4 w-full" />
      <Skeleton className="mt-4 h-12 w-full rounded-md" />
    </section>
  );
}

export function AgentBriefRelationshipSkeleton() {
  return (
    <section>
      <Skeleton className="mb-2 h-3 w-36" />
      <div className="grid grid-cols-2 gap-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[68px] rounded-lg" />
        ))}
      </div>
    </section>
  );
}
