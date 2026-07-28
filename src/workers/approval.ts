/**
 * Approval Queue — Workflow layer creates ActionJob + ApprovalItem in Postgres.
 * Mutual-request cards get recommend context from Person.discover_meta + warming counts.
 * Comment approvals: AI draft from policy style examples + situation → draft_body.
 * Also creates a planned like sibling under the same bundle_id.
 */

import { randomUUID } from "node:crypto";
import {
  commentStyleFromPolicy,
  generateCommentDraftForPost,
} from "../services/commentDraftService";
import type { Repositories } from "../repositories/index";
import type {
  ActionJob,
  ActionRisk,
  ActionType,
  ApprovalItem,
  DecisionOutput,
  DecisionRecord,
  Workflow,
} from "./types";

/** Matches action_jobs_risk_matrix: visit/like → low, comment/request/reply → high. */
function riskForActionType(actionType: ActionType | string): ActionRisk {
  if (actionType === "like" || actionType === "visit") return "low";
  return "high";
}

async function buildMutualRequestContext(
  repos: Repositories,
  workflow: Workflow,
  output: Extract<DecisionOutput, { kind: "create_approval" }>,
): Promise<Record<string, unknown>> {
  const person = await repos.getPerson(workflow.person_id);
  const meta = person?.discover_meta ?? {};
  const jobs = await repos.listRecentActionJobs(workflow.person_id, 40);
  const visitCount = jobs.filter(
    (j) => j.action_type === "visit" && j.status === "executed",
  ).length;
  const likeCount = jobs.filter(
    (j) => j.action_type === "like" && j.status === "executed",
  ).length;

  const reasons: string[] = [];
  const matched = meta.matched_keywords;
  if (Array.isArray(matched) && matched.length > 0) {
    reasons.push(`키워드 일치: ${matched.join(", ")}`);
  } else if (Array.isArray(meta.reasons)) {
    for (const r of meta.reasons) {
      if (typeof r === "string" && r.includes("키워드")) reasons.push(r);
    }
  }
  if (meta.recently_active === true) {
    reasons.push("최근 활동");
  }
  reasons.push(`워밍 횟수: 방문 ${visitCount} · 공감 ${likeCount}`);

  return {
    reason_short: output.reason_short,
    rule_ids: output.rule_ids,
    stage: workflow.current_stage,
    draft: output.draft,
    approval_kind: "mutual_request",
    blog_name: person?.display_name ?? "블로그",
    blog_id: typeof meta.blog_id === "string" ? meta.blog_id : null,
    recommend_reasons: reasons,
    warming: { visit: visitCount, like: likeCount },
  };
}

function postContextFromTarget(target_ref: Record<string, unknown>): {
  title: string;
  content: string;
} {
  const title =
    (typeof target_ref.title === "string" && target_ref.title) ||
    (typeof target_ref.post_title === "string" && target_ref.post_title) ||
    "";
  const content =
    (typeof target_ref.content_summary === "string" &&
      target_ref.content_summary) ||
    (typeof target_ref.content_excerpt === "string" &&
      target_ref.content_excerpt) ||
    (typeof target_ref.content === "string" && target_ref.content) ||
    "";
  return { title, content };
}

