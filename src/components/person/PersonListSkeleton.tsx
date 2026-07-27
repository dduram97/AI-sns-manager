import { Skeleton } from "@/components/ui/skeleton";

export function PersonListSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-4 w-16" />
      <div className="space-y-2">
        <Skeleton className="h-11 w-full rounded-lg" />
        <div className="flex gap-2 overflow-hidden pb-1">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-16 shrink-0 rounded-full" />
          ))}
        </div>
        <div className="flex gap-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-24 rounded-md" />
          ))}
        </div>
      </div>
      <ul className="flex flex-col gap-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <li key={i}>
            <Skeleton className="h-[132px] w-full rounded-xl" />
          </li>
        ))}
      </ul>
    </div>
  );
}
