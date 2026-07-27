/**
 * Operational Agent Loop verification (Supabase + mock Naver adapter).
 *
 * Usage:
 *   npm run verify:loop           # seed → scoped tick → cleanup this run
 *   npm run verify:loop -- --keep # keep fixtures after run
 *   npm run verify:loop:clean     # delete all verify-tagged persons
 */

import {
  executeActionJob,
  type ActionExecutionPort,
} from "../src/adapters/executeActionJob";
import { createServiceClient } from "../src/lib/supabase";
import { createRepositories } from "../src/repositories/index";
import { approveApproval } from "../src/services/approvalService";
import { ingestNaverBlogPerceptions } from "../src/workers/sync";
import { tick } from "../src/workers/tick";
import { seedAgentLoopFixtures, type SeedPersonResult } from "./seed";
import { cleanupVerifyPersons } from "./verify-cleanup";
import { newTestRunId } from "./verifyMeta";

process.env.NAVER_ADAPTER_MODE = "mock";
process.env.NAVER_SYNC_MOCK_POST = "1";
process.env.APPROVAL_BATCH_DELAY_MIN_MS = "0";
process.env.APPROVAL_BATCH_DELAY_MAX_MS = "0";
process.env.NAVER_DELAY_LIKE_MIN_MS = "0";
process.env.NAVER_DELAY_LIKE_MAX_MS = "0";
process.env.NAVER_DELAY_COMMENT_MIN_MS = "0";
process.env.NAVER_DELAY_COMMENT_MAX_MS = "0";
process.env.NAVER_DELAY_VISIT_MIN_MS = "0";
process.env.NAVER_DELAY_VISIT_MAX_MS = "0";
process.env.NAVER_DELAY_MUTUAL_REQUEST_MIN_MS = "0";
process.env.NAVER_DELAY_MUTUAL_REQUEST_MAX_MS = "0";
process.env.NAVER_DELAY_SYNC_MIN_MS = "0";
process.env.NAVER_DELAY_SYNC_MAX_MS = "0";

type Check = { name: string; ok: boolean; detail?: string };

