/**
 * Create comment Approval + planned like sibling for a real Naver post URL.
 * No execute — for bundle mode (both) verification fixtures.
 *
 *   npx tsx scripts/seed-bundle-both-url.ts
 *   npx tsx scripts/seed-bundle-both-url.ts --url "https://m.blog.naver.com/{blogId}/{logNo}"
 *
 * Cleanup:
 *   npm run verify:loop:clean -- --run <test_run_id>
 */

import { createServiceClient } from "../src/lib/supabase";
import {
  createRepositories,
  createSupervisorRepos,
} from "../src/repositories/index";
import type { DecisionOutput, Workflow } from "../src/workers/types";
import { enqueueApproval } from "../src/workers/approval";
import { buildVerifyDiscoverMeta, newTestRunId } from "./verifyMeta";

/** Default: different post from the prior comment-only verify URL. */
const DEFAULT_POST_URL =
  "https://m.blog.naver.com/soonim0127/222955974121";
const DEFAULT_TITLE = "강아지 관절 영양제 추천!";
const DEFAULT_CONTENT = [
  "강아지 관절 건강이 걱정되어 영양제를 찾아봤다.",
  "성분과 후기를 비교해보니 관절 케어에 도움이 될 것 같아 구매했다.",
  "꾸준히 먹이면서 움직임이 편안해지길 기대한다.",
].join(" ");

