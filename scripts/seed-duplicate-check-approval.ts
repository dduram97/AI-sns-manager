/**
 * Duplicate-check fixture: fake executed comment + new open Approval (same post_url).
 * No live Naver execute.
 *
 *   npx tsx scripts/seed-duplicate-check-approval.ts
 *
 * Cleanup:
 *   npm run verify:loop:clean -- --run <test_run_id>
 */

import { randomUUID } from "node:crypto";
import { createServiceClient } from "../src/lib/supabase";
import {
  createRepositories,
  createSupervisorRepos,
} from "../src/repositories/index";
import type { DecisionOutput, Workflow } from "../src/workers/types";
import { enqueueApproval } from "../src/workers/approval";
import { buildVerifyDiscoverMeta, newTestRunId } from "./verifyMeta";

/** Same URL as a known live execute — also inserts its own executed history row. */
const POST_URL = "https://m.blog.naver.com/soonim0127/222349653182";
const BLOG_ID = "soonim0127";
const LOG_NO = "222349653182";
const TITLE = "강아지 영양제 후기 (3) · duplicate check";
const CONTENT =
  "중복 방지 UI 테스트용 포스팅 요약. 실제 네이버 실행은 하지 않습니다.";

async function main() {
  const db = createServiceClient();
  const repos = createRepositories(db);
  const testRunId = newTestRunId();
  const caseId = "duplicate_check_ui";
  const now = new Date().toISOString();

  const { data: person, error: personErr } = await db
    .from("persons")
    .insert({
      display_name: `[verify:duplicate_check] ${testRunId}`,
      discover_meta: buildVerifyDiscoverMeta(testRunId, caseId, {
        blog_id: BLOG_ID,
        blog_url: `https://m.blog.naver.com/${BLOG_ID}`,
        reasons: ["duplicate modal fixture — no live execute"],
      }),
    })
    .select("*")
    .single();
  if (personErr) throw personErr;

  await db
    .from("relationship_states")
    .update({
      stage: "maintain",
      score: 70,
      temperature: 60,
      last_touch_at: now,
    })
    .eq("person_id", person.id);

  const { data: workflow, error: wfErr } = await db
    .from("workflows")
    .insert({
      person_id: person.id,
      current_stage: "maintain",
      current_state: "active",
      next_action: "comment",
      priority: 80,
      goal: caseId,
    })
    .select("*")
    .single();
  if (wfErr) throw wfErr;

  await db
    .from("persons")
    .update({ active_workflow_id: workflow.id })
    .eq("id", person.id);

  const target_ref = {
    blog_id: BLOG_ID,
    log_no: LOG_NO,
    post_id: LOG_NO,
    post_url: POST_URL,
    title: TITLE,
    content_summary: CONTENT,
    content_excerpt: CONTENT.slice(0, 200),
    verify: true,
    test_run_id: testRunId,
    smoke: caseId,
  };

  // 1) Fake prior executed history (no adapter run)
  const priorBundle = randomUUID();
  const { data: priorJob, error: priorErr } = await db
    .from("action_jobs")
    .insert({
      parent_workflow_id: workflow.id,
      person_id: person.id,
      channel: "blog",
      action_type: "comment",
      risk: "high",
      status: "executed",
      draft_body: "[verify] prior executed for duplicate check",
      target_ref: {
        ...target_ref,
        title: `${TITLE} (prior executed)`,
      },
      bundle_id: priorBundle,
      inbox_priority: 0,
      executed_at: now,
    })
    .select("*")
    .single();
  if (priorErr) throw priorErr;

  // Optional resolved approval pointing at prior job (helps history UI)
  const { data: priorApprovalRow, error: priorApprErr } = await db
    .from("approval_items")
    .insert({
      workflow_id: workflow.id,
      action_job_id: priorJob.id,
      person_id: person.id,
      inbox_priority: 0,
      presented_context: {
        reason_short: "중복 테스트용 이전 실행 기록",
        verify: true,
        test_run_id: testRunId,
        post_title: TITLE,
        last_execute_mode: "comment",
      },
    })
    .select("*")
    .single();
  if (priorApprErr) throw priorApprErr;

  const { data: priorApproval, error: resolveErr } = await db
    .from("approval_items")
    .update({ resolved_at: new Date().toISOString() })
    .eq("id", priorApprovalRow.id)
    .select("*")
    .single();
  if (resolveErr) throw resolveErr;

  // 2) New open Approval with SAME post_url (pending — for Inbox)
  const wf = (await repos.getActiveWorkflow(person.id)) as Workflow;
  if (!wf) throw new Error("workflow missing");

  const reasonShort = "중복 모달 테스트: 동일 post_url 신규 Approval";
  const record = await repos.insertDecision({
    person_id: person.id,
    workflow_id: wf.id,
    perception_event_id: null,
    decision_type: "create_approval",
    reason_short: reasonShort,
    reason_detail: {
      verify: true,
      test_run_id: testRunId,
      post_url: POST_URL,
      case: caseId,
    },
    inputs: { source: "duplicate_check_fixture" },
  });

  const output: Extract<DecisionOutput, { kind: "create_approval" }> = {
    kind: "create_approval",
    reason_short: reasonShort,
    explanation: "중복 방지 UI 확인용 (실행 없음)",
    reasons: [reasonShort],
    rule_ids: ["test.duplicate_check_ui"],
    workflow_patch: {
      next_action: "none",
      blocked_reason: null,
    },
    draft: {
      action_type: "comment",
      channel: "blog",
      body: "중복 테스트용 초안입니다.",
      alternatives: [],
      target_ref,
    },
  };

  const { job, approval } = await enqueueApproval(repos, wf, output, record);

  const supervisor = createSupervisorRepos(db);
  const inbox = await supervisor.approval.listOpenInbox();
  const item = inbox.find((i) => i.approval.id === approval.id);

  const { checkApprovalPostDuplicates } = await import(
    "../src/services/approvalService"
  );
  const dupCheck = await checkApprovalPostDuplicates([approval.id]);

  console.log(
    JSON.stringify(
      {
        ok: true,
        executed: false,
        purpose: "duplicate_modal_ui",
        test_run_id: testRunId,
        post_url: POST_URL,
        blog_id: BLOG_ID,
        log_no: LOG_NO,
        prior_executed_job: {
          id: priorJob.id,
          status: priorJob.status,
          executed_at: priorJob.executed_at,
        },
        prior_approval_id: priorApproval.id,
        open_approval: {
          approval_id: approval.id,
          comment_job_id: job.id,
          job_status: job.status,
          draft_body: job.draft_body,
          availableModes: item?.availableModes ?? null,
          hasBundledLike: item?.hasBundledLike ?? null,
        },
        duplicate_check: {
          duplicates: dupCheck.duplicates.length,
          hit: dupCheck.duplicates[0] ?? null,
          unique_count: dupCheck.uniqueApprovalIds.length,
          expect_modal: dupCheck.duplicates.length > 0,
        },
        how_to_test: [
          "Open /today/approvals 미처리 탭",
          `Find "[verify:duplicate_check] ${testRunId}" or title "${TITLE}"`,
          "승인 클릭 → 「이미 처리한 포스팅이 있습니다.」 모달 확인",
        ],
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
