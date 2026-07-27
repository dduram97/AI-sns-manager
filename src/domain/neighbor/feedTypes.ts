/**
 * Neighbor feed shared types/constants — safe for client + server.
 */

export const RSS_CONCURRENCY = 12;
/** Max CDP fallbacks per collect run (slow path). */
export const CDP_FALLBACK_MAX = 8;
export const FEED_SCAN_BATCH_SIZE = 24;
/** Candidates per Approval-register server action */
export const FEED_REGISTER_BATCH_SIZE = 16;
/** Parallel enqueueApproval workers inside one register batch */
export const FEED_REGISTER_CONCURRENCY = 8;

export type NeighborFeedPoolMember = {
  personId: string;
  blogId: string;
  blogName: string;
  blogUrl: string | null;
  acceptedAt: string | null;
  activityScore: number;
};

export type NeighborFeedExcludeCounts = {
  too_old: number;
  already_handled: number;
  duplicate_blog: number;
  per_neighbor_cap: number;
  daily_cap: number;
  scrape_empty: number;
  scrape_error: number;
  create_failed: number;
};

export type NeighborFeedSourceStats = {
  rss: number;
  cdp: number;
  fail: number;
};

export type NeighborFeedCollectResult = {
  ok: boolean;
  message: string;
  lastCollectAt: string;
  poolSize: number;
  postsSeen: number;
  recentFound: number;
  excluded: NeighborFeedExcludeCounts;
  finalCount: number;
  approvalsCreated: number;
  duplicateExcluded: number;
  createFailed: number;
  sourceStats: NeighborFeedSourceStats;
};

export type NeighborFeedPrepareResult = {
  toCreate: NeighborFeedCandidateDto[];
  excluded: NeighborFeedExcludeCounts;
  recentFound: number;
  poolSize: number;
  postsSeen: number;
  sourceStats: NeighborFeedSourceStats;
  /** already_handled + duplicate_blog counted during prepare */
  duplicateExcluded: number;
};

export type NeighborFeedRegisterBatchResult = {
  processed: number;
  created: number;
  failed: number;
  skippedDuplicate: number;
  lastBlogName: string | null;
  lastTitle: string | null;
};

/** Serializable candidate for batch scan → finalize */
export type NeighborFeedCandidateDto = {
  personId: string;
  blogId: string;
  blogName: string;
  acceptedAt: string | null;
  activityScore: number;
  post: {
    blogId: string;
    logNo: string;
    postUrl: string;
    title: string;
    contentRaw: string;
    contentSummary: string;
    publishedAt: string | null;
  };
  postKey: string;
  publishedAt: string;
};

export type NeighborFeedScanBatchResult = {
  checked: number;
  postsSeen: number;
  recentFound: number;
  excluded: NeighborFeedExcludeCounts;
  sourceStats: NeighborFeedSourceStats;
  candidates: NeighborFeedCandidateDto[];
};

export function emptyExcludes(): NeighborFeedExcludeCounts {
  return {
    too_old: 0,
    already_handled: 0,
    duplicate_blog: 0,
    per_neighbor_cap: 0,
    daily_cap: 0,
    scrape_empty: 0,
    scrape_error: 0,
    create_failed: 0,
  };
}

export function mergeExcludes(
  a: NeighborFeedExcludeCounts,
  b: NeighborFeedExcludeCounts,
): NeighborFeedExcludeCounts {
  return {
    too_old: a.too_old + b.too_old,
    already_handled: a.already_handled + b.already_handled,
    duplicate_blog: a.duplicate_blog + b.duplicate_blog,
    per_neighbor_cap: a.per_neighbor_cap + b.per_neighbor_cap,
    daily_cap: a.daily_cap + b.daily_cap,
    scrape_empty: a.scrape_empty + b.scrape_empty,
    scrape_error: a.scrape_error + b.scrape_error,
    create_failed: a.create_failed + b.create_failed,
  };
}

export function sumExcludes(e: NeighborFeedExcludeCounts): number {
  return (
    e.too_old +
    e.already_handled +
    e.duplicate_blog +
    e.per_neighbor_cap +
    e.daily_cap +
    e.scrape_empty +
    e.scrape_error +
    e.create_failed
  );
}
