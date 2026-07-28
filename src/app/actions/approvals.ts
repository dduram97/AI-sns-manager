"use server";

import { revalidatePath } from "next/cache";
import type { CommentSituation } from "@/lib/commentSituation";
import {
  approveApproval,
  approveApprovalsBatch,
  checkApprovalPostDuplicates,
  listApprovalInbox,
  listCompletedApprovals,
  listNeighborFeedApprovalInbox,
  listNeighborFeedCompletedApprovals,
  prepareNeighborFeedExecuteDraft,
  previewNeighborFeedCommentDraft,
  previewNeighborFeedCommentsBatch,
  regenerateApprovalCommentDraft,
  rejectApproval,
  retryFailedApproval,
  saveApprovalCommentSituation,
  saveApprovalDraft,
  snoozeApproval,
  type ApprovalExecuteMode,
  type ApprovalHistoryPage,
  type ApprovalInboxItem,
  type BatchApproveResult,
  type DuplicateCheckResult,
  type RetryFailedApprovalResult,
} from "@/services/approvalService";

function revalidateSupervisorPaths() {
  revalidatePath("/today");
  revalidatePath("/today/approvals");
  revalidatePath("/neighbors");
  revalidatePath("/people");
}

export async function approveApprovalAction(
  approvalId: string,
  draftBody?: string,
  mode?: ApprovalExecuteMode,
): Promise<{ ok: boolean; errorMessage?: string; excluded?: boolean }> {
  try {
    const result = await approveApproval(approvalId, draftBody, { mode });
    revalidateSupervisorPaths();
    return result;
  } catch (err) {
    revalidateSupervisorPaths();
    return {
      ok: false,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function retryFailedApprovalAction(
  approvalId: string,
  options?: { draftBody?: string; mode?: ApprovalExecuteMode },
): Promise<RetryFailedApprovalResult> {
  const result = await retryFailedApproval(approvalId, options);
  revalidateSupervisorPaths();
  return result;
}

export async function approveApprovalsBatchAction(
  approvalIds: string[],
  options?: {
    mode?: ApprovalExecuteMode;
    delayMinMs?: number;
    delayMaxMs?: number;
    /** @deprecated */
    intervalMs?: number;
  },
): Promise<BatchApproveResult> {
  const result = await approveApprovalsBatch(approvalIds, options);
  revalidateSupervisorPaths();
  return result;
}

export async function listCompletedApprovalsAction(
  page = 1,
  pageSize = 15,
  options?: {
    preset?: "today" | "7d" | "30d" | "custom";
    fromDate?: string;
    toDate?: string;
  },
): Promise<ApprovalHistoryPage> {
  return listCompletedApprovals({
    page,
    pageSize,
    preset: options?.preset,
    fromDate: options?.fromDate,
    toDate: options?.toDate,
  });
}

export async function listOpenApprovalsAction(): Promise<ApprovalInboxItem[]> {
  return listApprovalInbox();
}

export async function listNeighborFeedApprovalsAction(): Promise<
  ApprovalInboxItem[]
> {
  return listNeighborFeedApprovalInbox();
}

export async function listNeighborFeedCompletedApprovalsAction(
  page = 1,
  pageSize = 20,
  options?: {
    preset?: "today" | "7d" | "30d" | "custom";
    fromDate?: string;
    toDate?: string;
  },
): Promise<ApprovalHistoryPage> {
  return listNeighborFeedCompletedApprovals({
    page,
    pageSize,
    preset: options?.preset,
    fromDate: options?.fromDate,
    toDate: options?.toDate,
  });
}

export async function ensureNeighborFeedCommentDraftAction(
  approvalId: string,
): Promise<string> {
  return prepareNeighborFeedExecuteDraft(approvalId, { forceFresh: false });
}

export async function previewNeighborFeedCommentAction(
  approvalId: string,
  situation?: CommentSituation,
): Promise<
  import("@/lib/neighborCommentAiError").NeighborCommentAiPreviewResult
> {
  // Do not revalidatePath here — batch auto-gen would re-render /neighbors for minutes.
  return previewNeighborFeedCommentDraft(approvalId, situation);
}

export async function previewNeighborFeedCommentsBatchAction(
  approvalIds: string[],
): Promise<{
  results: Array<{
    approvalId: string;
    ok: boolean;
    body?: string;
    error?: string;
    errorType?: string;
    title?: string;
  }>;
}> {
  return previewNeighborFeedCommentsBatch(approvalIds);
}

export async function prepareNeighborFeedExecuteDraftAction(
  approvalId: string,
  options?: { forceFresh?: boolean },
): Promise<string> {
  return prepareNeighborFeedExecuteDraft(approvalId, options);
}

export async function checkApprovalDuplicatesAction(
  approvalIds: string[],
): Promise<DuplicateCheckResult> {
  return checkApprovalPostDuplicates(approvalIds);
}

export async function saveApprovalDraftAction(
  approvalId: string,
  draftBody: string,
) {
  await saveApprovalDraft(approvalId, draftBody);
  revalidatePath("/today/approvals");
}

export async function saveApprovalCommentSituationAction(
  approvalId: string,
  situation: CommentSituation,
) {
  await saveApprovalCommentSituation(approvalId, situation);
  revalidatePath("/today/approvals");
}

export async function regenerateApprovalCommentDraftAction(
  approvalId: string,
  situation?: CommentSituation,
) {
  const result = await regenerateApprovalCommentDraft(approvalId, situation);
  revalidatePath("/today/approvals");
  revalidatePath("/neighbors");
  return result;
}

export async function rejectApprovalAction(approvalId: string, reason?: string) {
  await rejectApproval(approvalId, reason);
  revalidateSupervisorPaths();
}

export async function snoozeApprovalAction(approvalId: string) {
  await snoozeApproval(approvalId);
  revalidateSupervisorPaths();
}
