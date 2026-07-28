"use server";

import { revalidatePath } from "next/cache";
import { executeReplyVisitLike } from "@/services/replyVisitExecuteService";
import {
  generateReplyCommentDraft,
  getReplyCommentDraftByTaskId,
  saveReplyCommentDraftEdit,
  submitReplyCommentDraft,
  type ReplyCommentDraft,
} from "@/services/replyVisitCommentDraftService";
import {
  completeReplyVisitTask,
  getReplyVisitSummary,
  listReplyVisitTasks,
  snoozeReplyVisitTask,
  type ReplyVisitSummary,
  type ReplyVisitTaskItem,
} from "@/services/replyVisitTaskService";

export async function getReplyVisitSummaryAction(): Promise<ReplyVisitSummary> {
  return getReplyVisitSummary();
}

/** Pending + completed (snoozed excluded). Split in UI by status. */
export async function listReplyVisitTasksAction(): Promise<{
  items: ReplyVisitTaskItem[];
  summary: ReplyVisitSummary;
}> {
  return listReplyVisitTasks({ includeCompleted: true, includeSnoozed: false });
}

export async function completeReplyVisitTaskAction(
  taskId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const id = taskId?.trim();
  if (!id) return { ok: false, error: "task_id_required" };
  const result = await completeReplyVisitTask(id);
  if (result.ok) {
    revalidatePath("/neighbors");
    revalidatePath("/neighbors/reply");
  }
  return result;
}

export async function snoozeReplyVisitTaskAction(
  taskId: string,
): Promise<{ ok: true; snoozedUntil: string } | { ok: false; error: string }> {
  const id = taskId?.trim();
  if (!id) return { ok: false, error: "task_id_required" };
  const result = await snoozeReplyVisitTask(id);
  if (result.ok) {
    revalidatePath("/neighbors");
    revalidatePath("/neighbors/reply");
  }
  return result;
}

export async function executeReplyVisitLikeAction(input: {
  taskId: string;
  relationId?: string;
  personId?: string;
  blogId?: string;
}): Promise<
  | { ok: true; actionJobId: string; postUrl: string }
  | { ok: false; error: string }
> {
  const result = await executeReplyVisitLike({
    relationId: input.relationId,
    personId: input.personId,
    blogId: input.blogId,
  });
  if (!result.ok) return result;
  revalidatePath("/neighbors/reply");
  return {
    ok: true,
    actionJobId: result.actionJobId,
    postUrl: result.postUrl,
  };
}

/** Load existing draft or generate a new one (no Naver post). */
export async function prepareReplyCommentDraftAction(input: {
  taskId: string;
  relationId?: string;
  personId?: string;
  blogId?: string;
  regenerate?: boolean;
}): Promise<
  | { ok: true; draft: ReplyCommentDraft }
  | { ok: false; error: string }
> {
  const taskId = input.taskId?.trim();
  if (!taskId) return { ok: false, error: "task_id_required" };

  if (!input.regenerate) {
    const existing = await getReplyCommentDraftByTaskId(taskId);
    if (existing && existing.status === "draft") {
      return { ok: true, draft: existing };
    }
  }

  const result = await generateReplyCommentDraft({
    taskId,
    relationId: input.relationId,
    personId: input.personId,
    blogId: input.blogId,
  });
  if (result.ok) revalidatePath("/neighbors/reply");
  return result;
}

export async function regenerateReplyCommentDraftAction(input: {
  taskId: string;
  relationId?: string;
  personId?: string;
  blogId?: string;
}): Promise<
  | { ok: true; draft: ReplyCommentDraft }
  | { ok: false; error: string }
> {
  return prepareReplyCommentDraftAction({ ...input, regenerate: true });
}

export async function saveReplyCommentDraftAction(input: {
  draftId: string;
  editedComment: string;
}): Promise<
  | { ok: true; draft: ReplyCommentDraft }
  | { ok: false; error: string }
> {
  return saveReplyCommentDraftEdit(input);
}

/** User confirmed — post comment to Naver. Does not complete the visit task. */
export async function submitReplyCommentDraftAction(input: {
  draftId: string;
  editedComment: string;
}): Promise<
  | { ok: true; actionJobId: string; postUrl: string; draftBody: string }
  | { ok: false; error: string }
> {
  const result = await submitReplyCommentDraft(input);
  if (result.ok) revalidatePath("/neighbors/reply");
  return result;
}