function parseArgs(argv: string[]) {
  let url = DEFAULT_POST_URL;
  let title = DEFAULT_TITLE;
  let content = DEFAULT_CONTENT;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url" && argv[i + 1]) url = argv[++i]!;
    else if (a === "--title" && argv[i + 1]) title = argv[++i]!;
    else if (a === "--content" && argv[i + 1]) content = argv[++i]!;
  }
  const m = url.match(/blog\.naver\.com\/([^/?#]+)\/(\d+)/i);
  if (!m) {
    throw new Error(`Invalid Naver post URL: ${url}`);
  }
  return {
    postUrl: url.includes("m.blog.naver.com")
      ? url
      : `https://m.blog.naver.com/${m[1]}/${m[2]}`,
    blogId: m[1]!,
    logNo: m[2]!,
    title,
    content,
  };
}

async function main() {
  const target = parseArgs(process.argv.slice(2));
  const db = createServiceClient();
  const repos = createRepositories(db);
  const testRunId = newTestRunId();

  const { data: person, error: personErr } = await db
    .from("persons")
    .insert({
      display_name: `[verify:bundle_both] ${testRunId}`,
      discover_meta: buildVerifyDiscoverMeta(testRunId, "bundle_both_url", {
        blog_id: target.blogId,
        blog_url: `https://m.blog.naver.com/${target.blogId}`,
        reasons: ["live URL bundle both fixture — create only, no execute"],
      }),
    })
    .select("*")
    .single();
  if (personErr) throw personErr;

  await db
    .from("relationship_states")
    .update({
      stage: "maintain",
      score: 75,
      temperature: 65,
      last_touch_at: new Date().toISOString(),
    })
    .eq("person_id", person.id);

  const { data: wfRow, error: wfErr } = await db
    .from("workflows")
    .insert({
      person_id: person.id,
      current_stage: "maintain",
      current_state: "active",
      next_action: "comment",
      priority: 85,
      goal: "bundle_both_url",
    })
    .select("*")
    .single();
  if (wfErr) throw wfErr;

  await db
    .from("persons")
    .update({ active_workflow_id: wfRow.id })
    .eq("id", person.id);

  const workflow = (await repos.getActiveWorkflow(person.id)) as Workflow;
  if (!workflow) throw new Error("workflow missing after create");

  const record = await repos.insertDecision({
    person_id: person.id,
    workflow_id: workflow.id,
    perception_event_id: null,
    decision_type: "create_approval",
    reason_short: "URL 테스트: bundle both approval 생성만",
    reason_detail: {
      verify: true,
      test_run_id: testRunId,
      post_url: target.postUrl,
      case: "bundle_both",
    },
    inputs: { source: "manual_url_bundle_both_test" },
  });

  const output: Extract<DecisionOutput, { kind: "create_approval" }> = {
    kind: "create_approval",
    reason_short: "URL 테스트: bundle both approval 생성만",
    explanation: "테스트용 Approval 생성 (실행 없음)",
    reasons: ["URL 테스트: bundle both approval 생성만"],
    rule_ids: ["test.bundle_both_url"],
    workflow_patch: {
      next_action: "none",
      blocked_reason: null,
    },
    draft: {
      action_type: "comment",
      channel: "blog",
      body: "포스팅 잘 봤습니다. 정보 감사해요!",
      alternatives: [],
      target_ref: {
        blog_id: target.blogId,
        log_no: target.logNo,
        post_id: target.logNo,
        post_url: target.postUrl,
        title: target.title,
        content_summary: target.content,
        content_excerpt: target.content.slice(0, 500),
        verify: true,
        test_run_id: testRunId,
        smoke: "bundle_both_url",
      },
    },
  };

  const { job, approval } = await enqueueApproval(
    repos,
    workflow as Workflow,
    output,
    record,
  );

  const supervisor = createSupervisorRepos(db);
  const inbox = await supervisor.approval.listOpenInbox();
  const item = inbox.find((i) => i.approval.id === approval.id);

  const { data: likeSibling } = await db
    .from("action_jobs")
    .select("id,status,action_type,bundle_id,target_ref,risk")
    .eq("bundle_id", job.bundle_id)
    .eq("action_type", "like")
    .maybeSingle();

  const recoveryNote = {
    before_execute: {
      comment: "pending_approval → not recovery target",
      like: "planned + bundle_hold → held by open approval (recovery skips)",
    },
    after_both_success_expected: {
      comment: "executed",
      like: "executed",
      recovery: "neither (unless like fails → failed like is retryable)",
    },
    after_comment_fail_expected: {
      comment: "failed (approval stays open)",
      like: "planned (not executed)",
      recovery: "like held while comment pending_approval / open approval",
    },
  };

  console.log(
    JSON.stringify(
      {
        ok: true,
        executed: false,
        intended_mode: "both",
        test_run_id: testRunId,
        post_url: target.postUrl,
        blog_id: target.blogId,
        log_no: target.logNo,
        title: target.title,
        person_id: person.id,
        display_name: person.display_name,
        approval_id: approval.id,
        comment_job: {
          id: job.id,
          status: job.status,
          action_type: job.action_type,
          bundle_id: job.bundle_id,
          draft_body: job.draft_body,
          comment_situation: job.target_ref?.comment_situation ?? null,
          ai_draft_source: job.target_ref?.ai_draft_source ?? null,
        },
        like_sibling: likeSibling
          ? {
              id: likeSibling.id,
              status: likeSibling.status,
              action_type: likeSibling.action_type,
              bundle_id: likeSibling.bundle_id,
              bundle_hold: likeSibling.target_ref?.bundle_hold ?? null,
              risk: likeSibling.risk,
            }
          : null,
        bundle_id: job.bundle_id,
        bundle_linked:
          Boolean(job.bundle_id) &&
          likeSibling?.bundle_id === job.bundle_id,
        inbox: item
          ? {
              found: true,
              actionLabel: item.actionLabel,
              draftBody: item.draftBody,
              availableModes: item.availableModes,
              hasBundledLike: item.hasBundledLike,
              modes_ok:
                item.hasBundledLike === true &&
                item.availableModes.includes("both"),
            }
          : { found: false },
        recovery_expectations: recoveryNote,
        next_steps: {
          success_path: `approveApproval(${approval.id}, { mode: "both" })`,
          fail_path:
            "별도 fixture 또는 comment 강제 실패 후 like status=planned 유지 확인",
        },
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
