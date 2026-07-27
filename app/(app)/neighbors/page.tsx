import { Suspense } from "react";
import { NeighborPageProvider } from "@/components/neighbor/NeighborPageContext";
import { NeighborPageHeaderClient } from "@/components/neighbor/NeighborPageHeaderClient";
import { NeighborTabBar } from "@/components/neighbor/NeighborTabBar";
import { NeighborCandidatesContent } from "@/components/neighbor/NeighborCandidatesContent";
import { NeighborCandidatesSkeleton } from "@/components/neighbor/NeighborCandidatesSkeleton";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function NeighborsPageBody() {
  return (
    <NeighborPageProvider>
      <div className="mx-auto flex w-full max-w-lg flex-col gap-4 px-4 pb-56 pt-6">
        <NeighborPageHeaderClient />
        <NeighborTabBar />
        <Suspense fallback={<NeighborCandidatesSkeleton />}>
          <NeighborCandidatesContent />
        </Suspense>
      </div>
    </NeighborPageProvider>
  );
}

export default function NeighborsPage() {
  return (
    <Suspense fallback={<NeighborCandidatesSkeleton />}>
      <NeighborsPageBody />
    </Suspense>
  );
}
