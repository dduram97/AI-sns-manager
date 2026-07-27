/**
 * Naver Live Adapter — like / comment / mutual_request ActionJob tests.
 * Uses existing executeActionJob flow (guards: daily limit, duplicate, retry).
 *
 * Safety: dry-run by default. Real adapter run requires --execute.
 *
 * Usage:
 *   VERIFY_NAVER_BLOG_ID=... VERIFY_NAVER_POST_URL=... \\
 *     npm run verify:naver:actions -- --action like
 *
 *   npm run verify:naver:actions -- --action comment --execute
 *   npm run verify:naver:actions -- --action mutual_request --execute --keep
 *
 * Env:
 *   VERIFY_NAVER_BLOG_ID   (required for all; mutual target)
 *   VERIFY_NAVER_POST_URL  (required for like/comment; or VERIFY_NAVER_LOG_NO)
 *   VERIFY_NAVER_COMMENT_BODY  (optional comment draft)
 *   VERIFY_NAVER_MUTUAL_BODY   (optional mutual message)
 *   NAVER_ADAPTER_MODE=live
 */

import fs from "node:fs";
import path from "node:path";
import {
  executeActionJob,
  type ActionExecutionPort,
} from "../src/adapters/executeActionJob";
import { resolveNaverAdapterMode } from "../src/adapters/naver/NaverBlogAdapter";
import { clearSessionHealth } from "../src/adapters/naver/sessionHealth";
import { resolveNaverTarget } from "../src/adapters/naver/target";
import { createServiceClient } from "../src/lib/supabase";
import { createRepositories } from "../src/repositories/index";
import type { ActionRisk, ActionType } from "../src/workers/types";
import { cleanupVerifyPersons } from "./verify-cleanup";
import { buildVerifyDiscoverMeta, newTestRunId } from "./verifyMeta";

type CliAction = "like" | "comment" | "mutual_request";

type FailCode =
  | "missing_env"
  | "supabase_connection_failed"
  | "adapter_mode_invalid"
  | "missing_target"
  | "invalid_action"
  | "adapter_execution_failed"
  | "activity_missing"
  | "retry_record_missing";

type Check = { name: string; ok: boolean; detail?: string; code?: FailCode };

function logCheck(c: Check) {
  const mark = c.ok ? "PASS" : "FAIL";
  const code = !c.ok && c.code ? ` [${c.code}]` : "";
  console.log(
    `  [${mark}]${code} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`,
  );
}

function fail(code: FailCode, name: string, detail?: string): Check {
  const c: Check = { name, ok: false, detail, code };
  logCheck(c);
  return c;
}

function pass(name: string, detail?: string): Check {
  const c: Check = { name, ok: true, detail };
  logCheck(c);
  return c;
}

function parseArgs(argv: string[]) {
  let action: CliAction | null = null;
  let execute = false;
  let keep = false;
  let allowMock = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--execute") execute = true;
    else if (a === "--keep") keep = true;
    else if (a === "--allow-mock") allowMock = true;
    else if (a === "--action") {
      const v = argv[i + 1]?.trim();
      i += 1;
      if (v === "like" || v === "comment" || v === "mutual_request") {
        action = v;
      }
    } else if (a.startsWith("--action=")) {
      const v = a.slice("--action=".length).trim();
      if (v === "like" || v === "comment" || v === "mutual_request") {
        action = v;
      }
    }
  }
  return { action, execute, keep, allowMock };
}

function toActionType(cli: CliAction): ActionType {
  return cli === "mutual_request" ? "neighbor_request" : cli;
}

function riskFor(type: ActionType): ActionRisk {
  return type === "like" ? "low" : "high";
}

function blogIdEnv(): string | null {
  return (
    process.env.VERIFY_NAVER_BLOG_ID?.trim() ||
    process.env.NAVER_SMOKE_BLOG_ID?.trim() ||
    null
  );
}

function buildTargetRef(blogId: string): Record<string, unknown> {
  const postUrl = process.env.VERIFY_NAVER_POST_URL?.trim();
  const logNo = process.env.VERIFY_NAVER_LOG_NO?.trim();
  const ref: Record<string, unknown> = { blog_id: blogId };
  if (postUrl) ref.post_url = postUrl;
  if (logNo) ref.log_no = logNo;
  return ref;
}

