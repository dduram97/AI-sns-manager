import "server-only";

import { createServiceClient } from "@/lib/supabase";
import {
  executeActionJob,
  type ActionExecutionPort,
} from "@/adapters/executeActionJob";
import {
  defaultApprovalExecuteMode,
  parseApprovalExecuteMode,
  resolveAvailableModes,
  type ApprovalExecuteMode,
} from "@/lib/approvalExecuteMode";
import {
  applyBatchQueueDelay,
  type BatchQueueDelayOptions,
} from "@/lib/batchQueueDelay";
import {
  parseCommentSituation,
  type CommentSituation,
} from "@/lib/commentSituation";
import {
  resolveCompletedRange,
  type CompletedRangePreset,
} from "@/lib/completedRange";
import {
  isNeighborFeedDraftFresh,
  needsNeighborFeedAiDraft,
  neighborFeedDraftProbeFromInboxItem,
} from "@/lib/neighborFeedDraft";
import {
  classifyNeighborCommentAiError,
  NeighborCommentAiError,
  neighborCommentAiUserMessage,
  type NeighborCommentAiPreviewResult,
} from "@/lib/neighborCommentAiError";
import { postKeyFromTargetRef } from "@/lib/naverPostKey";
import {
  getNeighborDailyLimit,
} from "@/domain/policy/neighborPolicy";
import {
  commentStyleFromPolicy,
  compactNeighborContent,
  generateCommentDraftForPost,
} from "@/services/commentDraftService";
import {
  createSupervisorRepos,
  type ApprovalHistoryItem,
  type ApprovalHistoryPage,
  type ApprovalInboxItem,
  type SupervisorRepos,
} from "@/repositories/index";
import type { DuplicatePostHit } from "@/types/approvalInbox";
import type { ActionJob, RelationshipStage } from "@/workers/types";

export type {
  ApprovalInboxItem,
  ApprovalHistoryItem,
  ApprovalHistoryPage,
  ApprovalExecuteMode,
  CommentSituation,
};

export type { DuplicatePostHit } from "@/types/approvalInbox";
export {
  needsNeighborFeedAiDraft,
  isNeighborFeedDraftFresh,
} from "@/lib/neighborFeedDraft";

/** General comment/like Inbox — excludes neighbor_feed (managed on /neighbors). */
export async function listApprovalInbox(): Promise<ApprovalInboxItem[]> {
  const repos = createSupervisorRepos(createServiceClient());
  const items = await repos.approval.listOpenInbox();
  const filtered = items.filter((i) => i.source !== "neighbor_feed");
  console.info("Inbox query: neighbor_feed included: false");
  console.info(`표시 개수: ${filtered.length}`);
  return filtered;
}

/** Neighbor-feed open approvals — /neighbors 「이웃 새글」 tab only. */
export async function listNeighborFeedApprovalInbox(): Promise<
  ApprovalInboxItem[]
> {
  const repos = createSupervisorRepos(createServiceClient());
  const items = await repos.approval.listOpenInbox();
  const filtered = items.filter((i) => i.source === "neighbor_feed");
  console.info("neighbor_feed Inbox query: included: true");
  console.info(`neighbor_feed 표시 개수: ${filtered.length}`);
  return filtered;
}

export async function listCompletedApprovals(opts?: {
  page?: number;
  pageSize?: number;
  preset?: CompletedRangePreset;
  fromDate?: string;
  toDate?: string;
  /** Default: exclude neighbor_feed from /today/approvals. */
  sourceMode?: "all" | "neighbor_feed_only" | "exclude_neighbor_feed";
}): Promise<ApprovalHistoryPage> {
  const range = resolveCompletedRange({
    preset: opts?.preset ?? "7d",
    fromDate: opts?.fromDate,
    toDate: opts?.toDate,
  });
  const repos = createSupervisorRepos(createServiceClient());
  return repos.approval.listResolvedInbox({
    page: opts?.page ?? 1,
    pageSize: opts?.pageSize ?? 15,
    fromIso: range.fromIso,
    toIso: range.toIso,
    rangeLabel: range.label,
    sourceMode: opts?.sourceMode ?? "exclude_neighbor_feed",
  });
}

export async function listNeighborFeedCompletedApprovals(opts?: {
  page?: number;
  pageSize?: number;
  preset?: CompletedRangePreset;
  fromDate?: string;
  toDate?: string;
}): Promise<ApprovalHistoryPage> {
  return listCompletedApprovals({
    ...opts,
    sourceMode: "neighbor_feed_only",
  });
}

export type DuplicateCheckResult = {
  duplicates: DuplicatePostHit[];
  /** Approval ids among the request that are NOT duplicates */
  uniqueApprovalIds: string[];
};

/**
 * Pre-execution duplicate check by Naver post key (blog_id:log_no / post_url).
 * Uses executed ActionJob history only — does not change approve flow.
 */
