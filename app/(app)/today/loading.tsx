import { AgentBriefShell } from "@/components/brief/AgentBriefShell";
import { Skeleton } from "@/components/ui/skeleton";

export default function TodayLoading() {
  return (
    <AgentBriefShell>
      <Skeleton className="h-48 rounded-xl" />
      <div className="space-y-4">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-36 rounded-xl" />
        <Skeleton className="h-5 w-28" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-5 w-28" />
        <Skeleton className="h-40 rounded-xl" />
      </div>
      <Skeleton className="mt-2 h-10 w-full rounded-lg" />
    </AgentBriefShell>
  );
}
