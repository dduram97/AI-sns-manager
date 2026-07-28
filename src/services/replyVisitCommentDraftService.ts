/**
 * Reply-visit comment drafts — AI generate + human review (not approval inbox).
 */

import "server-only";

import { createServiceClient } from "@/lib/supabase";
import {
  commentStyleFromPolicy,
  generateCommentDraftForPost,
} from "@/services/commentDraftService";
import { createRepositories } from "@/repositories/index";
import {
  executeReplyVisitCommentWithBody,
  resolveReplyVisitTargetForExecute,
} from "@/services/replyVisitExecuteService";

export type ReplyCommentDraftStatus = "draft" | "approved" | "executed";

export type ReplyCommentDraft = {
  id: string;
  taskId: string;
  blogId: string;
  personId: string | null;
  relationId: string | null;
  postUrl: string;
  postTitle: string | null;
  generatedComment: string;
  editedComment: string;
  status: ReplyCommentDraftStatus;
  updatedAt: string;
};

function mapDraft(row: Record<string, unknown>): ReplyCommentDraft {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    blogId: String(row.blog_id),
    personId: row.person_id ? String(row.person_id) : null,
    relationId: row.relation_id ? String(row.relation_id) : null,
    postUrl: String(row.post_url ?? ""),
    postTitle:
      typeof row.post_title === "string" ? row.post_title : null,
    generatedComment: String(row.generated_comment ?? ""),
    editedComment: String(row.edited_comment ?? ""),
    status: (row.status as ReplyCommentDraftStatus) || "draft",
    updatedAt: String(row.updated_at ?? row.created_at ?? ""),
  };
}

export async function getReplyCommentDraftByTaskId(
  taskId: string,
): Promise<ReplyCommentDraft | null> {
  const db = createServiceClient();
  const { data, error } = await db
    .from("reply_comment_drafts")
    .select(
      "id, task_id, blog_id, person_id, relation_id, post_url, post_title, generated_comment, edited_comment, status, updated_at, created_at",
    )
    .eq("task_id", taskId)
    .maybeSingle();
  if (error) {
    if (/schema cache|does not exist|relation/i.test(error.message)) {
      return null;
    }
    throw new Error(`reply_comment_drafts.get: ${error.message}`);
  }
  if (!data) return null;
  return mapDraft(data as Record<string, unknown>);
}

export async function listCommentDraftStatusesByTaskIds(
  taskIds: string[],
): Promise<Map<string, "none" | "draft" | "executed">> {
  const map = new Map<string, "none" | "draft" | "executed">();
  if (taskIds.length === 0) return map;
  const db = createServiceClient();
  const { data, error } = await db
    .from("reply_comment_drafts")
    .select("task_id, status")
    .in("task_id", taskIds);
  if (error) {
    if (/schema cache|does not exist|relation/i.test(error.message)) {
      return map;
    }
    throw new Error(`reply_comment_drafts.listStatuses: ${error.message}`);
  }
  for (const row of data ?? []) {
    const id = String((row as { task_id?: string }).task_id ?? "");
    if (!id) continue;
    const raw = String((row as { status?: string }).status ?? "");
    if (raw === "executed") map.set(id, "executed");
    else if (raw === "draft" || raw === "approved") map.set(id, "draft");
  }
  return map;
}

/** @deprecated prefer listCommentDraftStatusesByTaskIds */
export async function listDraftTaskIds(
  taskIds: string[],
): Promise<Set<string>> {
  const statuses = await listCommentDraftStatusesByTaskIds(taskIds);
  const set = new Set<string>();
  for (const [id, status] of statuses) {
    if (status === "draft") set.add(id);
  }
  return set;
}

/**
 * Generate (or regenerate) AI comment draft and upsert reply_comment_drafts.
 * Does NOT post to Naver.
 */
export async function generateReplyCommentDraft(input: {
  taskId: string;
  relationId?: string;
  personId?: string;
  blogId?: string;
}): Promise<
  | { ok: true; draft: ReplyCommentDraft }
  | { ok: false; error: string }
> {
  const taskId = input.taskId?.trim();
  if (!taskId) return { ok: false, error: "task_id_required" };

  const resolved = await resolveReplyVisitTargetForExecute({
    relationId: input.relationId,
    personId: input.personId,
    blogId: input.blogId,
  });
  if ("error" in resolved) return { ok: false, error: resolved.error };

  let generated = "포스팅 잘 보고 갑니다.";
  try {
    const repos = createRepositories(createServiceClient());
    const policy = await repos.getPolicy();
    const style = commentStyleFromPolicy(policy);
    const result = await generateCommentDraftForPost({
      title: resolved.postTitle || "새 글",
      content: resolved.postTitle || "새 글",
      styleExamples: style.styleExamples,
      toneBase: style.toneBase,
      bannedPhrases: style.bannedPhrases,
      blogId: resolved.blogId,
    });
    if (result.body?.trim()) generated = result.body.trim();
    console.info("[reply_visit][draft] generated", {
      taskId,
      source: result.source,
      model: result.model,
      bodyLength: generated.length,
    });
  } catch (err) {
    console.warn(
      "[reply_visit][draft] AI failed, using template",
      err instanceof Error ? err.message : err,
    );
  }

  const nowIso = new Date().toISOString();
  const db = createServiceClient();
  const row = {
    task_id: taskId,
    blog_id: resolved.blogId,
    person_id: resolved.personId || null,
    relation_id: input.relationId?.trim() || null,
    post_url: resolved.postUrl,
    post_title: resolved.postTitle,
    generated_comment: generated,
    edited_comment: generated,
    status: "draft" as const,
    updated_at: nowIso,
  };

  const { data, error } = await db
    .from("reply_comment_drafts")
    .upsert(row, { onConflict: "task_id" })
    .select(
      "id, task_id, blog_id, person_id, relation_id, post_url, post_title, generated_comment, edited_comment, status, updated_at, created_at",
    )
    .single();

  if (error) {
    console.error("[reply_visit][draft] upsert failed", error.message);
    return { ok: false, error: error.message };
  }

  return { ok: true, draft: mapDraft(data as Record<string, unknown>) };
}

