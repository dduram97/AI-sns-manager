"use server";

import { revalidatePath } from "next/cache";
import {
  allowNeighborBlogAgain,
  analyzeAndSaveNeighborCandidates,
  analyzeNeighborAiBatch,
  checkNeighborDuplicates,
  collectNeighborCandidates,
  createNeighborRequestApproval,
  excludeNeighborBlog,
  filterNeighborCandidateHits,
  finalizeNeighborCollectWithJudgments,
  getNeighborSettings,
  listNeighborCandidates,
  listNeighborCompleted,
  listNeighborExclusions,
  markNeighborRequested,
  markNeighborRequestFailed,
  checkPendingNeighborStatuses,
  searchNeighborCandidateHits,
  updateNeighborSettings,
  type NeighborCandidate,
  type NeighborCollectResult,
  type NeighborCompletedPage,
  type NeighborFilterHitsResult,
  type NeighborSearchHitsResult,
  type NeighborSettingsView,
  type NeighborStatusCheckSummary,
} from "@/services/neighborService";
import type { DiscoverCandidate } from "@/adapters/naver/NaverDiscoverAdapter";
import type {
  NeighborAiJudgment,
  NeighborAiRowInput,
} from "@/services/neighborAiAnalyze";
import type { NeighborExclusion } from "@/types/neighborScreen";
import type { CompletedRangePreset } from "@/lib/completedRange";
import {
  getNeighborManageDetail,
  listAcceptedNeighborManageItems,
  markNeighborCareDoneToday,
  snoozeNeighborCareToday,
} from "@/services/neighborManageService";
import type {
  NeighborManageDetailView,
  NeighborManageListPayload,
} from "@/types/neighborManage";

function revalidateNeighborPaths() {
  revalidatePath("/neighbors");
  revalidatePath("/today/approvals");
  revalidatePath("/today");
}

export async function listNeighborExclusionsAction(): Promise<
  NeighborExclusion[]
> {
  return listNeighborExclusions();
}

export async function listAcceptedNeighborManageAction(): Promise<
  NeighborManageListPayload
> {
  return listAcceptedNeighborManageItems();
}

export async function getNeighborManageDetailAction(
  personId: string,
): Promise<NeighborManageDetailView | null> {
  return getNeighborManageDetail(personId);
}

export async function markNeighborCareDoneTodayAction(
  personId: string,
): Promise<{ ok: true; careDoneOn: string }> {
  const result = await markNeighborCareDoneToday(personId);
  revalidateNeighborPaths();
  return result;
}

export async function snoozeNeighborCareTodayAction(
  personId: string,
): Promise<{ ok: true; careSnoozeOn: string }> {
  const result = await snoozeNeighborCareToday(personId);
  revalidateNeighborPaths();
  return result;
}

export async function listNeighborCandidatesAction(opts?: {
  limit?: number;
}): Promise<NeighborCandidate[]> {
  return listNeighborCandidates(opts);
}

