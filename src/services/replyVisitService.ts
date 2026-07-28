/**
 * Enqueue reply-visit (like + comment approval) for a relation neighbor.
 * Reuses enqueueApproval — does not modify like automation adapters.
 *
 * Payload mirrors the original Today 답방 button:
 * - comment: comment pending_approval (risk high) + companion like planned (risk low)
 * - like: like pending_approval (risk low) — same target_ref shape
 */

import "server-only";

import { fetchBlogRecentPostsViaRss } from "@/adapters/naver/naverBlogRss";
import { createServiceClient } from "@/lib/supabase";
import {
  createRepositories,
  createSupervisorRepos,
} from "@/repositories/index";
import type { DecisionOutput, Workflow } from "@/workers/types";
import { enqueueApproval } from "@/workers/approval";

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

export async function enqueueReplyVisit(input: {
  relationId?: string;
  personId?: string;
  blogId?: string;
  /** comment (default): comment approval + companion like. like: like-only approval. */
  mode?: "like" | "comment";
}): Promise<
  | {
      ok: true;
      approvalId: string;
      actionJobId: string;
      actionType: "like" | "comment";
      risk: "low" | "high";
      postUrl: string;
    }
  | { ok: false; error: string }
> {
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
    if (error) return { ok: false, error: error.message };
    if (!rel) return { ok: false, error: "relation_not_found" };
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

  if (!blogId) return { ok: false, error: "blog_id_required" };
  if (!personId) {
    const found = await workerRepos.findPersonIdByBlogId(blogId);
    personId = found ?? "";
  }
  if (!personId) return { ok: false, error: "person_not_found" };

  let postUrl = storedPostUrl;
  let postTitle = storedPostTitle ?? "최신글";
  let logNo = postUrl ? parseLogNoFromUrl(postUrl) : null;

  if (!postUrl || !logNo) {
    const posts = await fetchBlogRecentPostsViaRss(blogId, 1);
    const latest = posts[0];
    if (!latest?.postUrl) {
      return { ok: false, error: "latest_post_not_found" };
    }
    postUrl = latest.postUrl;
    postTitle = latest.title || postTitle;
    logNo = latest.logNo || parseLogNoFromUrl(postUrl);
  }
  if (!postUrl || !logNo) {
    return { ok: false, error: "latest_post_not_found" };
  }

  let workflow = (await workerRepos.getActiveWorkflow(
    personId,
  )) as Workflow | null;
  if (!workflow) {
    workflow = (await workerRepos.createWorkflow({
      person_id: personId,
      current_stage: "early_relationship",
      current_state: "active",
      next_action: "comment",
      last_decision_id: null,
      priority: 85,
      goal: "reply_queue",
    })) as Workflow;
    await workerRepos.setPersonActiveWorkflow(personId, workflow.id);
  }

  // Same target_ref shape as the original Today 답방 button.
  const mode = input.mode === "like" ? "like" : "comment";
  const actionType = mode;
  const risk = mode === "like" ? ("low" as const) : ("high" as const);
  const reasonShort =
    mode === "like" ? "답방 · 공감" : "답방 · 교류 이웃 최신글";

  const targetRef = {
    blog_id: blogId,
    log_no: logNo,
    post_id: logNo,
    post_url: postUrl,
    title: postTitle,
    source: "reply_queue",
    reply_queue: true,
  };

  try {
    const record = await workerRepos.insertDecision({
      person_id: personId,
      workflow_id: workflow.id,
      perception_event_id: null,
      decision_type: "create_approval",
      reason_short: reasonShort,
      reason_detail: {
        explanation: "이웃관리 답방에서 생성",
        reasons: [
          "최근 3일 관계 분석",
          mode === "like" ? "공감 답방" : "댓글 답방",
        ],
        rule_ids: ["ui.reply_queue"],
      },
      inputs: { source: "reply_queue", mode },
    });

    const output: Extract<DecisionOutput, { kind: "create_approval" }> = {
      kind: "create_approval",
      reason_short: reasonShort,
      explanation:
        mode === "like"
          ? "관계 분석 기반 답방 (공감)"
          : "관계 분석 기반 답방 (공감 + 댓글)",
      reasons: ["교류 이웃", "최신 게시글"],
      rule_ids: ["ui.reply_queue"],
      workflow_patch: {
        next_action: "none",
        blocked_reason: null,
      },
      draft: {
        // comment: identical to original Today 답방 (companion like via enqueueApproval)
        // like: like-only with risk low (risk matrix)
        action_type: actionType,
        channel: "blog",
        body: mode === "like" ? "" : "포스팅 잘 보고 갑니다.",
        alternatives: [],
        target_ref: targetRef,
      },
    };

    const { job, approval } = await enqueueApproval(
      workerRepos,
      workflow,
      output,
      record,
    );

    console.info("[reply_visit]", {
      actionType: job.action_type,
      approvalId: approval.id,
      actionJobId: job.id,
      risk: job.risk,
      mode,
      blogId,
      personId,
      postUrl,
      bundleId: job.bundle_id ?? null,
    });

    await db
      .from("reply_queue")
      .update({
        processed: true,
        processed_at: new Date().toISOString(),
      })
      .eq("person_id", personId);

    return {
      ok: true,
      approvalId: approval.id,
      actionJobId: job.id,
      actionType,
      risk,
      postUrl,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[reply_visit] enqueue failed", {
      mode,
      actionType,
      risk,
      blogId,
      personId,
      postUrl,
      error: message,
    });
    return { ok: false, error: message };
  }
}
