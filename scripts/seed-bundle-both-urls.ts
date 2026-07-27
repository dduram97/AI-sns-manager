/**
 * Create 5 comment+like (both) Approvals for real Naver post URLs.
 * Create-only — no execute. AI draft via enqueueApproval.
 *
 *   npx tsx scripts/seed-bundle-both-urls.ts
 *
 * Cleanup (per run id printed in output):
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

const FIXTURES: Array<{
  url: string;
  title: string;
  content: string;
}> = [
  {
    url: "https://blog.naver.com/soonim0127/222349627947",
    title: "강아지 영양제 후기 (1)",
    content:
      "강아지 영양제를 골라보며 성분과 급여 방법을 정리했다. 관절과 피부 케어를 함께 고민 중이다.",
  },
  {
    url: "https://blog.naver.com/soonim0127/222349639256",
    title: "강아지 영양제 후기 (2)",
    content:
      "최근 급여 중인 영양제 반응을 기록했다. 기호성과 변 상태를 함께 살펴보는 편이다.",
  },
  {
    url: "https://blog.naver.com/soonim0127/222349653182",
    title: "강아지 영양제 후기 (3)",
    content:
      "영양제 용량과 급여 타이밍을 바꿔가며 관찰했다. 활동량에 맞춰 조절하는 중이다.",
  },
  {
    url: "https://blog.naver.com/soonim0127/222349816199",
    title: "강아지 영양제 후기 (4)",
    content:
      "비슷한 제품과 비교해 본 뒤 선택했다. 포장·보관·급여 편의도 중요한 포인트였다.",
  },
  {
    url: "https://blog.naver.com/soonim0127/222349850601",
    title: "강아지 영양제 후기 (5)",
    content:
      "한동안 꾸준히 먹여본 뒤 느낀 점을 정리했다. 다음에도 같은 라인으로 이어갈지 고민 중이다.",
  },
];

function parsePostUrl(url: string) {
  const m = url.match(/blog\.naver\.com\/([^/?#]+)\/(\d+)/i);
  if (!m) throw new Error(`Invalid Naver post URL: ${url}`);
  const blogId = m[1]!;
  const logNo = m[2]!;
  return {
    postUrl: `https://m.blog.naver.com/${blogId}/${logNo}`,
    blogId,
    logNo,
  };
}

async function createOneFixture(input: {
  testRunId: string;
  index: number;
  url: string;
  title: string;
  content: string;
}) {
  const target = parsePostUrl(input.url);
  const db = createServiceClient();
  const repos = createRepositories(db);
  const caseId = `bundle_both_urls_${input.index}`;

  const { data: person, error: personErr } = await db
    .from("persons")
    .insert({
      display_name: `[verify:bundle_both_urls] ${input.index}/${input.testRunId}`,
      discover_meta: buildVerifyDiscoverMeta(input.testRunId, caseId, {
        blog_id: target.blogId,
        blog_url: `https://m.blog.naver.com/${target.blogId}`,
        reasons: [
          "live URL bundle both fixture batch — create only, no execute",
        ],
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
      goal: "bundle_both_urls",
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

  const reasonShort = `URL 테스트 ${input.index}/5: bundle both approval 생성만`;
  const record = await repos.insertDecision({
    person_id: person.id,
    workflow_id: workflow.id,
    perception_event_id: null,
    decision_type: "create_approval",
    reason_short: reasonShort,
    reason_detail: {
      verify: true,
      test_run_id: input.testRunId,
      post_url: target.postUrl,
      case: "bundle_both_urls",
      index: input.index,
    },
    inputs: { source: "manual_url_bundle_both_urls_test" },
  });

  const output: Extract<DecisionOutput, { kind: "create_approval" }> = {
    kind: "create_approval",
    reason_short: reasonShort,
    explanation: "테스트용 Approval 생성 (실행 없음)",
    reasons: [reasonShort, "comment/like/both 모드 확인"],
    rule_ids: ["test.bundle_both_urls"],
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
        title: input.title,
        content_summary: input.content,
        content_excerpt: input.content.slice(0, 500),
        verify: true,
        test_run_id: input.testRunId,
        smoke: "bundle_both_urls",
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

  return {
    index: input.index,
    post_url: target.postUrl,
    blog_id: target.blogId,
    log_no: target.logNo,
    title: input.title,
    person_id: person.id,
    display_name: person.display_name,
    approval_id: approval.id,
    comment_job: {
      id: job.id,
      status: job.status,
      draft_body: job.draft_body,
      ai_draft_source: job.target_ref?.ai_draft_source ?? null,
      comment_situation: job.target_ref?.comment_situation ?? null,
    },
    like_sibling: likeSibling
      ? {
          id: likeSibling.id,
          status: likeSibling.status,
          bundle_hold: likeSibling.target_ref?.bundle_hold ?? null,
        }
      : null,
    bundle_id: job.bundle_id,
    inbox: item
      ? {
          found: true,
          availableModes: item.availableModes,
          hasBundledLike: item.hasBundledLike,
          draftBody: item.draftBody,
          modes_ok:
            item.hasBundledLike === true &&
            item.availableModes.includes("comment") &&
            item.availableModes.includes("like") &&
            item.availableModes.includes("both"),
        }
      : { found: false },
  };
}

async function main() {
  const testRunId = newTestRunId();
  const created = [];

  for (let i = 0; i < FIXTURES.length; i++) {
    const fixture = FIXTURES[i]!;
    const row = await createOneFixture({
      testRunId,
      index: i + 1,
      url: fixture.url,
      title: fixture.title,
      content: fixture.content,
    });
    created.push(row);
    console.error(
      `[seed-bundle-both-urls] ${i + 1}/${FIXTURES.length} ok approval=${row.approval_id.slice(0, 8)} ai=${row.comment_job.ai_draft_source ?? "fallback"}`,
    );
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        executed: false,
        intended_mode: "both",
        test_run_id: testRunId,
        count: created.length,
        created,
        cleanup_hint: `npm run verify:loop:clean -- --run ${testRunId}`,
        next_steps: {
          ui: "Open /today/approvals — 미처리 탭에서 5건 확인 (comment/like/both)",
          note: "실행하지 않음 · AI 초안은 comment_job.ai_draft_source 확인",
        },
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
