/**
 * Create comment Approval for a real Naver post URL (no execute).
 *
 *   npx tsx scripts/seed-comment-approval-url.ts
 */

import { createServiceClient } from "../src/lib/supabase";
import {
  createRepositories,
  createSupervisorRepos,
} from "../src/repositories/index";
import type { DecisionOutput, Workflow } from "../src/workers/types";
import { enqueueApproval } from "../src/workers/approval";
import { buildVerifyDiscoverMeta, newTestRunId } from "./verifyMeta";

const POST_URL =
  "https://m.blog.naver.com/soonim0127/222349828161?recommendTrackingCode=2";
const BLOG_ID = "soonim0127";
const LOG_NO = "222349828161";
const TITLE =
  '강아지 향수,샴푸 추천 "아일오브 독스 클린코팅샴푸 , 슈가케인"';
const CONTENT = [
  "두부한테 되도록 좋은 샴푸로 씻기고 싶어서 서칭해보니 천연재료로 성분이 순하다고 해서 아일오브독스 샴푸를 구매했다.",
  "아일오브독스 샴푸 사는김에 강아지 향수도 아일오브독스 슈가케인으로 구매해봤다.",
  "슈가케인은 자몽향이 난다. 인조적인 향이 나서 두번은 안살것같다.",
  "아일오브독스 샴푸를 써보니 목욕후에 몸을 긁는행동이 없어졌다. 향도 은은하고 무엇보다 털이 엄청 부드러워진다.",
].join(" ");

async function main() {
  const db = createServiceClient();
  const repos = createRepositories(db);
  const testRunId = newTestRunId();

  const { data: person, error: personErr } = await db
    .from("persons")
    .insert({
      display_name: `[verify:comment_url] ${testRunId}`,
      discover_meta: buildVerifyDiscoverMeta(testRunId, "comment_url_approval", {
        blog_id: BLOG_ID,
        blog_url: `https://m.blog.naver.com/${BLOG_ID}`,
        reasons: ["live URL approval create-only test — no execute"],
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
      goal: "comment_url_approval",
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
    reason_short: "URL 테스트: comment approval 생성만",
    reason_detail: {
      verify: true,
      test_run_id: testRunId,
      post_url: POST_URL,
    },
    inputs: { source: "manual_url_comment_approval_test" },
  });

  const output: Extract<DecisionOutput, { kind: "create_approval" }> = {
    kind: "create_approval",
    reason_short: "URL 테스트: comment approval 생성만",
    explanation: "테스트용 comment Approval 생성 (실행 없음)",
    reasons: ["URL 테스트: comment approval 생성만"],
    rule_ids: ["test.comment_url"],
    workflow_patch: {
      next_action: "none",
      blocked_reason: null,
    },
    draft: {
      action_type: "comment",
      channel: "blog",
      body: "포스팅 잘 봤습니다.",
      alternatives: [],
      target_ref: {
        blog_id: BLOG_ID,
        log_no: LOG_NO,
        post_id: LOG_NO,
        post_url: POST_URL,
        title: TITLE,
        content_summary: CONTENT,
        content_excerpt: CONTENT.slice(0, 500),
        verify: true,
        test_run_id: testRunId,
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
    .select("id,status,action_type,bundle_id")
    .eq("bundle_id", job.bundle_id)
    .eq("action_type", "like")
    .maybeSingle();

  console.log(
    JSON.stringify(
      {
        ok: true,
        executed: false,
        test_run_id: testRunId,
        post_url: POST_URL,
        person_id: person.id,
        display_name: person.display_name,
        approval_id: approval.id,
        comment_job: {
          id: job.id,
          status: job.status,
          action_type: job.action_type,
          bundle_id: job.bundle_id,
          draft_body: job.draft_body,
          draft_alternatives: job.draft_alternatives,
          comment_situation: job.target_ref?.comment_situation ?? null,
          ai_draft_source: job.target_ref?.ai_draft_source ?? null,
          ai_draft_model: job.target_ref?.ai_draft_model ?? null,
        },
        like_sibling: likeSibling,
        inbox: item
          ? {
              found: true,
              actionLabel: item.actionLabel,
              draftBody: item.draftBody,
              commentSituation: item.commentSituation,
              postTitle: item.postTitle,
              availableModes: item.availableModes,
              hasBundledLike: item.hasBundledLike,
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
