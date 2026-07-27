/**
 * Seed Agent Loop fixtures for verify only.
 * Every Person is tagged: discover_meta.verify=true + test_run_id.
 * Usage: npm run seed
 */

import { createServiceClient } from "../src/lib/supabase";
import { buildVerifyDiscoverMeta, newTestRunId } from "./verifyMeta";

export type SeedCaseId =
  | "like_auto"
  | "comment_appr"
  | "mutual_appr"
  | "sync_target"
  | "fail_like"
  | "approve_ready";

export interface SeedPersonResult {
  caseId: SeedCaseId;
  testRunId: string;
  personId: string;
  workflowId: string;
  perceptionId?: string;
  actionJobId?: string;
  approvalId?: string;
  displayName: string;
}

export interface SeedRunResult {
  testRunId: string;
  persons: SeedPersonResult[];
}

async function createPersonWorkflow(opts: {
  displayName: string;
  stage: string;
  nextAction: string;
  score: number;
  temperature: number;
  discoverMeta: Record<string, unknown>;
  goal?: string;
  lastTouchAt?: string;
}) {
  const db = createServiceClient();
  const { data: person, error: personErr } = await db
    .from("persons")
    .insert({
      display_name: opts.displayName,
      discover_meta: opts.discoverMeta,
    })
    .select("*")
    .single();
  if (personErr) throw personErr;

  const { error: relErr } = await db
    .from("relationship_states")
    .update({
      stage: opts.stage,
      score: opts.score,
      temperature: opts.temperature,
      last_touch_at: opts.lastTouchAt ?? new Date().toISOString(),
    })
    .eq("person_id", person.id);
  if (relErr) throw relErr;

  const { data: workflow, error: wfErr } = await db
    .from("workflows")
    .insert({
      person_id: person.id,
      current_stage: opts.stage,
      current_state: "active",
      next_action: opts.nextAction,
      priority: 55,
      goal: opts.goal ?? null,
    })
    .select("*")
    .single();
  if (wfErr) throw wfErr;

  const { error: personWfErr } = await db
    .from("persons")
    .update({ active_workflow_id: workflow.id })
    .eq("id", person.id);
  if (personWfErr) throw personWfErr;

  return { person, workflow };
}