export async function enqueueApproval(
  repos: Repositories,
  workflow: Workflow,
  output: Extract<DecisionOutput, { kind: "create_approval" }>,
  record: DecisionRecord,
): Promise<{ job: ActionJob; approval: ApprovalItem }> {
  const person = await repos.getPerson(workflow.person_id);
  const target_ref: Record<string, unknown> = {
    ...output.draft.target_ref,
    blog_id: output.draft.target_ref?.blog_id ?? person?.discover_meta?.blog_id,
    blog_url:
      output.draft.target_ref?.blog_url ?? person?.discover_meta?.blog_url,
  };

  const isComment = output.draft.action_type === "comment";
  const bundle_id = isComment ? randomUUID() : null;

  let draft_body = output.draft.body;
  let draft_alternatives = output.draft.alternatives;
  let commentMeta: Record<string, unknown> = {};

  // Neighbor-feed bulk collect: keep template body (skip per-post OpenAI).
  // Inbox still allows editing before execute — ActionJob/Approval shape unchanged.
  const skipAiDraft =
    target_ref.neighbor_feed === true || target_ref.source === "neighbor_feed";

  if (isComment && !skipAiDraft) {
    try {
      const policy = await repos.getPolicy();
      const style = commentStyleFromPolicy(policy);
      const { title, content } = postContextFromTarget(target_ref);
      const generated = await generateCommentDraftForPost({
        title: title || "새 글",
        content: content || title || output.reason_short,
        styleExamples: style.styleExamples,
        toneBase: style.toneBase,
        bannedPhrases: style.bannedPhrases,
      });
      draft_body = generated.body;
      draft_alternatives =
        generated.alternatives.length > 0
          ? generated.alternatives
          : output.draft.alternatives;
      target_ref.comment_situation = generated.situation;
      target_ref.ai_draft_source = generated.source;
      if (generated.model) target_ref.ai_draft_model = generated.model;
      if (generated.draftMeta) {
        target_ref.comment_draft = generated.draftMeta;
      }
      commentMeta = {
        comment_situation: generated.situation,
        ai_draft_source: generated.source,
        ai_draft_model: generated.model,
        post_title: title || null,
        post_summary: content ? content.slice(0, 280) : null,
        ...(generated.draftMeta
          ? { comment_draft: generated.draftMeta }
          : {}),
      };
    } catch (err) {
      console.warn(
        "[enqueueApproval] AI draft failed, using decision template:",
        err instanceof Error ? err.message : String(err),
      );
    }
  } else if (isComment && skipAiDraft) {
    const { title, content } = postContextFromTarget(target_ref);
    target_ref.ai_draft_source = "neighbor_feed_template";
    commentMeta = {
      ai_draft_source: "neighbor_feed_template",
      post_title: title || null,
      post_summary: content ? content.slice(0, 280) : null,
      published_at:
        typeof target_ref.published_at === "string"
          ? target_ref.published_at
          : null,
    };
  }

  const primaryRisk = riskForActionType(output.draft.action_type);
  const job = await repos.createActionJob({
    parent_workflow_id: workflow.id,
    person_id: workflow.person_id,
    channel: output.draft.channel,
    action_type: output.draft.action_type,
    risk: primaryRisk,
    status: "pending_approval",
    draft_body,
    draft_alternatives,
    target_ref,
    decision_id: record.id,
    inbox_priority: workflow.priority,
    bundle_id,
  });

  if (isComment && bundle_id) {
    await repos.createActionJob({
      parent_workflow_id: workflow.id,
      person_id: workflow.person_id,
      channel: output.draft.channel,
      action_type: "like",
      risk: riskForActionType("like"),
      status: "planned",
      target_ref: {
        ...target_ref,
        bundle_hold: true,
        awaiting_approval_mode: true,
      },
      decision_id: record.id,
      inbox_priority: 0,
      bundle_id,
    });
  }

  const isLikeOnly = output.draft.action_type === "like";
  const presented_context =
    output.draft.action_type === "neighbor_request"
      ? await buildMutualRequestContext(repos, workflow, output)
      : {
          reason_short: output.reason_short,
          rule_ids: output.rule_ids,
          stage: workflow.current_stage,
          draft: {
            ...output.draft,
            body: draft_body,
            alternatives: draft_alternatives,
          },
          ...commentMeta,
          ...(bundle_id
            ? {
                bundle_id,
                available_modes: ["comment", "like", "both"],
              }
            : isLikeOnly
              ? { available_modes: ["like"] }
              : {}),
        };

  const approval = await repos.createApproval({
    workflow_id: workflow.id,
    action_job_id: job.id,
    person_id: workflow.person_id,
    inbox_priority: workflow.priority,
    presented_context,
  });

  await repos.incrementOutcomeCounters({ approval_pending_count: 1 });

  return { job, approval };
}
