/**
 * One-shot: UI fixture for Approval Inbox modes (comment / like / both).
 * No Naver execution. verify-tagged for cleanup.
 *
 *   npx tsx scripts/seed-approval-modes-ui.ts
 *   npm run verify:loop:clean -- --run <test_run_id>
 */

import { randomUUID } from "node:crypto";
import { createServiceClient } from "../src/lib/supabase";
import { createSupervisorRepos } from "../src/repositories/index";
import { buildVerifyDiscoverMeta, newTestRunId } from "./verifyMeta";

async function main() {
  const db = createServiceClient();
  const testRunId = newTestRunId();
  const caseId = "approval_modes_ui";
  const blogId = "ui_test_blog";
  const logNo = "999000111";
  const postUrl = `https://m.blog.naver.com/${blogId}/${logNo}`;
  const bundleId = randomUUID();
  const draft = "글 잘 봤어요. 짧은 예시 댓글입니다.";

  const { data: person, error: personErr } = await db
    .from("persons")
    .insert({
      display_name: `[verify:approval_modes_ui] ${testRunId}`,
      discover_meta: buildVerifyDiscoverMeta(testRunId, caseId, {
        blog_id: blogId,
        reasons: ["UI mode check only — no live execute"],
      }),
    })
    .select("*")
    .single();
  if (personErr) throw personErr;

  const { error: relErr } = await db
    .from("relationship_states")
    .update({
      stage: "maintain",
      score: 70,
      temperature: 60,
      last_touch_at: new Date().toISOString(),
    })
    .eq("person_id", person.id);
  if (relErr) throw relErr;

  const { data: workflow, error: wfErr } = await db
    .from("workflows")
    .insert({
      person_id: person.id,
      current_stage: "maintain",
      current_state: "active",
      next_action: "comment",
      priority: 80,
      goal: "approval_modes_ui",
    })
    .select("*")
    .single();
  if (wfErr) throw wfErr;

  await db
    .from("persons")
    .update({ active_workflow_id: workflow.id })
    .eq("id", person.id);

  const target_ref = {
    blog_id: blogId,
    log_no: logNo,
    post_id: logNo,
    post_url: postUrl,
    title: "[verify] UI approval modes",
    verify: true,
    test_run_id: testRunId,
    smoke: "approval_modes_ui",
  };

  const { data: commentJob, error: cErr } = await db
    .from("action_jobs")
    .insert({
      parent_workflow_id: workflow.id,
      person_id: person.id,
      channel: "blog",
      action_type: "comment",
      risk: "high",
      status: "pending_approval",
      draft_body: draft,
      draft_alternatives: ["좋은 글 감사합니다!", "공감하고 갑니다."],
      target_ref,
      bundle_id: bundleId,
      inbox_priority: 80,
    })
    .select("*")
    .single();
  if (cErr) throw cErr;

  const { data: likeJob, error: lErr } = await db
    .from("action_jobs")
    .insert({
      parent_workflow_id: workflow.id,
      person_id: person.id,
      channel: "blog",
      action_type: "like",
      risk: "low",
      status: "planned",
      target_ref: {
        ...target_ref,
        bundle_hold: true,
        awaiting_approval_mode: true,
      },
      bundle_id: bundleId,
      inbox_priority: 0,
    })
    .select("*")
    .single();
  if (lErr) throw lErr;

  const { data: approval, error: aErr } = await db
    .from("approval_items")
    .insert({
      workflow_id: workflow.id,
      action_job_id: commentJob.id,
      person_id: person.id,
      inbox_priority: 80,
      presented_context: {
        reason_short: "UI 검증: 댓글/공감/댓글+공감 모드 표시",
        verify: true,
        test_run_id: testRunId,
        bundle_id: bundleId,
        available_modes: ["comment", "like", "both"],
        draft: { action_type: "comment", body: draft },
      },
    })
    .select("*")
    .single();
  if (aErr) throw aErr;

  const repos = createSupervisorRepos(db);
  const inbox = await repos.approval.listOpenInbox();
  const item = inbox.find((i) => i.approval.id === approval.id);

  console.log(
    JSON.stringify(
      {
        created: {
          test_run_id: testRunId,
          person_id: person.id,
          display_name: person.display_name,
          workflow_id: workflow.id,
          approval_id: approval.id,
          comment_job_id: commentJob.id,
          like_job_id: likeJob.id,
          bundle_id: bundleId,
          post_url: postUrl,
          draft_body: draft,
        },
        inbox_check: item
          ? {
              found: true,
              actionLabel: item.actionLabel,
              hasBundledLike: item.hasBundledLike,
              availableModes: item.availableModes,
              modes_ok:
                item.hasBundledLike === true &&
                item.availableModes.includes("comment") &&
                item.availableModes.includes("like") &&
                item.availableModes.includes("both"),
            }
          : { found: false },
        cleanup_hint: `npm run verify:loop:clean -- --run ${testRunId}`,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
