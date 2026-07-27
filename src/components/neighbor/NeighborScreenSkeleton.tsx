import { Skeleton } from "@/components/ui/skeleton";

export function NeighborScreenSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-4 px-4 pb-56 pt-6">
      <header className="space-y-2">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-56" />
      </header>
      <div className="flex flex-wrap gap-1 rounded-xl border border-border/70 bg-secondary/40 p-1">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-9 flex-1 rounded-lg" />
        ))}
      </div>
      <Skeleton className="h-24 w-full rounded-xl" />
      <Skeleton className="h-11 w-full rounded-md" />
      <div className="flex flex-col gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-36 w-full rounded-xl" />
        ))}
      </div>
    </div>
  );
}