export async function checkApprovalPostDuplicates(
  approvalIds: string[],
): Promise<DuplicateCheckResult> {
  const ids = [...new Set(approvalIds.filter(Boolean))];
  if (ids.length === 0) {
    return { duplicates: [], uniqueApprovalIds: [] };
  }

  const repos = createSupervisorRepos(createServiceClient());
  const executed = await repos.approval.listRecentExecutedCommentLike(800);

  type Prior = {
    commentAt: string | null;
    likeAt: string | null;
    title: string | null;
    jobIds: Set<string>;
  };
  const byPost = new Map<string, Prior>();

  for (const job of executed) {
    const key = postKeyFromTargetRef(job.target_ref);
    if (!key) continue;
    const at =
      job.executed_at ?? job.updated_at ?? job.created_at ?? new Date().toISOString();
    const title =
      (typeof job.target_ref?.title === "string" && job.target_ref.title) ||
      null;
    let entry = byPost.get(key);
    if (!entry) {
      entry = {
        commentAt: null,
        likeAt: null,
        title,
        jobIds: new Set(),
      };
      byPost.set(key, entry);
    }
    entry.jobIds.add(job.id);
    if (!entry.title && title) entry.title = title;
    if (job.action_type === "comment") {
      if (!entry.commentAt || at > entry.commentAt) entry.commentAt = at;
    } else if (job.action_type === "like") {
      if (!entry.likeAt || at > entry.likeAt) entry.likeAt = at;
    }
  }

  const duplicates: DuplicatePostHit[] = [];
  const uniqueApprovalIds: string[] = [];

  for (const approvalId of ids) {
    const approval = await repos.approval.getById(approvalId);
    if (!approval || approval.resolved_at) {
      uniqueApprovalIds.push(approvalId);
      continue;
    }
    const job = await repos.approval.getActionJob(approval.action_job_id);
    const key = postKeyFromTargetRef(job.target_ref);
    if (!key) {
      uniqueApprovalIds.push(approvalId);
      continue;
    }

    const prior = byPost.get(key);
    const hasPrior =
      prior &&
      (prior.commentAt || prior.likeAt) &&
      // Ignore if the only executed jobs are somehow this same job id
      [...prior.jobIds].some((jid) => jid !== job.id);

    if (!hasPrior || !prior) {
      uniqueApprovalIds.push(approvalId);
      continue;
    }

    const priorMode: DuplicatePostHit["priorMode"] =
      prior.commentAt && prior.likeAt
        ? "both"
        : prior.commentAt
          ? "comment"
          : "like";
    const lastExecutedAt = [prior.commentAt, prior.likeAt]
      .filter((x): x is string => Boolean(x))
      .sort()
      .at(-1)!;

    const title =
      (typeof job.target_ref?.title === "string" && job.target_ref.title) ||
      prior.title ||
      "제목 없음";

    duplicates.push({
      approvalId,
      title,
      priorMode,
      lastExecutedAt,
      postKey: key,
    });
  }

  return { duplicates, uniqueApprovalIds };
}

function toExecutionPort(repos: SupervisorRepos): ActionExecutionPort {
  return {
    markJobRunning: (jobId) => repos.approval.markJobRunning(jobId),
    markJobExecuted: (jobId, opts) =>
      repos.approval.markJobExecuted(jobId, opts),
    markJobFailed: (jobId, message, opts) =>
      repos.approval.markJobFailed(jobId, message, opts),
    markJobSkipped: (jobId, input) =>
      repos.approval.markJobSkipped(jobId, input),
    updateRelationship: (personId, patch) =>
      repos.person.updateRelationship(personId, patch),
    updateWorkflow: (workflowId, patch) =>
      repos.person.updateWorkflow(workflowId, patch),
    insertActivity: (input) => repos.activity.insert(input),
    incrementOutcomeCounters: (deltas) =>
      repos.brief.incrementOutcomeCounters(deltas),
    getPolicy: () => repos.policy.get(),
    getOutcomeToday: () => repos.brief.ensureOutcomeToday(),
    findRecentExecutedByPerson: (personId, actionType, limit) =>
      repos.approval.findRecentExecutedByPerson(personId, actionType, limit),
    markBlogChannelError: async (reason) => {
      await repos.policy.updateChannelStatus("blog", "error");
      console.warn("[approvalService] blog channel error:", reason);
    },
  };
}

async function refreshBriefAfterMutation(repos: SupervisorRepos) {
  const open = await repos.approval.listOpen();
  const outcome = await repos.brief.ensureOutcomeToday();
  const todayActivities = await repos.activity.listForDate(outcome.date);
  const channels = await repos.brief.listChannelConnectionStatuses();
  const current = await repos.brief.getBrief();
  const lastTick =
    typeof current.status_detail?.last_tick_at === "string"
      ? current.status_detail.last_tick_at
      : new Date().toISOString();

  await repos.brief.updateBrief({
    agent_status: "active",
    status_detail: {
      last_tick_at: lastTick,
      channels,
    },
    activity_summary: {
      auto_visits: outcome.auto_visit_count,
      auto_likes: outcome.auto_like_count,
      observe: outcome.observe_count,
      waiting: outcome.waiting_count,
      approval_created: todayActivities.filter((a) => a.kind === "approval_created")
        .length,
      executed: todayActivities.filter((a) => a.kind === "executed").length,
    },
    approval_count: open.length,
    intervention_minutes_est: (open.length * 50) / 60,
    time_saved_minutes_est: outcome.time_saved_minutes_est,
    growth_summary: {
      temperature_up: outcome.temperature_up_count,
      mutual_reactions: outcome.mutual_reaction_count,
    },
  });

  await repos.brief.updateOutcomeToday({
    approval_pending_count: open.length,
    intervention_minutes_est: (open.length * 50) / 60,
  });
}

function nextStageAfterApprove(stage: RelationshipStage): RelationshipStage {
  if (
    stage === "approval_pending" ||
    stage === "warming" ||
    stage === "waiting_new_post" ||
    stage === "discover"
  ) {
    return "early_relationship";
  }
  if (stage === "early_relationship") return "maintain";
  return stage === "vip" ? "vip" : "maintain";
}

