/**
 * Neighbor collect pipeline funnel metrics (search → filter → AI → save).
 */

export type NeighborRejectReasonCounts = {
  duplicate_blog_id: number;
  excluded: number;
  already_requested: number;
  already_analyzed: number;
  inactive: number;
  ad_heavy: number;
  corporate: number;
  topic_mismatch: number;
  /** Passed code filter but filterMax already filled */
  filter_cap_skipped: number;
  ai_rejected: number;
  ai_failed: number;
  /** Existing person updated instead of new add */
  updated_existing: number;
  /** Hit daily save quota */
  save_quota_skipped: number;
  verify_skipped: number;
  persist_error: number;
};

export type NeighborPipelineFunnel = {
  searchSource: "api" | "cdp_fallback" | "none";
  keywords: string[];
  /** Raw search items before blog_id dedupe (API item rows / CDP rows) */
  apiRawCount: number;
  /** Unique blog_id after dedupe */
  afterDedupe: number;
  duplicatesRemoved: number;
  /** Code filter + exclusion pipeline */
  filterInput: number;
  filterPassed: number;
  aiTarget: number;
  aiReused: number;
  aiAnalyzed: number;
  aiRejected: number;
  /** OpenAI HTTP request counts for this collect run */
  aiOpenaiRequests: number;
  aiOpenaiSuccess: number;
  aiOpenaiFail: number;
  /** Final persist */
  finalAdded: number;
  finalUpdated: number;
  rejects: NeighborRejectReasonCounts;
};

export function emptyRejectCounts(): NeighborRejectReasonCounts {
  return {
    duplicate_blog_id: 0,
    excluded: 0,
    already_requested: 0,
    already_analyzed: 0,
    inactive: 0,
    ad_heavy: 0,
    corporate: 0,
    topic_mismatch: 0,
    filter_cap_skipped: 0,
    ai_rejected: 0,
    ai_failed: 0,
    updated_existing: 0,
    save_quota_skipped: 0,
    verify_skipped: 0,
    persist_error: 0,
  };
}

export function emptyPipelineFunnel(
  partial?: Partial<Omit<NeighborPipelineFunnel, "rejects">> & {
    rejects?: Partial<NeighborRejectReasonCounts>;
  },
): NeighborPipelineFunnel {
  return {
    searchSource: partial?.searchSource ?? "none",
    keywords: partial?.keywords ?? [],
    apiRawCount: partial?.apiRawCount ?? 0,
    afterDedupe: partial?.afterDedupe ?? 0,
    duplicatesRemoved: partial?.duplicatesRemoved ?? 0,
    filterInput: partial?.filterInput ?? 0,
    filterPassed: partial?.filterPassed ?? 0,
    aiTarget: partial?.aiTarget ?? 0,
    aiReused: partial?.aiReused ?? 0,
    aiAnalyzed: partial?.aiAnalyzed ?? 0,
    aiRejected: partial?.aiRejected ?? 0,
    aiOpenaiRequests: partial?.aiOpenaiRequests ?? 0,
    aiOpenaiSuccess: partial?.aiOpenaiSuccess ?? 0,
    aiOpenaiFail: partial?.aiOpenaiFail ?? 0,
    finalAdded: partial?.finalAdded ?? 0,
    finalUpdated: partial?.finalUpdated ?? 0,
    rejects: {
      ...emptyRejectCounts(),
      ...(partial?.rejects ?? {}),
    },
  };
}

export function logNeighborPipelineFunnel(funnel: NeighborPipelineFunnel): void {
  console.log(
    "[neighborCollect:funnel]",
    JSON.stringify(
      {
        source: funnel.searchSource,
        keywords: funnel.keywords,
        stages: {
          api_raw: funnel.apiRawCount,
          after_dedupe: funnel.afterDedupe,
          duplicates_removed: funnel.duplicatesRemoved,
          filter_input: funnel.filterInput,
          filter_passed: funnel.filterPassed,
          ai_target: funnel.aiTarget,
          ai_reused: funnel.aiReused,
          ai_analyzed: funnel.aiAnalyzed,
          ai_rejected: funnel.aiRejected,
          openai_requests: funnel.aiOpenaiRequests,
          openai_success: funnel.aiOpenaiSuccess,
          openai_fail: funnel.aiOpenaiFail,
          final_added: funnel.finalAdded,
          final_updated: funnel.finalUpdated,
        },
        rejects: funnel.rejects,
      },
      null,
      2,
    ),
  );
}
