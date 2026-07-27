/**
 * Existing-neighbor sync types — safe for client + server.
 */

export const EXISTING_NEIGHBOR_UPSERT_BATCH = 20;

export type ExistingNeighborDto = {
  blogId: string;
  blogName: string;
  blogUrl: string;
  relationKind: "mutual" | "neighbor" | "unknown";
};

export type ExistingNeighborFetchResult = {
  ok: boolean;
  message: string;
  ownBlogId: string | null;
  neighbors: ExistingNeighborDto[];
  fetchedAt: string;
  /** Debug / diagnosis for UI + terminal */
  diagnostics?: ExistingNeighborFetchDiagnostics;
};

export type ExistingNeighborFetchDiagnostics = {
  ownBlogIdSource: string;
  loginOk: boolean;
  blogResolved: boolean;
  pageAccessOk: boolean;
  extractOk: boolean;
  emptyNeighbors: boolean;
  pageAccessSummary: string[];
  /** User-facing checklist lines, e.g. "✅ 블로그 확인 완료" */
  checklist: string[];
  reasons: string[];
  candidateElements: number;
  sampleHrefs: string[];
  pagesTried: number;
};

export type ExistingNeighborUpsertBatchResult = {
  processed: number;
  added: number;
  updated: number;
  skipped: number;
  errors: string[];
  lastName: string | null;
};

export type ExistingNeighborSyncSummary = {
  ok: boolean;
  message: string;
  ownBlogId: string | null;
  total: number;
  added: number;
  updated: number;
  skipped: number;
  lastSyncAt: string;
  errors: string[];
};