function assert(checks: Check[], name: string, ok: boolean, detail?: string) {
  checks.push({ name, ok, detail });
  const mark = ok ? "PASS" : "FAIL";
  console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function byCase(seeded: SeedPersonResult[], id: SeedPersonResult["caseId"]) {
  const row = seeded.find((s) => s.caseId === id);
  if (!row) throw new Error(`missing seed case ${id}`);
  return row;
}

function parseArgs(argv: string[]) {
  return {
    keep: argv.includes("--keep"),
    cleanOnly: argv.includes("--clean-only"),
  };
}

async function main() {
  const { keep, cleanOnly } = parseArgs(process.argv.slice(2));
  const checks: Check[] = [];
  const db = createServiceClient();
  const repos = createRepositories(db);

  if (cleanOnly) {
    const cleaned = await cleanupVerifyPersons();
    console.log(
      `Cleaned ${cleaned.deletedPersonIds.length} verify person(s); skipped ${cleaned.skippedNonVerify} operational.`,
    );
    return;
  }

  const testRunId = newTestRunId();
  console.log(`\n=== verify run test_run_id=${testRunId} ===`);

  // Isolate from ops OutcomeDaily pressure (excessive_visits / daily caps)
  const outcomeSnap = await repos.ensureOutcomeToday();
  await repos.updateOutcomeToday({
    auto_visit_count: 0,
    auto_like_count: 0,
    observe_count: 0,
    waiting_count: 0,
    approval_pending_count: 0,
    approval_done_count: 0,
    intervention_minutes_est: 0,
    time_saved_minutes_est: 0,
  });
  console.log(
    `OutcomeDaily snapshot saved (visits=${outcomeSnap.auto_visit_count}, likes=${outcomeSnap.auto_like_count}); reset for verify.`,
  );

  async function restoreOutcome() {
    await repos.updateOutcomeToday({
      auto_visit_count: outcomeSnap.auto_visit_count,
      auto_like_count: outcomeSnap.auto_like_count,
      observe_count: outcomeSnap.observe_count,
      waiting_count: outcomeSnap.waiting_count,
      approval_pending_count: outcomeSnap.approval_pending_count,
      approval_done_count: outcomeSnap.approval_done_count,
      intervention_minutes_est: outcomeSnap.intervention_minutes_est,
      time_saved_minutes_est: outcomeSnap.time_saved_minutes_est,
    });
  }

  console.log("\n=== 1) Seed fixtures (tagged) ===");
  const seededRun = await seedAgentLoopFixtures(testRunId);
  const seeded = seededRun.persons;
  const personIds = seeded.map((s) => s.personId);
  for (const s of seeded) {
    console.log(`  seeded ${s.caseId}: ${s.personId}`);
  }
  assert(
    checks,
    "all seeds share test_run_id",
    seeded.every((s) => s.testRunId === testRunId),
    testRunId,
  );

  console.log("\n=== 2) Sync → Perception (scoped to this run) ===");
  const syncTarget = byCase(seeded, "sync_target");
  const sync = await ingestNaverBlogPerceptions(repos, undefined, {
    personIds,
    includeVerifyPersons: true,
  });
  assert(
    checks,
    "sync targets only this run",
    sync.targets === personIds.length,
    `targets=${sync.targets} expected=${personIds.length}`,
  );
  assert(
    checks,
    "sync created perception from mock post",
    sync.perceptionsCreated >= 1,
    `created=${sync.perceptionsCreated} posts=${sync.postsSeen}`,
  );
  const { data: syncPe } = await db
    .from("perception_events")
    .select("id, person_id, processed_at, payload")
    .eq("person_id", syncTarget.personId)
    .is("processed_at", null);
  assert(
    checks,
    "sync_target has unprocessed new_post",
    (syncPe?.length ?? 0) >= 1,
    `count=${syncPe?.length ?? 0}`,
  );

  console.log("\n=== 3) Agent Tick (scoped) ===");
  const result = await tick(repos, {
    personIds,
    skipDiscover: true,
    skipSync: true,
    includeVerifyPersons: true,
  });
  for (const line of result.logs) console.log(`  ${line}`);

  assert(checks, "tick personsProcessed > 0", result.personsProcessed > 0);
  assert(
    checks,
    "tick only processed this run (≤ seed count)",
    result.personsProcessed <= personIds.length,
    `processed=${result.personsProcessed}`,
  );
  assert(checks, "tick refreshed brief", Boolean(result.brief?.updated_at));
  assert(
    checks,
    "tick produced decisions",
    result.decisions.length > 0,
    `n=${result.decisions.length}`,
  );

  const likeCase = byCase(seeded, "like_auto");
  const commentCase = byCase(seeded, "comment_appr");
  const mutualCase = byCase(seeded, "mutual_appr");

  const { data: likeJobs } = await db
    .from("action_jobs")
    .select("*")
    .eq("person_id", likeCase.personId)
    .eq("action_type", "like")
    .order("created_at", { ascending: false })
    .limit(3);
  const likeJob = likeJobs?.[0];
  assert(
    checks,
    "like_auto → ActionJob like executed (no approval)",
    likeJob?.status === "executed" && likeJob?.risk === "low",
    `status=${likeJob?.status} risk=${likeJob?.risk}`,
  );
  const { data: likeApprovals } = await db
    .from("approval_items")
    .select("id")
    .eq("person_id", likeCase.personId);
  assert(
    checks,
    "like_auto did not create Approval",
    (likeApprovals?.length ?? 0) === 0,
    `approvals=${likeApprovals?.length ?? 0}`,
  );
  const { data: likeActs } = await db
    .from("activity_items")
    .select("kind, summary")
    .eq("person_id", likeCase.personId)
    .eq("kind", "executed");
  assert(checks, "like_auto → Activity executed", (likeActs?.length ?? 0) >= 1);

  const { data: commentJobs } = await db
    .from("action_jobs")
    .select("*")
    .eq("person_id", commentCase.personId)
    .eq("action_type", "comment")
    .order("created_at", { ascending: false })
    .limit(1);
  const commentJob = commentJobs?.[0];
  assert(
    checks,
    "comment_appr → ActionJob comment pending_approval",
    commentJob?.status === "pending_approval" && commentJob?.risk === "high",
    `status=${commentJob?.status}`,
  );
  const { data: commentApprovals } = await db
    .from("approval_items")
    .select("id")
    .eq("person_id", commentCase.personId)
    .is("resolved_at", null);
  assert(
    checks,
    "comment_appr → Approval created",
    (commentApprovals?.length ?? 0) >= 1,
  );

  const { data: mutualJobs } = await db
    .from("action_jobs")
    .select("*")
    .eq("person_id", mutualCase.personId)
    .eq("action_type", "neighbor_request")
    .order("created_at", { ascending: false })
    .limit(1);
  const mutualJob = mutualJobs?.[0];
  assert(
    checks,
    "mutual_appr → neighbor_request pending_approval",
    mutualJob?.status === "pending_approval" && mutualJob?.risk === "high",
    `status=${mutualJob?.status}`,
  );
  const { data: mutualApprovals } = await db
    .from("approval_items")
    .select("id")
    .eq("person_id", mutualCase.personId)
    .is("resolved_at", null);
  assert(
    checks,
    "mutual_appr → Approval created",
    (mutualApprovals?.length ?? 0) >= 1,
  );

  const { data: syncJobs } = await db
    .from("action_jobs")
    .select("action_type, status, risk")
    .eq("person_id", syncTarget.personId)
    .order("created_at", { ascending: false })
    .limit(3);
  assert(
    checks,
    "sync_target tick created low-risk action (like|visit)",
    Boolean(
      syncJobs?.some(
        (j) =>
          (j.action_type === "like" || j.action_type === "visit") &&
          j.risk === "low" &&
          (j.status === "executed" || j.status === "failed"),
      ),
    ),
    JSON.stringify(syncJobs ?? []),
  );

  console.log("\n=== 4) Approval → Action execute ===");
  const approveCase = byCase(seeded, "approve_ready");
  const approveResult = await approveApproval(approveCase.approvalId!);
  assert(checks, "approveApproval returned ok", approveResult.ok === true);
  const { data: approvedJob } = await db
    .from("action_jobs")
    .select("status, action_type")
    .eq("id", approveCase.actionJobId!)
    .single();
  assert(
    checks,
    "approved job executed",
    approvedJob?.status === "executed",
    `status=${approvedJob?.status}`,
  );
  const { data: approvedActs } = await db
    .from("activity_items")
    .select("kind")
    .eq("person_id", approveCase.personId)
    .in("kind", ["approved", "executed"]);
  assert(
    checks,
    "approve path wrote approved/executed activity",
    (approvedActs?.length ?? 0) >= 1,
  );

  console.log("\n=== 5) Fail action → blocked ===");
  const failCase = byCase(seeded, "fail_like");
  const { data: failJobRow } = await db
    .from("action_jobs")
    .select("*")
    .eq("id", failCase.actionJobId!)
    .single();
  if (!failJobRow) throw new Error("fail job missing");

  const port: ActionExecutionPort = {
    markJobRunning: (jobId) => repos.markActionRunning(jobId),
    markJobExecuted: (jobId) => repos.markActionExecuted(jobId),
    markJobFailed: (jobId, message) => repos.markActionFailed(jobId, message),
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

  const { mapActionJob } = await import("../src/repositories/shared.js");
  const failOutcome = await executeActionJob(
    port,
    mapActionJob(failJobRow as Record<string, unknown>),
  );
  assert(checks, "fail like outcome ok=false", failOutcome.ok === false);
  assert(
    checks,
    "fail like job status=failed",
    failOutcome.job.status === "failed",
    `status=${failOutcome.job.status}`,
  );
  const retry = Number(failOutcome.job.target_ref?.retry_count ?? 0);
  assert(
    checks,
    "fail like retry_count incremented",
    retry >= 1,
    `retry=${retry}`,
  );
  const { data: blockedActs } = await db
    .from("activity_items")
    .select("kind, summary")
    .eq("person_id", failCase.personId)
    .eq("kind", "blocked");
  assert(
    checks,
    "fail like → Activity blocked",
    (blockedActs?.length ?? 0) >= 1,
    blockedActs?.[0]?.summary,
  );

  console.log("\n=== 6) Architecture Spec checks ===");
  const { data: allApprovals } = await db
    .from("approval_items")
    .select("id, action_job_id, person_id")
    .in("person_id", personIds);
  const approvalJobIds = (allApprovals ?? []).map((a) => a.action_job_id);
  let highRiskOnly = true;
  if (approvalJobIds.length > 0) {
    const { data: apJobs } = await db
      .from("action_jobs")
      .select("id, action_type, risk")
      .in("id", approvalJobIds);
    for (const j of apJobs ?? []) {
      if (
        j.risk !== "high" ||
        j.action_type === "like" ||
        j.action_type === "visit"
      ) {
        highRiskOnly = false;
      }
    }
  }
  assert(checks, "Approval is high-risk only (no like/visit)", highRiskOnly);
  assert(
    checks,
    "Person-centric fixtures (each case has personId)",
    seeded.every((s) => Boolean(s.personId)),
  );

  const brief = await repos.getBrief();
  assert(
    checks,
    "Brief snapshot present",
    Boolean(brief?.updated_at),
    `approvals=${brief.approval_count}`,
  );

  console.log("\n=== Summary ===");
  const failed = checks.filter((c) => !c.ok);
  console.log(`  ${checks.length - failed.length}/${checks.length} passed`);
  if (failed.length > 0) {
    console.error("\nFailures:");
    for (const f of failed) console.error(`  - ${f.name}: ${f.detail ?? ""}`);
    if (!keep) {
      console.log(`\n=== Cleanup test_run_id=${testRunId} (after failure) ===`);
      const cleaned = await cleanupVerifyPersons({ testRunId });
      console.log(
        `Deleted ${cleaned.deletedPersonIds.length} verify person(s).`,
      );
    }
    await restoreOutcome();
    console.log("OutcomeDaily restored from snapshot.");
    process.exit(1);
  }

  if (keep) {
    await restoreOutcome();
    console.log(
      `\nAgent Loop OK. Keeping fixtures (--keep). test_run_id=${testRunId}`,
    );
    console.log("OutcomeDaily restored from snapshot.");
  } else {
    console.log(`\n=== Cleanup test_run_id=${testRunId} ===`);
    const cleaned = await cleanupVerifyPersons({ testRunId });
    console.log(
      `Deleted ${cleaned.deletedPersonIds.length} verify person(s); skipped ${cleaned.skippedNonVerify} operational.`,
    );
    if (cleaned.deletedPersonIds.length !== personIds.length) {
      console.error(
        `Cleanup count mismatch: deleted=${cleaned.deletedPersonIds.length} seeded=${personIds.length}`,
      );
      await restoreOutcome();
      process.exit(1);
    }
    await restoreOutcome();
    console.log("OutcomeDaily restored from snapshot.");
    console.log("\nAgent Loop operational verification OK (fixtures cleaned).");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