async function insertNewPost(
  personId: string,
  blogId: string,
  title: string,
  testRunId: string,
  caseId: string,
) {
  const db = createServiceClient();
  const logNo = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const postUrl = `https://m.blog.naver.com/${blogId}/${logNo}`;
  const { data, error } = await db
    .from("perception_events")
    .insert({
      person_id: personId,
      channel: "blog",
      event_type: "new_post",
      payload: {
        post_id: logNo,
        log_no: logNo,
        blog_id: blogId,
        post_url: postUrl,
        title,
        content_summary: `${title} 요약`,
        verify: true,
        test_run_id: testRunId,
        verify_case: caseId,
      },
      occurred_at: new Date().toISOString(),
    })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

async function insertExecutedJob(opts: {
  workflowId: string;
  personId: string;
  actionType: "visit" | "like";
  blogId: string;
  testRunId: string;
}) {
  const db = createServiceClient();
  const { data, error } = await db
    .from("action_jobs")
    .insert({
      parent_workflow_id: opts.workflowId,
      person_id: opts.personId,
      channel: "blog",
      action_type: opts.actionType,
      risk: "low",
      status: "executed",
      target_ref: {
        blog_id: opts.blogId,
        verify: true,
        test_run_id: opts.testRunId,
      },
      executed_at: new Date().toISOString(),
      inbox_priority: 0,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function seedAgentLoopFixtures(
  runId = newTestRunId(),
): Promise<SeedRunResult> {
  const db = createServiceClient();
  const results: SeedPersonResult[] = [];
  const testRunId = runId;

  // Verify-only policy tweak (singleton — restored by ops if needed)
  await db
    .from("policy_profile")
    .update({
      low_risk_auto: true,
      quiet_hours: {},
      daily_limits: { like: 50, visit: 50 },
    })
    .eq("id", true);

  // A) like auto
  {
    const caseId = "like_auto" as const;
    const blogId = `like_${testRunId}`;
    const { person, workflow } = await createPersonWorkflow({
      displayName: `[verify:like_auto] ${testRunId}`,
      stage: "warming",
      nextAction: "like",
      score: 45,
      temperature: 40,
      goal: "warming_to_request",
      discoverMeta: buildVerifyDiscoverMeta(testRunId, caseId, {
        blog_id: blogId,
        recommend_score: 80,
        reasons: ["키워드:맛집"],
        sponsored_likely: false,
      }),
    });
    const pe = await insertNewPost(
      person.id,
      blogId,
      "주말 카페 탐방",
      testRunId,
      caseId,
    );
    results.push({
      caseId,
      testRunId,
      personId: person.id,
      workflowId: workflow.id,
      perceptionId: pe.id,
      displayName: person.display_name,
    });
  }

  // B) comment approval
  {
    const caseId = "comment_appr" as const;
    const blogId = `cmt_${testRunId}`;
    const { person, workflow } = await createPersonWorkflow({
      displayName: `[verify:comment_appr] ${testRunId}`,
      stage: "early_relationship",
      nextAction: "comment",
      score: 62,
      temperature: 58,
      discoverMeta: buildVerifyDiscoverMeta(testRunId, caseId, {
        blog_id: blogId,
        recommend_score: 75,
        reasons: ["키워드:카페"],
        sponsored_likely: false,
      }),
    });
    await insertExecutedJob({
      workflowId: workflow.id,
      personId: person.id,
      actionType: "like",
      blogId,
      testRunId,
    });
    const pe = await insertNewPost(
      person.id,
      blogId,
      "새 메뉴 리뷰",
      testRunId,
      caseId,
    );
    results.push({
      caseId,
      testRunId,
      personId: person.id,
      workflowId: workflow.id,
      perceptionId: pe.id,
      displayName: person.display_name,
    });
  }

  // C) mutual request
  {
    const caseId = "mutual_appr" as const;
    const blogId = `mut_${testRunId}`;
    const { person, workflow } = await createPersonWorkflow({
      displayName: `[verify:mutual_appr] ${testRunId}`,
      stage: "warming",
      nextAction: "neighbor_request",
      score: 50,
      temperature: 48,
      goal: "warming_to_request",
      discoverMeta: buildVerifyDiscoverMeta(testRunId, caseId, {
        blog_id: blogId,
        matched_keywords: ["맛집"],
        recently_active: true,
        reasons: ["키워드:맛집"],
        sponsored_likely: false,
      }),
    });
    await insertExecutedJob({
      workflowId: workflow.id,
      personId: person.id,
      actionType: "visit",
      blogId,
      testRunId,
    });
    await insertExecutedJob({
      workflowId: workflow.id,
      personId: person.id,
      actionType: "like",
      blogId,
      testRunId,
    });
    const pe = await insertNewPost(
      person.id,
      blogId,
      "워밍 후 새 글",
      testRunId,
      caseId,
    );
    results.push({
      caseId,
      testRunId,
      personId: person.id,
      workflowId: workflow.id,
      perceptionId: pe.id,
      displayName: person.display_name,
    });
  }

  // D) sync target
  {
    const caseId = "sync_target" as const;
    const blogId = `sync_${testRunId}`;
    const { person, workflow } = await createPersonWorkflow({
      displayName: `[verify:sync_target] ${testRunId}`,
      stage: "warming",
      nextAction: "like",
      score: 40,
      temperature: 35,
      discoverMeta: buildVerifyDiscoverMeta(testRunId, caseId, {
        blog_id: blogId,
        recommend_score: 70,
        sponsored_likely: false,
      }),
    });
    results.push({
      caseId,
      testRunId,
      personId: person.id,
      workflowId: workflow.id,
      displayName: person.display_name,
    });
  }

  // E) fail like
  {
    const caseId = "fail_like" as const;
    const blogId = `fail_${testRunId}`;
    const { person, workflow } = await createPersonWorkflow({
      displayName: `[verify:fail_like] ${testRunId}`,
      stage: "warming",
      nextAction: "like",
      score: 40,
      temperature: 35,
      discoverMeta: buildVerifyDiscoverMeta(testRunId, caseId, {
        blog_id: blogId,
        sponsored_likely: false,
      }),
    });
    const { data: job, error: jobErr } = await db
      .from("action_jobs")
      .insert({
        parent_workflow_id: workflow.id,
        person_id: person.id,
        channel: "blog",
        action_type: "like",
        risk: "low",
        status: "planned",
        target_ref: {
          blog_id: blogId,
          verify: true,
          test_run_id: testRunId,
        },
        inbox_priority: 0,
      })
      .select("*")
      .single();
    if (jobErr) throw jobErr;
    results.push({
      caseId,
      testRunId,
      personId: person.id,
      workflowId: workflow.id,
      actionJobId: job.id,
      displayName: person.display_name,
    });
  }

  // F) approve ready
  {
    const caseId = "approve_ready" as const;
    const blogId = `apr_${testRunId}`;
    const { person, workflow } = await createPersonWorkflow({
      displayName: `[verify:approve_ready] ${testRunId}`,
      stage: "approval_pending",
      nextAction: "comment",
      score: 60,
      temperature: 55,
      discoverMeta: buildVerifyDiscoverMeta(testRunId, caseId, {
        blog_id: blogId,
        reasons: ["키워드:리뷰"],
        sponsored_likely: false,
      }),
    });
    const logNo = `${Date.now()}9`;
    const postUrl = `https://m.blog.naver.com/${blogId}/${logNo}`;
    const { data: job, error: jobErr } = await db
      .from("action_jobs")
      .insert({
        parent_workflow_id: workflow.id,
        person_id: person.id,
        channel: "blog",
        action_type: "comment",
        risk: "high",
        status: "pending_approval",
        draft_body: "포스팅 잘 봤습니다. 검증용 댓글입니다.",
        target_ref: {
          blog_id: blogId,
          log_no: logNo,
          post_id: logNo,
          post_url: postUrl,
          verify: true,
          test_run_id: testRunId,
        },
        inbox_priority: 60,
      })
      .select("*")
      .single();
    if (jobErr) throw jobErr;

    const { data: approval, error: apErr } = await db
      .from("approval_items")
      .insert({
        workflow_id: workflow.id,
        action_job_id: job.id,
        person_id: person.id,
        inbox_priority: 60,
        presented_context: {
          reason_short: "verify approve → execute",
          test_run_id: testRunId,
          verify: true,
          draft: {
            action_type: "comment",
            body: "포스팅 잘 봤습니다. 검증용 댓글입니다.",
          },
        },
      })
      .select("*")
      .single();
    if (apErr) throw apErr;

    results.push({
      caseId,
      testRunId,
      personId: person.id,
      workflowId: workflow.id,
      actionJobId: job.id,
      approvalId: approval.id,
      displayName: person.display_name,
    });
  }

  return { testRunId, persons: results };
}

async function main() {
  const seeded = await seedAgentLoopFixtures();
  console.log(`Seeded Agent Loop fixtures test_run_id=${seeded.testRunId}:`);
  for (const row of seeded.persons) {
    console.log(
      `  [${row.caseId}] person=${row.personId} wf=${row.workflowId}` +
        (row.perceptionId ? ` pe=${row.perceptionId}` : "") +
        (row.approvalId ? ` approval=${row.approvalId}` : "") +
        (row.actionJobId ? ` job=${row.actionJobId}` : ""),
    );
  }
}

const isDirect =
  process.argv[1]?.includes("seed.ts") ||
  process.argv[1]?.endsWith("/seed") ||
  process.argv[1]?.endsWith("\\seed");

if (isDirect) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
