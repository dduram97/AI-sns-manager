import { loadNeighborPageData } from "@/services/neighborService";
import { NeighborScreen } from "@/components/neighbor/NeighborScreen";
import { emptyNeighborCompletedPage } from "@/lib/neighborDefaults";

const INITIAL_CANDIDATE_LIMIT = 20;

export async function NeighborCandidatesContent() {
  const { settings, candidates } = await loadNeighborPageData({
    limit: INITIAL_CANDIDATE_LIMIT,
  });

  return (
    <NeighborScreen
      embedded
      lazyTabs
      initialSettings={settings}
      initialCandidates={candidates}
      initialExclusions={[]}
      initialCompleted={emptyNeighborCompletedPage()}
      candidatesHasMore
    />
  );
}