export async function getNeighborScreenAction(): Promise<{
  settings: NeighborSettingsView;
  candidates: NeighborCandidate[];
  exclusions: NeighborExclusion[];
  completed: NeighborCompletedPage;
}> {
  try {
    const [settings, candidates, exclusions, completed] = await Promise.all([
      getNeighborSettings(),
      listNeighborCandidates(),
      listNeighborExclusions(),
      listNeighborCompleted({ page: 1, pageSize: 15, preset: "7d" }),
    ]);
    return { settings, candidates, exclusions, completed };
  } catch (err) {
    console.error("[neighbor-sync-error]", {
      where: "getNeighborScreenAction",
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    throw new Error(
      "이웃 정보를 불러오는 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.",
    );
  }
}

export async function listNeighborCompletedAction(
  page = 1,
  pageSize = 15,
  opts?: {
    preset?: CompletedRangePreset;
    fromDate?: string;
    toDate?: string;
    statusFilter?: import("@/services/neighborService").NeighborCompletedStatusFilter;
  },
): Promise<NeighborCompletedPage> {
  return listNeighborCompleted({
    page,
    pageSize,
    preset: opts?.preset ?? "7d",
    fromDate: opts?.fromDate,
    toDate: opts?.toDate,
    statusFilter: opts?.statusFilter ?? null,
  });
}

export async function searchNeighborCandidatesAction(): Promise<NeighborSearchHitsResult> {
  return searchNeighborCandidateHits();
}

export async function filterNeighborCandidatesAction(input: {
  hits: DiscoverCandidate[];
  remainingQuota?: number;
  searchSource?: NeighborCollectResult["searchSource"];
  filterMax?: number;
  aiAnalyzeMax?: number;
  funnel?: NeighborCollectResult["funnel"];
}): Promise<NeighborFilterHitsResult> {
  return filterNeighborCandidateHits(input.hits, {
    remainingQuota: input.remainingQuota,
    searchSource: input.searchSource,
    filterMax: input.filterMax,
    aiAnalyzeMax: input.aiAnalyzeMax,
    funnel: input.funnel,
  });
}

export async function analyzeNeighborAiBatchAction(input: {
  rows: NeighborAiRowInput[];
  keywords: string[];
  batchIndex?: number;
  batchTotal?: number;
  timeoutMs?: number;
}): Promise<{
  judgments: NeighborAiJudgment[];
  analyzed: number;
  rejected: number;
  failed: number;
  llmCount: number;
  heuristicCount: number;
  openaiRequests: number;
  openaiSuccess: number;
  openaiFail: number;
}> {
  return analyzeNeighborAiBatch(input);
}

export async function finalizeNeighborCollectAction(input: {
  filterResult: NeighborFilterHitsResult;
  judgments: NeighborAiJudgment[];
  analyzed: number;
  rejected: number;
  failed?: number;
  openaiRequests?: number;
  openaiSuccess?: number;
  openaiFail?: number;
}): Promise<NeighborCollectResult> {
  const result = await finalizeNeighborCollectWithJudgments(input.filterResult, {
    judgments: input.judgments,
    analyzed: input.analyzed,
    rejected: input.rejected,
    failed: input.failed,
    openaiRequests: input.openaiRequests,
    openaiSuccess: input.openaiSuccess,
    openaiFail: input.openaiFail,
  });
  revalidateNeighborPaths();
  return result;
}

export async function analyzeAndSaveNeighborCandidatesAction(
  filterResult: NeighborFilterHitsResult,
): Promise<NeighborCollectResult> {
  const result = await analyzeAndSaveNeighborCandidates(filterResult);
  revalidateNeighborPaths();
  return result;
}

export async function collectNeighborCandidatesAction(): Promise<NeighborCollectResult> {
  const result = await collectNeighborCandidates();
  revalidateNeighborPaths();
  return result;
}

export async function updateNeighborSettingsAction(input: {
  keywords?: string[];
  daily_candidate_quota?: number;
  ai_analyze_max?: number;
  ai_batch_size?: number;
  ai_concurrency?: number;
  message?: string;
  delay_min_sec?: number;
  delay_max_sec?: number;
  daily_request_limit?: number;
  status_check_mode?: import("@/domain/neighbor/relationStatus").NeighborStatusCheckMode;
  feed_lookback_days?: number;
  feed_max_per_neighbor_day?: number;
  feed_max_collect_day?: number;
  feed_collect_mode?: "manual" | "daily_1" | "daily_2" | "daily_4";
  feed_collect_hour?: number;
  feed_ai_auto_count?: 5 | 10 | 20;
}): Promise<NeighborSettingsView> {
  const next = await updateNeighborSettings(input);
  revalidateNeighborPaths();
  return next;
}

export async function markNeighborRequestedAction(
  personId: string,
): Promise<{ ok: boolean }> {
  return markNeighborRequested(personId);
}

export async function markNeighborRequestFailedAction(
  personId: string,
  reason?: string,
): Promise<{ ok: boolean }> {
  return markNeighborRequestFailed(personId, reason);
}

export async function checkPendingNeighborStatusesAction(opts?: {
  force?: boolean;
  limit?: number;
  personIds?: string[];
}): Promise<NeighborStatusCheckSummary> {
  const result = await checkPendingNeighborStatuses(opts);
  revalidateNeighborPaths();
  return result;
}

export async function excludeNeighborBlogAction(input: {
  blogId: string;
  blogName?: string;
  blogUrl?: string;
  personId?: string;
}): Promise<void> {
  await excludeNeighborBlog(input);
  revalidateNeighborPaths();
}

export async function allowNeighborBlogAgainAction(
  blogId: string,
): Promise<void> {
  await allowNeighborBlogAgain(blogId);
  revalidateNeighborPaths();
}

export async function createNeighborRequestApprovalAction(
  personId: string,
): Promise<{ ok: boolean; approvalId?: string; errorMessage?: string }> {
  const result = await createNeighborRequestApproval(personId);
  console.info("[NEIGHBOR_UI]", {
    clicked_action: "create_approval",
    person_id: personId,
    created_jobs_count: result.ok ? 1 : 0,
    approval_id: result.approvalId ?? null,
    ok: result.ok,
    error_message: result.errorMessage ?? null,
  });
  revalidateNeighborPaths();
  return result;
}

export async function checkNeighborDuplicatesAction(
  personIds: string[],
): Promise<Awaited<ReturnType<typeof checkNeighborDuplicates>>> {
  return checkNeighborDuplicates(personIds);
}

export async function createNeighborRequestsBatchAction(
  personIds: string[],
): Promise<{
  created: Array<{ personId: string; approvalId: string }>;
  failed: Array<{ personId: string; errorMessage: string }>;
}> {
  const created: Array<{ personId: string; approvalId: string }> = [];
  const failed: Array<{ personId: string; errorMessage: string }> = [];
  for (const personId of personIds) {
    const result = await createNeighborRequestApproval(personId);
    if (result.ok && result.approvalId) {
      created.push({ personId, approvalId: result.approvalId });
    } else {
      failed.push({
        personId,
        errorMessage: result.errorMessage ?? "생성 실패",
      });
    }
  }
  revalidateNeighborPaths();
  return { created, failed };
}

export async function getNeighborFeedStatusAction(): Promise<
  Awaited<ReturnType<typeof import("@/services/neighborFeedService").getNeighborFeedStatus>>
> {
  try {
    const { getNeighborFeedStatus } = await import(
      "@/services/neighborFeedService"
    );
    return await getNeighborFeedStatus();
  } catch (err) {
    console.error("[neighbor-sync-error]", {
      where: "getNeighborFeedStatusAction",
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    throw new Error(
      err instanceof Error && err.message.includes("이웃 정보")
        ? err.message
        : "이웃 정보를 불러오는 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.",
    );
  }
}

export async function listNeighborFeedPoolAction(): Promise<
  Awaited<ReturnType<typeof import("@/services/neighborFeedService").listNeighborFeedPool>>
> {
  try {
    const { listNeighborFeedPool } = await import(
      "@/services/neighborFeedService"
    );
    // Collect path: reconcile missing accepted rows first
    return await listNeighborFeedPool({ reconcile: true });
  } catch (err) {
    console.error("[neighbor-sync-error]", {
      where: "listNeighborFeedPoolAction",
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    throw new Error(
      "이웃 정보를 불러오는 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.",
    );
  }
}

export async function scanNeighborFeedBatchAction(input: {
  members: Awaited<
    ReturnType<typeof import("@/services/neighborFeedService").listNeighborFeedPool>
  >;
  cdpBudget: number;
}): Promise<
  Awaited<ReturnType<typeof import("@/services/neighborFeedService").scanNeighborFeedBatch>>
> {
  const { scanNeighborFeedBatch } = await import(
    "@/services/neighborFeedService"
  );
  return scanNeighborFeedBatch(input);
}

export async function finalizeNeighborFeedCollectAction(input: {
  candidates: Awaited<
    ReturnType<typeof import("@/services/neighborFeedService").scanNeighborFeedBatch>
  >["candidates"];
  poolSize: number;
  postsSeen: number;
  excluded: Awaited<
    ReturnType<typeof import("@/services/neighborFeedService").scanNeighborFeedBatch>
  >["excluded"];
  sourceStats: { rss: number; cdp: number; fail: number };
}): Promise<
  Awaited<
    ReturnType<typeof import("@/services/neighborFeedService").finalizeNeighborFeedCollect>
  >
> {
  const { finalizeNeighborFeedCollect } = await import(
    "@/services/neighborFeedService"
  );
  const result = await finalizeNeighborFeedCollect(input);
  revalidateNeighborPaths();
  revalidatePath("/today/approvals");
  return result;
}

export async function prepareNeighborFeedCollectAction(input: {
  candidates: Awaited<
    ReturnType<typeof import("@/services/neighborFeedService").scanNeighborFeedBatch>
  >["candidates"];
  poolSize: number;
  postsSeen: number;
  excluded: Awaited<
    ReturnType<typeof import("@/services/neighborFeedService").scanNeighborFeedBatch>
  >["excluded"];
  sourceStats: { rss: number; cdp: number; fail: number };
}): Promise<
  Awaited<
    ReturnType<typeof import("@/services/neighborFeedService").prepareNeighborFeedCollect>
  >
> {
  const { prepareNeighborFeedCollect } = await import(
    "@/services/neighborFeedService"
  );
  return prepareNeighborFeedCollect(input);
}

export async function registerNeighborFeedApprovalsBatchAction(input: {
  candidates: import("@/domain/neighbor/feedTypes").NeighborFeedCandidateDto[];
}): Promise<
  Awaited<
    ReturnType<
      typeof import("@/services/neighborFeedService").registerNeighborFeedApprovalsBatch
    >
  >
> {
  const { registerNeighborFeedApprovalsBatch } = await import(
    "@/services/neighborFeedService"
  );
  return registerNeighborFeedApprovalsBatch(input);
}

export async function stampNeighborFeedCollectAtAction(): Promise<string> {
  const { stampNeighborFeedCollectAt } = await import(
    "@/services/neighborFeedService"
  );
  const at = await stampNeighborFeedCollectAt();
  revalidateNeighborPaths();
  revalidatePath("/today/approvals");
  return at;
}

export async function logNeighborFeedApprovalsCreatedAction(
  created: number,
): Promise<{ openTotal: number; neighborFeedOpen: number }> {
  const { logNeighborFeedApprovalsCreated } = await import(
    "@/services/neighborFeedService"
  );
  return logNeighborFeedApprovalsCreated(created);
}

export async function collectNeighborFeedAction(): Promise<
  Awaited<ReturnType<typeof import("@/services/neighborFeedService").collectNeighborFeed>>
> {
  const { collectNeighborFeed } = await import(
    "@/services/neighborFeedService"
  );
  const result = await collectNeighborFeed();
  revalidateNeighborPaths();
  revalidatePath("/today/approvals");
  return result;
}

export async function fetchExistingNeighborsAction(): Promise<
  Awaited<
    ReturnType<
      typeof import("@/services/neighborExistingSyncService").fetchExistingNeighborsFromNaver
    >
  >
> {
  const { fetchExistingNeighborsFromNaver } = await import(
    "@/services/neighborExistingSyncService"
  );
  return fetchExistingNeighborsFromNaver();
}

export async function upsertExistingNeighborsBatchAction(
  neighbors: import("@/domain/neighbor/existingSyncTypes").ExistingNeighborDto[],
): Promise<
  Awaited<
    ReturnType<
      typeof import("@/services/neighborExistingSyncService").upsertExistingNeighborsBatch
    >
  >
> {
  const { upsertExistingNeighborsBatch } = await import(
    "@/services/neighborExistingSyncService"
  );
  return upsertExistingNeighborsBatch(neighbors);
}

export async function finalizeExistingNeighborSyncAction(input: {
  ownBlogId: string | null;
  total: number;
  added: number;
  updated: number;
  skipped: number;
  errors: string[];
}): Promise<
  Awaited<
    ReturnType<
      typeof import("@/services/neighborExistingSyncService").finalizeExistingNeighborSync
    >
  >
> {
  const { finalizeExistingNeighborSync } = await import(
    "@/services/neighborExistingSyncService"
  );
  const result = await finalizeExistingNeighborSync(input);
  revalidateNeighborPaths();
  return result;
}