export async function saveReplyCommentDraftEdit(input: {
  draftId: string;
  editedComment: string;
}): Promise<
  | { ok: true; draft: ReplyCommentDraft }
  | { ok: false; error: string }
> {
  const draftId = input.draftId?.trim();
  const edited = input.editedComment?.trim() ?? "";
  if (!draftId) return { ok: false, error: "draft_id_required" };
  if (!edited) return { ok: false, error: "comment_empty" };

  const db = createServiceClient();
  const { data, error } = await db
    .from("reply_comment_drafts")
    .update({
      edited_comment: edited,
      updated_at: new Date().toISOString(),
    })
    .eq("id", draftId)
    .neq("status", "executed")
    .select(
      "id, task_id, blog_id, person_id, relation_id, post_url, post_title, generated_comment, edited_comment, status, updated_at, created_at",
    )
    .maybeSingle();

  if (error) return { ok: false, error: error.message };
  if (!data) {
    const { data: row } = await db
      .from("reply_comment_drafts")
      .select("status")
      .eq("id", draftId)
      .maybeSingle();
    if (!row) return { ok: false, error: "draft_not_found" };
    if (String(row.status) === "executed") {
      return { ok: false, error: "draft_already_executed" };
    }
    return { ok: false, error: "draft_not_found" };
  }
  console.info("[reply_visit][draft] edited", {
    draftId,
    bodyLength: edited.length,
  });
  return { ok: true, draft: mapDraft(data as Record<string, unknown>) };
}

/**
 * User confirmed register — post to Naver with edited body, mark draft executed.
 * Does NOT complete reply_visit_tasks.
 */
export async function submitReplyCommentDraft(input: {
  draftId: string;
  editedComment: string;
}): Promise<
  | { ok: true; actionJobId: string; postUrl: string; draftBody: string }
  | { ok: false; error: string }
> {
  const draftId = input.draftId?.trim();
  const edited = input.editedComment?.trim() ?? "";
  if (!draftId) return { ok: false, error: "draft_id_required" };
  if (!edited) return { ok: false, error: "comment_empty" };

  const db = createServiceClient();
  const { data: row, error } = await db
    .from("reply_comment_drafts")
    .select(
      "id, task_id, blog_id, person_id, relation_id, post_url, post_title, status",
    )
    .eq("id", draftId)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!row) return { ok: false, error: "draft_not_found" };

  const currentStatus = String(row.status ?? "");
  if (currentStatus === "executed") {
    return { ok: false, error: "draft_already_executed" };
  }

  const blogId = String(row.blog_id ?? "");
  const personId = row.person_id ? String(row.person_id) : undefined;
  const relationId = row.relation_id ? String(row.relation_id) : undefined;

  // Atomic claim: only one submit may move draft → approved.
  const { data: claimed, error: claimErr } = await db
    .from("reply_comment_drafts")
    .update({
      edited_comment: edited,
      status: "approved",
      updated_at: new Date().toISOString(),
    })
    .eq("id", draftId)
    .eq("status", "draft")
    .select("id")
    .maybeSingle();
  if (claimErr) return { ok: false, error: claimErr.message };
  if (!claimed) {
    if (currentStatus === "approved") {
      return { ok: false, error: "draft_submit_in_progress" };
    }
    return { ok: false, error: "draft_already_executed" };
  }

  console.info("[reply_visit][draft] submit start", {
    draftId,
    blogId,
    bodyLength: edited.length,
  });

  const posted = await executeReplyVisitCommentWithBody({
    relationId,
    personId,
    blogId,
    commentBody: edited,
  });

  if (!posted.ok) {
    await db
      .from("reply_comment_drafts")
      .update({
        status: "draft",
        updated_at: new Date().toISOString(),
      })
      .eq("id", draftId);
    console.error("[reply_visit][draft] submit failed", {
      draftId,
      blogId,
      error: posted.error,
    });
    return posted;
  }

  await db
    .from("reply_comment_drafts")
    .update({
      status: "executed",
      edited_comment: edited,
      updated_at: new Date().toISOString(),
    })
    .eq("id", draftId);

  console.info("[reply_visit][draft] submit success", {
    draftId,
    actionJobId: posted.actionJobId,
    blogId,
  });

  return {
    ok: true,
    actionJobId: posted.actionJobId,
    postUrl: posted.postUrl,
    draftBody: edited,
  };
}