function draftFor(cli: CliAction): string | null {
  if (cli === "comment") {
    return (
      process.env.VERIFY_NAVER_COMMENT_BODY?.trim() ||
      "좋은 글 잘 읽었습니다. (verify draft)"
    );
  }
  if (cli === "mutual_request") {
    return (
      process.env.VERIFY_NAVER_MUTUAL_BODY?.trim() ||
      "안녕하세요. 관심사가 비슷해 서로이웃 신청드립니다. (verify)"
    );
  }
  return null;
}

function validateTarget(
  cli: CliAction,
  targetRef: Record<string, unknown>,
): string | null {
  const resolved = resolveNaverTarget({
    job: null as never,
    personId: "",
    channel: "blog",
    draftBody: draftFor(cli),
    targetRef,
  });
  if (cli === "like" || cli === "comment") {
    if (!resolved.postUrl) {
      return "VERIFY_NAVER_POST_URL 또는 VERIFY_NAVER_BLOG_ID+VERIFY_NAVER_LOG_NO 필요";
    }
  }
  if (cli === "mutual_request") {
    if (!resolved.blogId && !resolved.blogUrl) {
      return "VERIFY_NAVER_BLOG_ID 필요";
    }
  }
  if (cli === "comment" && !draftFor(cli)?.trim()) {
    return "comment draft_body empty";
  }
  return null;
}