function findBundledLike(
  primary: ActionJob,
  siblings: ActionJob[],
): ActionJob | null {
  return (
    siblings.find(
      (j) =>
        j.id !== primary.id &&
        j.action_type === "like" &&
        (j.status === "planned" ||
          j.status === "pending_approval" ||
          j.status === "approved" ||
          j.status === "failed"),
    ) ?? null
  );
}

/** Like already done in this bundle — must not run again. */
function findExecutedBundledLike(
  primary: ActionJob,
  siblings: ActionJob[],
): ActionJob | null {
  return (
    siblings.find(
      (j) =>
        j.id !== primary.id &&
        j.action_type === "like" &&
        j.status === "executed",
    ) ?? null
  );
}

export type ApprovalRetryHistoryEntry = {
  at: string;
  attempt: number;
  from_job_id: string;
  to_job_id: string;
  previous_error: string | null;
  mode: ApprovalExecuteMode | null;
  bundle_id: string | null;
};

function readRetryHistory(
  ctx: Record<string, unknown> | null | undefined,
): ApprovalRetryHistoryEntry[] {
  const raw = ctx?.retry_history;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (x): x is ApprovalRetryHistoryEntry =>
      Boolean(x) &&
      typeof x === "object" &&
      typeof (x as ApprovalRetryHistoryEntry).from_job_id === "string" &&
      typeof (x as ApprovalRetryHistoryEntry).to_job_id === "string",
  );
}

function readLastExecuteMode(
  ctx: Record<string, unknown> | null | undefined,
): ApprovalExecuteMode | undefined {
  const m = ctx?.last_execute_mode;
  if (m === "comment" || m === "like" || m === "both") return m;
  return undefined;
}

