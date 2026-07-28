/**
 * Reply-visit immediate execution (no Approval inbox).
 * Reuses ActionJob + executeActionJob → NaverBlogAdapter (same as low-risk / approve paths).
 * Does not modify like.ts / sympathy.ts / adapter internals.
 */

import "server-only";

import {
  executeActionJob,
  type ActionExecutionPort,
} from "@/adapters/executeActionJob";
import { fetchBlogRecentPostsViaRss } from "@/adapters/naver/naverBlogRss";
import { createServiceClient } from "@/lib/supabase";
import {
  createRepositories,
  createSupervisorRepos,
} from "@/repositories/index";
import type { ActionJob, Workflow } from "@/workers/types";

function parseLogNoFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    const last = parts[parts.length - 1] ?? "";
    if (/^\d+$/.test(last)) return last;
    const q = u.searchParams.get("logNo");
    return q && /^\d+$/.test(q) ? q : null;
  } catch {
    return null;
  }
}

function toPort(
  repos: ReturnType<typeof createRepositories>,
): ActionExecutionPort {
  return {
    markJobRunning: (jobId) => repos.markActionRunning(jobId),
    markJobExecuted: (jobId) => repos.markActionExecuted(jobId),
    markJobFailed: (jobId, message) => repos.markActionFailed(jobId, message),
    markJobSkipped: (jobId, input) => repos.markActionSkipped(jobId, input),
    updateRelationship: (personId, patch) =>
      repos.updateRelationship(personId, patch),
    updateWorkflow: (workflowId, patch) =>
      repos.updateWorkflow(workflowId, patch),
    insertActivity: (input) => repos.insertActivity(input),
    incrementOutcomeCounters: (deltas) =>
      repos.incrementOutcomeCounters(deltas),
    getPolicy: () => repos.getPolicy(),
    getOutcomeToday: () => repos.ensureOutcomeToday(),
    findRecentExecutedByPerson: (personId, actionType, limit) =>
      repos.findRecentExecutedByPerson(personId, actionType, limit),
  };
}

type ResolvedTarget = {
  personId: string;
  blogId: string;
  postUrl: string;
  postTitle: string;
  logNo: string;
  workflow: Workflow;
};

export async function resolveReplyVisitTargetForExecute(input: {
  relationId?: string;
  personId?: string;
  blogId?: string;
}): Promise<ResolvedTarget | { error: string }> {
  const db = createServiceClient();
  const repos = createSupervisorRepos(db);
  const workerRepos = createRepositories(db);

  let personId = input.personId?.trim() || "";
  let blogId = input.blogId?.trim() || "";
  let storedPostUrl: string | null = null;
  let storedPostTitle: string | null = null;

  if (input.relationId) {
    const { data: rel, error } = await db
      .from("blog_relations")
      .select(
        "id, person_id, blog_id, user_id, latest_post_url, latest_post_title",
      )
      .eq("id", input.relationId)
      .maybeSingle();
    if (error) return { error: error.message };
    if (!rel) return { error: "relation_not_found" };
    personId = personId || String(rel.person_id ?? "");
    blogId = blogId || String(rel.blog_id ?? rel.user_id ?? "");
    storedPostUrl =
      typeof rel.latest_post_url === "string" ? rel.latest_post_url : null;
    storedPostTitle =
      typeof rel.latest_post_title === "string" ? rel.latest_post_title : null;
  }

  if (!blogId && personId) {
    const person = await repos.person.getById(personId);
    if (person) {
      const meta = person.discover_meta ?? {};
      blogId =
        (typeof meta.blog_id === "string" && meta.blog_id.trim()) ||
        (typeof meta.blogId === "string" && meta.blogId.trim()) ||
        "";
    }
  }

  if (!blogId) return { error: "blog_id_required" };
  if (!personId) {
    const found = await workerRepos.findPersonIdByBlogId(blogId);
    personId = found ?? "";
  }
  if (!personId) return { error: "person_not_found" };

  let postUrl = storedPostUrl;
  let postTitle = storedPostTitle ?? "최신글";
  let logNo = postUrl ? parseLogNoFromUrl(postUrl) : null;

  if (!postUrl || !logNo) {
    const posts = await fetchBlogRecentPostsViaRss(blogId, 1);
    const latest = posts[0];
    if (!latest?.postUrl) return { error: "latest_post_not_found" };
    postUrl = latest.postUrl;
    postTitle = latest.title || postTitle;
    logNo = latest.logNo || parseLogNoFromUrl(postUrl);
  }
  if (!postUrl || !logNo) return { error: "latest_post_not_found" };

  let workflow = (await workerRepos.getActiveWorkflow(
    personId,
  )) as Workflow | null;
  if (!workflow) {
    workflow = (await workerRepos.createWorkflow({
      person_id: personId,
      current_stage: "early_relationship",
      current_state: "active",
      next_action: "none",
      last_decision_id: null,
      priority: 85,
      goal: "reply_queue",
    })) as Workflow;
    await workerRepos.setPersonActiveWorkflow(personId, workflow.id);
  }

  return {
    personId,
    blogId,
    postUrl,
    postTitle,
    logNo,
    workflow,
  };
}