function toPort(
  repos: ReturnType<typeof createRepositories>,
): ActionExecutionPort {
  return {
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
}

function printHelp() {
  console.log(`
=== verify:naver:actions ===
  # dry-run (기본) — ActionJob 생성 + target 검증만
  npm run verify:naver:actions -- --action like
  npm run verify:naver:actions -- --action comment
  npm run verify:naver:actions -- --action mutual_request

  # 실제 실행 (Adapter)
  npm run verify:naver:actions -- --action like --execute
  npm run verify:naver:actions -- --action comment --execute --keep

Env: VERIFY_NAVER_BLOG_ID, VERIFY_NAVER_POST_URL (like/comment)
`);
}

async function main() {
  const { action, execute, keep, allowMock } = parseArgs(process.argv.slice(2));
  const checks: Check[] = [];
  const testRunId = newTestRunId();
  let personId: string | null = null;

  // Like evidence mode: keep browser open long enough for 5s observe + 10s hold
  if (action === "like" && execute) {
    if (process.env.NAVER_LIKE_DEBUG !== "0") {
      process.env.NAVER_LIKE_DEBUG = "1";
    }
    const need = 120_000;
    const cur = Number(process.env.ACTION_TIMEOUT ?? 0);
    if (!Number.isFinite(cur) || cur < need) {
      process.env.ACTION_TIMEOUT = String(need);
    }
    console.log(
      `  like-debug=ON hold=${process.env.NAVER_LIKE_DEBUG_HOLD_MS ?? 10000}ms ACTION_TIMEOUT=${process.env.ACTION_TIMEOUT}`,
    );
  }

  console.log(`\n=== verify:naver:actions test_run_id=${testRunId} ===`);
  console.log(
    `  action=${action ?? "(missing)"} · execute=${execute ? "YES" : "no (dry-run)"}\n`,
  );

  if (!action) {
    checks.push(
      fail(
        "invalid_action",
        "--action",
        "like | comment | mutual_request 중 하나 필요",
      ),
    );
    printHelp();
    return exitWithSummary(checks, 1);
  }

  if (
    !process.env.SUPABASE_URL?.trim() ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  ) {
    checks.push(
      fail("missing_env", "Supabase env", "URL/SERVICE_ROLE_KEY 필요"),
    );
    return exitWithSummary(checks, 1);
  }
  checks.push(pass("Supabase env"));

  let repos: ReturnType<typeof createRepositories>;
  try {
    repos = createRepositories(createServiceClient());
    await repos.getBrief();
    checks.push(pass("Supabase 연결"));
  } catch (err) {
    checks.push(
      fail(
        "supabase_connection_failed",
        "Supabase 연결",
        err instanceof Error ? err.message : String(err),
      ),
    );
    return exitWithSummary(checks, 1);
  }

  const mode = resolveNaverAdapterMode();
  if (mode !== "live" && !allowMock) {
    checks.push(
      fail(
        "adapter_mode_invalid",
        "NAVER_ADAPTER_MODE",
        `mode=${mode} (live 또는 --allow-mock)`,
      ),
    );
    return exitWithSummary(checks, 1);
  }
  checks.push(pass("NAVER_ADAPTER_MODE", mode));

  const blogId = blogIdEnv();
  if (!blogId) {
    checks.push(fail("missing_target", "VERIFY_NAVER_BLOG_ID", "필수"));
    printHelp();
    return exitWithSummary(checks, 1);
  }
  checks.push(pass("VERIFY_NAVER_BLOG_ID", blogId));

  const targetRefBase = buildTargetRef(blogId);
  const targetErr = validateTarget(action, targetRefBase);
  if (targetErr) {
    checks.push(fail("missing_target", "target 검증", targetErr));
    printHelp();
    return exitWithSummary(checks, 1);
  }
  const resolved = resolveNaverTarget({
    job: null as never,
    personId: "",
    channel: "blog",
    draftBody: draftFor(action),
    targetRef: targetRefBase,
  });
  checks.push(
    pass(
      "target 검증",
      action === "mutual_request"
        ? `blog=${resolved.blogId}`
        : `post=${resolved.postUrl}`,
    ),
  );

  // Policy daily limit snapshot (informational; executeActionJob enforces)
  const policy = await repos.getPolicy();
  const outcome = await repos.ensureOutcomeToday();
  const actionType = toActionType(action);
  if (actionType === "like" && policy.daily_limits.like != null) {
    checks.push(
      pass(
        "daily like guard",
        `${outcome.auto_like_count}/${policy.daily_limits.like} (executeActionJob 유지)`,
      ),
    );
  } else if (actionType === "like") {
    checks.push(
      pass("daily like guard", "limit unset · Policy/execute 경로 유지"),
    );
  } else {
    checks.push(
      pass(
        "daily limit guard",
        `${actionType} · executeActionJob preflight 유지`,
      ),
    );
  }

  try {
    const person = await repos.createPerson({
      display_name: `[verify:naver_${action}] ${testRunId}`,
      discover_meta: buildVerifyDiscoverMeta(testRunId, `naver_${action}`, {
        blog_id: blogId,
        post_url: resolved.postUrl,
      }),
    });
    personId = person.id;

    await repos.upsertBlogIdentity({
      person_id: person.id,
      blog_id: `verify_naver_act_${testRunId}`,
      profile_snapshot: {
        smoke_blog_id: blogId,
        smoke_post_url: resolved.postUrl,
      },
    });

    const workflow = await repos.createWorkflow({
      person_id: person.id,
      current_stage:
        action === "mutual_request" ? "warming" : "early_relationship",
      current_state: "active",
      next_action:
        actionType === "neighbor_request" ? "neighbor_request" : actionType,
      last_decision_id: null,
      priority: 20,
      goal: `verify_naver_${action}`,
    });
    await repos.setPersonActiveWorkflow(person.id, workflow.id);

    const target_ref: Record<string, unknown> = {
      ...targetRefBase,
      verify: true,
      test_run_id: testRunId,
      smoke: execute ? "execute" : "dry_run",
    };

    const job = await repos.createActionJob({
      parent_workflow_id: workflow.id,
      person_id: person.id,
      channel: "blog",
      action_type: actionType,
      risk: riskFor(actionType),
      status: "planned",
      draft_body: draftFor(action),
      target_ref,
      inbox_priority: 0,
    });
    checks.push(
      pass("ActionJob 생성", `type=${actionType} status=planned id=${job.id}`),
    );

    if (!execute) {
      checks.push(
        pass("dry-run", "실제 Adapter 실행 안 함 · --execute 로 실행"),
      );
      // Mark as informational dry_run success path
      console.log(
        "\n  (dry-run) ActionJob left as planned — cleanup unless --keep",
      );
    } else {
      console.log(`\n6) executeActionJob (${actionType})`);
      // Previous failed login must not permanently block retries
      clearSessionHealth();
      const outcomeExec = await executeActionJob(toPort(repos), job, {
        personDisplayName: person.display_name,
      });

      if (!outcomeExec.ok) {
        checks.push(
          fail(
            "adapter_execution_failed",
            "Adapter execute",
            outcomeExec.errorMessage,
          ),
        );
        const retry = Number(outcomeExec.job.target_ref?.retry_count ?? 0);
        const err = outcomeExec.job.error;
        if (outcomeExec.job.status === "failed" && (retry >= 1 || err)) {
          checks.push(
            pass(
              "retry/error 기록",
              `status=${outcomeExec.job.status} retry_count=${retry} error=${err ?? ""}`,
            ),
          );
        } else {
          checks.push(
            fail(
              "retry_record_missing",
              "retry/error 기록",
              `status=${outcomeExec.job.status} retry=${retry}`,
            ),
          );
        }
      } else {
        checks.push(
          pass(
            "Adapter execute",
            `status=${outcomeExec.job.status}${outcomeExec.job.target_ref?.skipped ? " skipped" : ""}`,
          ),
        );
      }

      const acts = await repos.listRecentActivities(person.id, 20);
      const related = acts.filter((a) => a.action_job_id === job.id);
      if (related.length === 0) {
        checks.push(
          fail("activity_missing", "Activity 기록", "action_job 관련 없음"),
        );
      } else {
        const kinds = related.map((a) => a.kind).join(",");
        const expect = outcomeExec.ok ? "executed" : "blocked";
        if (!related.some((a) => a.kind === expect)) {
          checks.push(
            fail(
              "activity_missing",
              "Activity 기록",
              `expected=${expect} got=${kinds}`,
            ),
          );
        } else {
          checks.push(pass("Activity 기록", `kind=${kinds}`));
        }
      }
    }
  } catch (err) {
    checks.push(
      fail(
        "adapter_execution_failed",
        "pipeline",
        err instanceof Error ? err.message : String(err),
      ),
    );
  } finally {
    if (action === "like" && execute) {
      const probePath = path.resolve(
        process.cwd(),
        ".data",
        "debug",
        "sympathy",
        "like_session_probe.json",
      );
      const exists = fs.existsSync(probePath);
      console.log("\n--- like session probe file check ---");
      console.log(`[session-probe] verify.finally cwd=${process.cwd()}`);
      console.log(`[session-probe] verify.finally path=${probePath}`);
      console.log(
        `[session-probe] verify.finally existsSync(like_session_probe.json)=${exists}`,
      );
      if (!exists) {
        console.log(
          "[session-probe] FILE MISSING after verify — dumpSessionBeforeLike/writeProbeJson never reached or wrote elsewhere",
        );
        console.log(
          "[session-probe] expected call stack: executeActionJob → ChannelExecutor → NaverBlogAdapter.like → withPage → clickSympathyIfOff → runLikeClickEvidence → dumpSessionBeforeLike → writeProbeJson",
        );
      }

      console.log("\n--- like session analysis (auto) ---");
      try {
        const { printLikeSessionAnalysis } =
          await import("../src/adapters/naver/analyzeLikeSession.js");
        printLikeSessionAnalysis();
      } catch (err) {
        console.warn(
          "[analyze] failed:",
          err instanceof Error ? err.message : err,
        );
      }

      console.log("\n--- TRACE SUMMARY (auto) ---");
      try {
        const { printTraceSummary } =
          await import("../src/adapters/naver/traceSummary.js");
        printTraceSummary();
      } catch (err) {
        console.warn(
          "[trace-summary] failed:",
          err instanceof Error ? err.message : err,
        );
      }
    }
    if (!keep && personId) {
      console.log("\ncleanup verify fixture");
      const cleaned = await cleanupVerifyPersons({ testRunId });
      console.log(`  deleted=${cleaned.deletedPersonIds.length}`);
    } else if (keep) {
      console.log(`\n--keep: person=${personId}`);
    }
  }

  printHelp();
  const failed = checks.filter((c) => !c.ok);
  // dry-run without --execute is success if checks pass (dry_run is PASS)
  return exitWithSummary(checks, failed.length > 0 ? 1 : 0);
}

function exitWithSummary(checks: Check[], code: number): never {
  const failed = checks.filter((c) => !c.ok);
  console.log("\n=== summary ===");
  console.log(
    `  total=${checks.length} pass=${checks.length - failed.length} fail=${failed.length}`,
  );
  if (failed.length > 0) {
    console.log("  failure causes:");
    for (const f of failed) {
      console.log(
        `    - ${f.code ?? "unknown"}: ${f.name}${f.detail ? ` (${f.detail})` : ""}`,
      );
    }
  }
  console.log(
    code === 0
      ? "\nverify:naver:actions OK\n"
      : "\nverify:naver:actions FAILED\n",
  );
  process.exit(code);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