async function skipJobQuietly(
  repos: SupervisorRepos,
  job: ActionJob | null,
  reason: string,
): Promise<void> {
  if (!job) return;
  if (
    job.status === "executed" ||
    job.status === "skipped_policy" ||
    job.status === "rejected" ||
    job.status === "permanently_failed"
  ) {
    return;
  }
  try {
    await repos.approval.markJobSkippedPolicy(job.id, reason);
  } catch (err) {
    console.warn(
      "[approvalService] skip sibling failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Spec: 수정 후 승인 — draft만 action_jobs에 저장 (아직 승인 아님)
 */
export async function saveApprovalDraft(
  approvalId: string,
  draftBody: string,
): Promise<void> {
  const repos = createSupervisorRepos(createServiceClient());
  const approval = await repos.approval.getById(approvalId);
  if (!approval || approval.resolved_at) {
    throw new Error("Approval not found or already resolved");
  }
  const job = await repos.approval.getActionJob(approval.action_job_id);
  if (job.status !== "pending_approval") {
    throw new Error(`Invalid job status: ${job.status}`);
  }
  await repos.approval.updateJobDraft(job.id, draftBody.trim());
}

/**
 * Save user-edited comment situation (does not regenerate draft by itself).
 */
export async function saveApprovalCommentSituation(
  approvalId: string,
  situation: CommentSituation,
): Promise<void> {
  const repos = createSupervisorRepos(createServiceClient());
  const approval = await repos.approval.getById(approvalId);
  if (!approval || approval.resolved_at) {
    throw new Error("Approval not found or already resolved");
  }
  const job = await repos.approval.getActionJob(approval.action_job_id);
  if (job.action_type !== "comment" || job.status !== "pending_approval") {
    throw new Error("Comment situation only applies to pending comment jobs");
  }
  const next = parseCommentSituation(situation);
  await repos.approval.updatePresentedContext(approval.id, {
    comment_situation: next,
  });
  await repos.approval.updateJobTargetRef(job.id, {
    ...job.target_ref,
    comment_situation: next,
  });
}

/**
 * Regenerate AI draft_body using policy style examples + situation.
 */
export async function regenerateApprovalCommentDraft(
  approvalId: string,
  situation?: CommentSituation,
): Promise<{ body: string; situation: CommentSituation; source: string }> {
  const repos = createSupervisorRepos(createServiceClient());
  const approval = await repos.approval.getById(approvalId);
  if (!approval || approval.resolved_at) {
    throw new Error("Approval not found or already resolved");
  }
  const job = await repos.approval.getActionJob(approval.action_job_id);
  if (job.action_type !== "comment" || job.status !== "pending_approval") {
    throw new Error("Only pending comment approvals can regenerate drafts");
  }

  const ctx = approval.presented_context ?? {};
  const chosen = parseCommentSituation(
    situation ??
      ctx.comment_situation ??
      job.target_ref?.comment_situation ??
      "공감",
  );

  const policy = await repos.policy.get();
  const style = commentStyleFromPolicy(policy);
  const title =
    (typeof ctx.post_title === "string" && ctx.post_title) ||
    (typeof job.target_ref?.title === "string" && job.target_ref.title) ||
    "새 글";
  // Neighbor feed: summary only — never full body / long excerpt.
  const rawSummary =
    (typeof ctx.post_summary === "string" && ctx.post_summary) ||
    (typeof job.target_ref?.content_summary === "string" &&
      job.target_ref.content_summary) ||
    "";
  const isNeighborFeed =
    job.target_ref?.source === "neighbor_feed" ||
    job.target_ref?.neighbor_feed === true;
  const content = isNeighborFeed
    ? compactNeighborContent(rawSummary || title)
    : rawSummary ||
      (typeof job.target_ref?.content_excerpt === "string" &&
        job.target_ref.content_excerpt) ||
      title;

  const keywordRaw = job.target_ref?.keywords ?? ctx.keywords;
  const keywords = Array.isArray(keywordRaw)
    ? keywordRaw.filter((x): x is string => typeof x === "string")
    : undefined;

  const blogId =
    (typeof job.target_ref?.blog_id === "string" && job.target_ref.blog_id) ||
    (typeof job.target_ref?.blogId === "string" && job.target_ref.blogId) ||
    (typeof ctx.blog_id === "string" && ctx.blog_id) ||
    undefined;

  const generated = await generateCommentDraftForPost({
    title,
    content,
    styleExamples: style.styleExamples,
    toneBase: style.toneBase,
    bannedPhrases: style.bannedPhrases,
    situation: chosen,
    variant: isNeighborFeed ? "neighbor_feed" : "default",
    keywords,
    category: chosen,
    blogId,
  });

  const generatedAt = new Date().toISOString();

  if (
    isNeighborFeed &&
    (generated.source === "fallback" || !generated.body.trim())
  ) {
    const classified = generated.errorType
      ? {
          errorType: generated.errorType,
          message: neighborCommentAiUserMessage(generated.errorType),
          raw: generated.errorMessage ?? generated.errorType,
        }
      : classifyNeighborCommentAiError(
          generated.errorMessage ?? "unknown neighbor comment ai failure",
        );
    console.warn("[neighbor-comment-ai]", "persist skipped", {
      title,
      blog_id: blogId ?? null,
      errorType: classified.errorType,
      message: classified.raw,
    });
    throw new NeighborCommentAiError(
      classified.errorType,
      classified.raw,
      classified.message,
    );
  }

  await repos.approval.updateJobDraftAndAlternatives(
    job.id,
    generated.body,
    generated.alternatives,
  );
  await repos.approval.updatePresentedContext(approval.id, {
    comment_situation: generated.situation,
    ai_draft_source: isNeighborFeed
      ? `neighbor_feed_${generated.source}`
      : generated.source,
    ai_draft_model: generated.model,
    post_title: title,
    post_summary: content.slice(0, 280),
    ...(isNeighborFeed
      ? {
          ai_draft_generated_at: generatedAt,
          ai_generated_at: generatedAt,
          ai_comment: generated.body,
        }
      : {}),
  });
  await repos.approval.updateJobTargetRef(job.id, {
    ...job.target_ref,
    comment_situation: generated.situation,
    ai_draft_source: isNeighborFeed
      ? `neighbor_feed_${generated.source}`
      : generated.source,
    ai_draft_model: generated.model,
    ...(generated.draftMeta
      ? { comment_draft: generated.draftMeta }
      : {}),
    ...(isNeighborFeed
      ? {
          ai_draft_generated_at: generatedAt,
          ai_generated_at: generatedAt,
          ai_comment: generated.body,
        }
      : {}),
  });

  return {
    body: generated.body,
    situation: generated.situation!,
    source: generated.source,
  };
}

async function generateAndPersistNeighborFeedDraft(
  approvalId: string,
  situation?: CommentSituation,
): Promise<NeighborCommentAiPreviewResult> {
  try {
    const result = await regenerateApprovalCommentDraft(approvalId, situation);
    const generatedAt = new Date().toISOString();
    const repos = createSupervisorRepos(createServiceClient());
    const approval = await repos.approval.getById(approvalId);
    if (!approval) {
      return {
        success: false,
        errorType: "unknown",
        message: neighborCommentAiUserMessage("unknown"),
      };
    }
    const job = await repos.approval.getActionJob(approval.action_job_id);
    await repos.approval.updatePresentedContext(approval.id, {
      ai_draft_generated_at: generatedAt,
      ai_generated_at: generatedAt,
      ai_comment: result.body,
    });
    await repos.approval.updateJobTargetRef(job.id, {
      ...job.target_ref,
      ai_draft_generated_at: generatedAt,
      ai_generated_at: generatedAt,
      ai_comment: result.body,
    });
    return {
      success: true,
      body: result.body,
      situation: result.situation,
      source: result.source,
      generatedAt,
    };
  } catch (err) {
    if (err instanceof NeighborCommentAiError) {
      console.warn("[neighbor-comment-ai]", "draft failed", {
        errorType: err.errorType,
        message: err.raw,
      });
      return {
        success: false,
        errorType: err.errorType,
        message: err.message,
      };
    }
    const classified = classifyNeighborCommentAiError(err);
    console.warn("[neighbor-comment-ai]", "draft failed", {
      errorType: classified.errorType,
      message: classified.raw,
    });
    return {
      success: false,
      errorType: classified.errorType,
      message: classified.message,
    };
  }
}

/**
 * Optional preview on neighbors tab — saves draft + generated_at for card display.
 * Never throws for AI failures (returns success:false).
 */
export async function previewNeighborFeedCommentDraft(
  approvalId: string,
  situation?: CommentSituation,
): Promise<NeighborCommentAiPreviewResult> {
  const repos = createSupervisorRepos(createServiceClient());
  const approval = await repos.approval.getById(approvalId);
  if (!approval || approval.resolved_at) {
    return {
      success: false,
      errorType: "unknown",
      message: "승인 항목을 찾을 수 없거나 이미 처리되었습니다.",
    };
  }
  const job = await repos.approval.getActionJob(approval.action_job_id);
  const isNf =
    job.target_ref?.source === "neighbor_feed" ||
    job.target_ref?.neighbor_feed === true;
  if (!isNf) {
    return {
      success: false,
      errorType: "unknown",
      message: "이웃 새글 항목만 미리보기할 수 있습니다.",
    };
  }
  return generateAndPersistNeighborFeedDraft(approvalId, situation);
}

const FEED_AI_PREVIEW_CONCURRENCY = 3;

export type NeighborFeedPreviewBatchItem = {
  approvalId: string;
  ok: boolean;
  body?: string;
  error?: string;
  errorType?: string;
  title?: string;
};

/**
 * Parallel preview for a visible page only (concurrency 3).
 * One failure does not stop the rest.
 */
export async function previewNeighborFeedCommentsBatch(
  approvalIds: string[],
): Promise<{ results: NeighborFeedPreviewBatchItem[] }> {
  const ids = [...new Set(approvalIds.filter(Boolean))].slice(0, 50);
  const results: NeighborFeedPreviewBatchItem[] = [];

  async function one(id: string): Promise<NeighborFeedPreviewBatchItem> {
    const repos = createSupervisorRepos(createServiceClient());
    const approval = await repos.approval.getById(id);
    const job = approval
      ? await repos.approval.getActionJob(approval.action_job_id)
      : null;
    const title =
      (typeof job?.target_ref?.title === "string" && job.target_ref.title) ||
      (typeof approval?.presented_context?.post_title === "string" &&
        (approval.presented_context.post_title as string)) ||
      id.slice(0, 8);
    const generated = await previewNeighborFeedCommentDraft(id);
    if (generated.success) {
      return {
        approvalId: id,
        ok: true,
        body: generated.body,
        title,
      };
    }
    return {
      approvalId: id,
      ok: false,
      error: generated.message,
      errorType: generated.errorType,
      title,
    };
  }

  let next = 0;
  const workers = Array.from(
    { length: Math.min(FEED_AI_PREVIEW_CONCURRENCY, Math.max(1, ids.length)) },
    async () => {
      while (next < ids.length) {
        const i = next;
        next += 1;
        const id = ids[i]!;
        results[i] = await one(id);
      }
    },
  );
  await Promise.all(workers);
  return { results: results.filter(Boolean) };
}

/**
 * Before execute: reuse fresh preview, or regenerate. OpenAI failure aborts (throws).
 */
export async function prepareNeighborFeedExecuteDraft(
  approvalId: string,
  options?: { forceFresh?: boolean },
): Promise<string> {
  const repos = createSupervisorRepos(createServiceClient());
  const approval = await repos.approval.getById(approvalId);
  if (!approval || approval.resolved_at) {
    throw new Error("승인 항목을 찾을 수 없거나 이미 처리되었습니다.");
  }
  const job = await repos.approval.getActionJob(approval.action_job_id);
  const probe = neighborFeedDraftProbeFromInboxItem({
    source: "neighbor_feed",
    draftBody: job.draft_body ?? "",
    job,
    approval,
  });

  if (!options?.forceFresh && isNeighborFeedDraftFresh(probe)) {
    return job.draft_body ?? "";
  }

  const generated = await generateAndPersistNeighborFeedDraft(approvalId);
  if (!generated.success) {
    throw new NeighborCommentAiError(
      generated.errorType,
      generated.message,
      generated.message,
    );
  }
  return generated.body;
}

/** @deprecated prefer prepareNeighborFeedExecuteDraft */
export async function ensureNeighborFeedCommentDraft(
  approvalId: string,
): Promise<string> {
  return prepareNeighborFeedExecuteDraft(approvalId, { forceFresh: false });
}

export type ApproveApprovalOptions = {
  /** Skip Brief refresh (batch caller refreshes once at end). */
  skipBriefRefresh?: boolean;
  /**
   * comment | like | both
   * Default: both when bundled like exists, else comment (legacy).
   */
  mode?: ApprovalExecuteMode;
};

/**
 * Spec: Approval → ActionJob → ChannelExecutor → Adapter
 * → success: Workflow → Activity → Outcome → Brief · resolve Approval
 * → failure: retry_count↑ · error · Workflow blocked · Activity blocked · Approval 유지
 *
 * Bundle modes (comment approval + planned like sibling):
 * - comment: run comment, skip like
 * - like: run like first; skip comment only after like succeeds (re-approvable on fail)
 * - both: run comment, on success run like
 */
export async function approveApproval(
  approvalId: string,
  draftBody?: string,
  options?: ApproveApprovalOptions,
): Promise<{
  ok: boolean;
  errorMessage?: string;
  excluded?: boolean;
}> {
  const repos = createSupervisorRepos(createServiceClient());
  const approval = await repos.approval.getById(approvalId);
  if (!approval || approval.resolved_at) {
    throw new Error("Approval not found or already resolved");
  }

  const job = await repos.approval.getActionJob(approval.action_job_id);
  if (job.status !== "pending_approval") {
    throw new Error(`Invalid job status: ${job.status}`);
  }

  if (job.action_type === "neighbor_request") {
    const { countNeighborExecutedToday } = await import(
      "@/services/neighborService"
    );
    const policy = await repos.policy.get();
    const limit = getNeighborDailyLimit(policy);
    const used = await countNeighborExecutedToday();
    if (used >= limit) {
      return {
        ok: false,
        errorMessage: "오늘 서로이웃 추가 가능 수량을 모두 사용했습니다.",
      };
    }
  }

  const siblings = job.bundle_id
    ? await repos.approval.listJobsByBundleId(job.bundle_id)
    : [];
  const bundledLike = findBundledLike(job, siblings);
  const executedBundledLike = findExecutedBundledLike(job, siblings);
  const available = resolveAvailableModes({
    actionType: job.action_type,
    hasBundledLike: Boolean(bundledLike) || Boolean(executedBundledLike),
  });
  // Mutual / legacy: no mode UI — always execute primary job as before.
  const modeAware = available.length > 0;
  const mode = modeAware
    ? parseApprovalExecuteMode(
        options?.mode,
        defaultApprovalExecuteMode(available),
      )
    : "comment";

  if (modeAware && !available.includes(mode)) {
    throw new Error(`Unsupported approval mode "${mode}" for this item`);
  }

  // Persist mode so retry can reuse it after a failure.
  if (modeAware) {
    await repos.approval.updatePresentedContext(approval.id, {
      last_execute_mode: mode,
    });
  }

  if (modeAware && mode === "like" && job.action_type === "comment" && !bundledLike) {
    return {
      ok: false,
      errorMessage: "묶인 공감(ActionJob)이 없어 공감만 승인할 수 없습니다",
    };
  }

  const person = await repos.person.getById(approval.person_id);
  const personDisplayName = person?.display_name;
  const port = toExecutionPort(repos);

  const body =
    draftBody !== undefined ? draftBody.trim() : (job.draft_body ?? undefined);

  const runComment = !modeAware || mode === "comment" || mode === "both";
  const runLike = modeAware && (mode === "like" || mode === "both");

  // --- like-only on comment primary: execute like first; skip comment only on success ---
  if (modeAware && mode === "like" && job.action_type === "comment") {
    const likeJob = bundledLike!;
    const likeOutcome = await executeActionJob(port, likeJob, {
      personDisplayName,
    });
    if (!likeOutcome.ok) {
      // Keep comment pending_approval so Inbox can re-approve.
      // Recovery skips this like while comment stays pending_approval.
      if (!options?.skipBriefRefresh) {
        await refreshBriefAfterMutation(repos);
      }
      return { ok: false, errorMessage: likeOutcome.errorMessage };
    }
    if (likeOutcome.softSkipped) {
      // CASE A: like alone, no button — not a failure; do not skip comment permanently as "done"
      await finishApproveSuccess(
        repos,
        approval,
        job,
        `like_unprocessed:${likeOutcome.skipReasonCode ?? "LIKE_BUTTON_NOT_AVAILABLE"}`,
      );
      if (!options?.skipBriefRefresh) {
        await refreshBriefAfterMutation(repos);
      }
      return { ok: true };
    }
    await skipJobQuietly(repos, job, "approval_mode_like_only");
    await finishApproveSuccess(repos, approval, job, "like");
    if (!options?.skipBriefRefresh) {
      await refreshBriefAfterMutation(repos);
    }
    return { ok: true };
  }

  // --- primary job is like (rare / future) ---
  if (job.action_type === "like") {
    const approvedJob = await repos.approval.markJobApproved(job.id, body);
    const outcome = await executeActionJob(port, approvedJob, {
      personDisplayName,
    });
    if (!outcome.ok) {
      if (!options?.skipBriefRefresh) {
        await refreshBriefAfterMutation(repos);
      }
      return { ok: false, errorMessage: outcome.errorMessage };
    }
    await finishApproveSuccess(repos, approval, job, "like");
    if (!options?.skipBriefRefresh) {
      await refreshBriefAfterMutation(repos);
    }
    return { ok: true };
  }

  // --- comment and/or both (and mutual / threads as plain execute) ---
  if (!runComment) {
    return { ok: false, errorMessage: `mode ${mode} did not select primary job` };
  }

  const approvedJob = await repos.approval.markJobApproved(job.id, body);
  const outcome = await executeActionJob(port, approvedJob, {
    personDisplayName,
  });

  if (!outcome.ok) {
    if (!options?.skipBriefRefresh) {
      await refreshBriefAfterMutation(repos);
    }
    return { ok: false, errorMessage: outcome.errorMessage };
  }

  if (outcome.excluded && job.action_type === "neighbor_request") {
    const msg =
      outcome.skipReasonMessage?.trim() || "서로이웃 신청을 건너뛰었습니다.";
    await repos.approval.resolve(approval.id);
    try {
      const ref = (job.target_ref ?? {}) as Record<string, unknown>;
      const blogId =
        typeof ref.blog_id === "string"
          ? ref.blog_id
          : typeof ref.blogId === "string"
            ? ref.blogId
            : null;
      if (blogId) {
        await repos.neighborExclusion.exclude({
          blog_id: blogId,
          blog_name:
            typeof ref.blog_name === "string" ? ref.blog_name : null,
          blog_url:
            typeof ref.blog_url === "string" ? ref.blog_url : null,
          note: `[${outcome.skipReasonCode ?? "EXCLUDED"}] ${msg}`,
        });
      }
    } catch (err) {
      console.warn(
        "[approveApproval] neighbor exclusion upsert:",
        err instanceof Error ? err.message : String(err),
      );
    }
    if (!options?.skipBriefRefresh) {
      await refreshBriefAfterMutation(repos);
    }
    return { ok: false, errorMessage: msg, excluded: true };
  }

  if (runLike && bundledLike) {
    const likeOutcome = await executeActionJob(port, bundledLike, {
      personDisplayName,
    });
    if (!likeOutcome.ok) {
      // Comment succeeded — resolve approval; like remains failed for recovery.
      await finishApproveSuccess(
        repos,
        approval,
        job,
        `comment · like_failed:${likeOutcome.errorMessage ?? "error"}`,
      );
      if (!options?.skipBriefRefresh) {
        await refreshBriefAfterMutation(repos);
      }
      return {
        ok: false,
        errorMessage: `댓글은 성공 · 공감 실패: ${likeOutcome.errorMessage ?? "error"}`,
      };
    }
    // CASE B: like soft-skipped (no button) — overall success with partial record
    if (likeOutcome.softSkipped) {
      await finishApproveSuccess(
        repos,
        approval,
        job,
        `comment+like_skipped:${likeOutcome.skipReasonCode ?? "LIKE_BUTTON_NOT_AVAILABLE"}`,
      );
      if (!options?.skipBriefRefresh) {
        await refreshBriefAfterMutation(repos);
      }
      return { ok: true };
    }
  } else if (runLike && findExecutedBundledLike(job, siblings)) {
    // like already executed in this bundle — skip duplicate
  } else if (mode === "comment" && bundledLike) {
    await skipJobQuietly(repos, bundledLike, "approval_mode_comment_only");
  } else if (mode === "both" && !bundledLike && job.action_type === "comment") {
    // Structure ready but no sibling — comment-only success
    // (or sibling already executed and excluded from findBundledLike)
  }

  const summaryMode =
    mode === "both" && bundledLike
      ? "comment+like"
      : job.action_type === "comment"
        ? "comment"
        : job.action_type;

  await finishApproveSuccess(repos, approval, job, summaryMode);
  if (!options?.skipBriefRefresh) {
    await refreshBriefAfterMutation(repos);
  }
  return { ok: true };
}

export type RetryFailedApprovalOptions = {
  /** UI-edited draft; falls back to failed job draft_body. */
  draftBody?: string;
  /** Override stored last_execute_mode. */
  mode?: ApprovalExecuteMode;
};

export type RetryFailedApprovalResult = {
  ok: true;
  approvalId: string;
  fromJobId: string;
  toJobId: string;
  attempt: number;
  mode: ApprovalExecuteMode | null;
  bundleId: string | null;
  previousError: string | null;
};

/**
 * Replace a failed primary ActionJob with a new pending_approval job and
 * repoint the open Approval. Does not mutate the failed job's status.
 * Does not auto-execute — caller / UI should approve afterward.
 */
export async function retryFailedApproval(
  approvalId: string,
  options?: RetryFailedApprovalOptions,
): Promise<RetryFailedApprovalResult> {
  const repos = createSupervisorRepos(createServiceClient());
  const approval = await repos.approval.getById(approvalId);
  if (!approval || approval.resolved_at) {
    throw new Error("Approval not found or already resolved");
  }

  const failedJob = await repos.approval.getActionJob(approval.action_job_id);
  if (failedJob.status !== "failed") {
    throw new Error(
      `retryFailedApproval: primary job must be failed (got ${failedJob.status})`,
    );
  }

  const siblings = failedJob.bundle_id
    ? await repos.approval.listJobsByBundleId(failedJob.bundle_id)
    : [];
  const hasBundledLike = Boolean(findBundledLike(failedJob, siblings));
  const available = resolveAvailableModes({
    actionType: failedJob.action_type,
    hasBundledLike:
      hasBundledLike || Boolean(findExecutedBundledLike(failedJob, siblings)),
  });
  const storedMode = readLastExecuteMode(approval.presented_context);
  const mode =
    options?.mode != null
      ? parseApprovalExecuteMode(options.mode, storedMode ?? "both")
      : storedMode ??
        (available.length > 0
          ? defaultApprovalExecuteMode(available)
          : null);

  const draftBody =
    options?.draftBody !== undefined
      ? options.draftBody.trim()
      : undefined;

  const newJob = await repos.approval.cloneFailedJobAsPendingApproval(
    failedJob,
    { draftBody },
  );

  await repos.approval.repointActionJob(approval.id, newJob.id);

  const history = readRetryHistory(approval.presented_context);
  const attempt = history.length + 1;
  const entry: ApprovalRetryHistoryEntry = {
    at: new Date().toISOString(),
    attempt,
    from_job_id: failedJob.id,
    to_job_id: newJob.id,
    previous_error: failedJob.error,
    mode,
    bundle_id: failedJob.bundle_id,
  };

  await repos.approval.updatePresentedContext(approval.id, {
    retry_history: [...history, entry],
    approval_retry_count: attempt,
    ...(mode ? { last_execute_mode: mode } : {}),
  });

  await repos.activity.insert({
    workflow_id: approval.workflow_id,
    person_id: approval.person_id,
    action_job_id: newJob.id,
    decision_id: newJob.decision_id,
    kind: "blocked",
    summary: `retry · attempt=${attempt} · ${failedJob.id.slice(0, 8)}→${newJob.id.slice(0, 8)} · ${failedJob.error?.slice(0, 120) ?? "failed"}`,
  });

  await refreshBriefAfterMutation(repos);

  return {
    ok: true,
    approvalId: approval.id,
    fromJobId: failedJob.id,
    toJobId: newJob.id,
    attempt,
    mode,
    bundleId: failedJob.bundle_id,
    previousError: failedJob.error,
  };
}

async function finishApproveSuccess(
  repos: SupervisorRepos,
  approval: { id: string; workflow_id: string; person_id: string },
  job: ActionJob,
  summaryAction: string,
): Promise<void> {
  const workflow = await repos.person.getWorkflow(approval.workflow_id);
  const stage = nextStageAfterApprove(workflow.current_stage);
  await repos.person.updateWorkflow(workflow.id, {
    current_stage: stage,
    current_state: "active",
    next_action: "none",
    waiting_until: null,
    waiting_for: null,
    blocked_reason: null,
  });
  await repos.person.updateRelationship(approval.person_id, { stage });

  await repos.activity.insert({
    workflow_id: workflow.id,
    person_id: approval.person_id,
    action_job_id: job.id,
    decision_id: job.decision_id,
    kind: "approved",
    summary: `승인 · ${summaryAction}`,
  });

  await repos.approval.resolve(approval.id);
  await repos.brief.incrementOutcomeCounters({
    approval_done_count: 1,
    time_saved_minutes_est: 0.3,
  });

  // Neighbor storage only — does not change ActionJob/CDP execute.
  if (job.action_type === "neighbor_request") {
    try {
      const { upsertAcceptedNeighborAfterRequest } = await import(
        "@/services/neighborAcceptedSync"
      );
      await upsertAcceptedNeighborAfterRequest(approval.person_id);
    } catch (err) {
      console.warn(
        "[finishApproveSuccess] neighbor accepted upsert:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

export type BatchApproveResult = {
  okIds: string[];
  failed: Array<{ id: string; errorMessage: string }>;
};

export type BatchApproveOptions = {
  mode?: ApprovalExecuteMode;
  /** @deprecated Prefer delayMinMs/delayMaxMs for random spacing. */
  intervalMs?: number;
  /** Random delay range min (ms) between batch items. */
  delayMinMs?: number;
  /** Random delay range max (ms) between batch items. */
  delayMaxMs?: number;
};

/**
 * Approval Inbox batch: selected Approvals → sequential ActionJob queue.
 * Delay: random between delayMinMs–delayMaxMs (or intervalMs fixed legacy),
 * else env 5–10s. Applied before each item after the first (success or fail).
 */
export async function approveApprovalsBatch(
  approvalIds: string[],
  batchOptions?: BatchApproveOptions,
): Promise<BatchApproveResult> {
  const uniqueIds = [...new Set(approvalIds.filter(Boolean))];
  const result: BatchApproveResult = { okIds: [], failed: [] };
  if (uniqueIds.length === 0) return result;

  const repos = createSupervisorRepos(createServiceClient());
  const delayOpts: BatchQueueDelayOptions =
    batchOptions?.delayMinMs != null || batchOptions?.delayMaxMs != null
      ? {
          minMs: batchOptions.delayMinMs,
          maxMs: batchOptions.delayMaxMs,
        }
      : batchOptions?.intervalMs != null
        ? { fixedMs: batchOptions.intervalMs }
        : {};

  for (let i = 0; i < uniqueIds.length; i++) {
    const id = uniqueIds[i]!;
    try {
      if (i > 0) {
        const waited = await applyBatchQueueDelay(delayOpts);
        console.log(
          `[approveApprovalsBatch] delay ${waited}ms before ${id.slice(0, 8)}`,
        );
      }

      const outcome = await approveApproval(id, undefined, {
        skipBriefRefresh: true,
        mode: batchOptions?.mode,
      });
      if (outcome.ok) {
        result.okIds.push(id);
      } else {
        result.failed.push({
          id,
          errorMessage: outcome.errorMessage ?? "execution_failed",
        });
      }
    } catch (err) {
      result.failed.push({
        id,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await refreshBriefAfterMutation(repos);
  return result;
}

/**
 * Spec: Reject → ActionJob rejected → Activity → Workflow risk/wait → resolve
 */
export async function rejectApproval(
  approvalId: string,
  reason?: string,
): Promise<void> {
  const repos = createSupervisorRepos(createServiceClient());
  const approval = await repos.approval.getById(approvalId);
  if (!approval || approval.resolved_at) {
    throw new Error("Approval not found or already resolved");
  }

  const job = await repos.approval.getActionJob(approval.action_job_id);
  await repos.approval.markJobRejected(job.id, reason ?? null);

  if (job.bundle_id) {
    const siblings = await repos.approval.listJobsByBundleId(job.bundle_id);
    for (const sibling of siblings) {
      if (sibling.id === job.id) continue;
      await skipJobQuietly(repos, sibling, "approval_rejected");
    }
  }

  const workflow = await repos.person.getWorkflow(approval.workflow_id);
  await repos.person.updateWorkflow(workflow.id, {
    current_stage: "risk",
    current_state: "waiting",
    waiting_until: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    waiting_for: "reject_cooldown",
    next_action: "observe",
  });
  await repos.person.updateRelationship(approval.person_id, { stage: "risk" });

  await repos.activity.insert({
    workflow_id: workflow.id,
    person_id: approval.person_id,
    action_job_id: job.id,
    decision_id: job.decision_id,
    kind: "rejected",
    summary: reason ? `거절 · ${reason}` : "거절",
  });

  await repos.approval.resolve(approval.id);
  await refreshBriefAfterMutation(repos);
}

/**
 * Spec: Snooze → pending kept · Workflow wait / priority↓
 */
export async function snoozeApproval(approvalId: string): Promise<void> {
  const repos = createSupervisorRepos(createServiceClient());
  const approval = await repos.approval.getById(approvalId);
  if (!approval || approval.resolved_at) {
    throw new Error("Approval not found or already resolved");
  }

  const workflow = await repos.person.getWorkflow(approval.workflow_id);
  const until = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
  await repos.person.updateWorkflow(workflow.id, {
    current_state: "waiting",
    waiting_until: until,
    waiting_for: "snooze",
    priority: Math.max(0, workflow.priority - 10),
  });

  await repos.activity.insert({
    workflow_id: workflow.id,
    person_id: approval.person_id,
    action_job_id: approval.action_job_id,
    decision_id: null,
    kind: "waiting",
    summary: `보류 · ${until}`,
  });

  await refreshBriefAfterMutation(repos);
}
