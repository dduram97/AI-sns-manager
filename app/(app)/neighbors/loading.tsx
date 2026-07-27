import { NeighborPageProvider } from "@/components/neighbor/NeighborPageContext";
import { NeighborPageHeaderClient } from "@/components/neighbor/NeighborPageHeaderClient";
import { NeighborTabBar } from "@/components/neighbor/NeighborTabBar";
import { NeighborCandidatesSkeleton } from "@/components/neighbor/NeighborCandidatesSkeleton";

export default function NeighborsLoading() {
  return (
    <NeighborPageProvider>
      <div className="mx-auto flex w-full max-w-lg flex-col gap-4 px-4 pb-56 pt-6">
        <NeighborPageHeaderClient />
        <NeighborTabBar />
        <NeighborCandidatesSkeleton />
      </div>
    </NeighborPageProvider>
  );
}