function targetRef(target: ResolvedTarget): Record<string, unknown> {
  return {
    blog_id: target.blogId,
    log_no: target.logNo,
    post_id: target.logNo,
    post_url: target.postUrl,
    title: target.postTitle,
    source: "reply_visit_immediate",
    reply_visit: true,
  };
}

export type ReplyVisitExecuteResult =
  | {
      ok: true;
      actionType: "like" | "comment";
      actionJobId: string;
      postUrl: string;
      draftBody?: string;
    }
  | { ok: false; error: string };

/**
 * Immediate like — planned ActionJob → executeActionJob (no Approval).
 */
export async function executeReplyVisitLike(input: {
  relationId?: string;
  personId?: string;
  blogId?: string;
}): Promise<ReplyVisitExecuteResult> {
  const resolved = await resolveReplyVisitTargetForExecute(input);
  if ("error" in resolved) {
    console.warn("[reply_visit][like] resolve failed", resolved.error);
    return { ok: false, error: resolved.error };
  }

  const workerRepos = createRepositories(createServiceClient());
  const port = toPort(workerRepos);

  let planned: ActionJob;
  try {
    planned = await workerRepos.createActionJob({
      parent_workflow_id: resolved.workflow.id,
      person_id: resolved.personId,
      channel: "blog",
      action_type: "like",
      risk: "low",
      status: "planned",
      target_ref: targetRef(resolved),
      decision_id: null,
      inbox_priority: 0,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[reply_visit][like] createActionJob failed", message);
    return { ok: false, error: message };
  }

  console.info("[reply_visit][like] start", {
    actionJobId: planned.id,
    blogId: resolved.blogId,
  });

  const outcome = await executeActionJob(port, planned);
  if (!outcome.ok) {
    console.error("[reply_visit][like] failed", {
      actionJobId: outcome.job.id,
      blogId: resolved.blogId,
      error: outcome.errorMessage,
    });
    return {
      ok: false,
      error: outcome.errorMessage || "like_execute_failed",
    };
  }

  console.info("[reply_visit][like] success", {
    actionJobId: outcome.job.id,
    blogId: resolved.blogId,
  });

  return {
    ok: true,
    actionType: "like",
    actionJobId: outcome.job.id,
    postUrl: resolved.postUrl,
  };
}

/**
 * Post comment with a user-reviewed body (no AI step, no Approval).
 * Does not mark reply_visit_tasks completed.
 */
export async function executeReplyVisitCommentWithBody(input: {
  relationId?: string;
  personId?: string;
  blogId?: string;
  commentBody: string;
}): Promise<ReplyVisitExecuteResult> {
  const commentBody = input.commentBody?.trim() ?? "";
  if (!commentBody) return { ok: false, error: "comment_empty" };

  const resolved = await resolveReplyVisitTargetForExecute(input);
  if ("error" in resolved) {
    console.warn("[reply_visit][comment] resolve failed", resolved.error);
    return { ok: false, error: resolved.error };
  }

  const workerRepos = createRepositories(createServiceClient());
  const port = toPort(workerRepos);

  let planned: ActionJob;
  try {
    planned = await workerRepos.createActionJob({
      parent_workflow_id: resolved.workflow.id,
      person_id: resolved.personId,
      channel: "blog",
      action_type: "comment",
      risk: "high",
      status: "planned",
      draft_body: commentBody,
      draft_alternatives: [],
      target_ref: {
        ...targetRef(resolved),
        content_summary: resolved.postTitle,
      },
      decision_id: null,
      inbox_priority: 0,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[reply_visit][comment] createActionJob failed", message);
    return { ok: false, error: message };
  }

  console.info("[reply_visit][comment] start", {
    actionJobId: planned.id,
    blogId: resolved.blogId,
    bodyLength: commentBody.length,
  });

  const outcome = await executeActionJob(port, planned);
  if (!outcome.ok) {
    console.error("[reply_visit][comment] failed", {
      actionJobId: outcome.job.id,
      blogId: resolved.blogId,
      error: outcome.errorMessage,
    });
    return {
      ok: false,
      error: outcome.errorMessage || "comment_execute_failed",
    };
  }

  console.info("[reply_visit][comment] success", {
    actionJobId: outcome.job.id,
    blogId: resolved.blogId,
  });

  return {
    ok: true,
    actionType: "comment",
    actionJobId: outcome.job.id,
    postUrl: resolved.postUrl,
    draftBody: commentBody,
  };
}

