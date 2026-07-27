/**
 * Naver Live Adapter pre-flight + visit-only smoke.
 *
 * Flow:
 *   1) Supabase 연결
 *   2) NAVER_ADAPTER_MODE (live 기본, mock은 --allow-mock)
 *   3) BrowserSessionManager
 *   4) Naver 로그인 probe
 *   5) verify Person / Workflow / ActionJob(target) 생성
 *   6) visit만 Adapter execute
 *   7) Activity 확인
 *   8) like / comment / mutual_request 는 ActionJob 생성·target 검증만 (실행 금지)
 *
 * Usage:
 *   npm run verify:naver              # visit smoke (live)
 *   npm run verify:naver -- --keep    # fixture 유지
 *   npm run verify:naver -- --plan-only   # 실행 없이 준비만
 *   npm run verify:naver -- --allow-mock  # mock mode 허용
 *
 * Env:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   NAVER_ADAPTER_MODE=live
 *   VERIFY_NAVER_BLOG_ID              # visit / mutual target
 *   VERIFY_NAVER_POST_URL             # like / comment target (optional for plan)
 *   VERIFY_NAVER_LOG_NO               # alternative: blog_id + log_no
 *   NAVER_ID / NAVER_PASSWORD or browser profile session
 *
 * Safety:
 *   like / comment / neighbor_request 는 이 스크립트에서 절대 execute하지 않음.
 *   VERIFY_NAVER_ALLOW_RISKY=1 이어도 차단 (별도 수동 경로 없음).
 */

import fs from "node:fs";
import path from "node:path";
import {
  executeActionJob,
  type ActionExecutionPort,
} from "../src/adapters/executeActionJob";
import {
  BrowserSessionManager,
  getNaverBrowserSession,
} from "../src/adapters/browser/BrowserSessionManager";
import {
  NaverBlogAdapter,
  resolveNaverAdapterMode,
} from "../src/adapters/naver/NaverBlogAdapter";
import { resolveNaverTarget } from "../src/adapters/naver/target";
import { readSessionHealth } from "../src/adapters/naver/sessionHealth";
import { createServiceClient } from "../src/lib/supabase";
import { createRepositories } from "../src/repositories/index";
import type { ActionType } from "../src/workers/types";
import { cleanupVerifyPersons } from "./verify-cleanup";
import { buildVerifyDiscoverMeta, newTestRunId } from "./verifyMeta";

type FailCode =
  | "missing_env"
  | "supabase_connection_failed"
  | "adapter_mode_invalid"
  | "missing_browser_profile"
  | "browser_session_failed"
  | "login_required"
  | "captcha_required"
  | "missing_target"
  | "adapter_execution_failed"
  | "activity_missing"
  | "risky_action_blocked";

type Check = { name: string; ok: boolean; detail?: string; code?: FailCode };

/** Only visit may call executeActionJob in this script. */
const EXECUTABLE_SMOKE_ACTIONS = new Set<ActionType>(["visit"]);
const RISKY_ACTIONS: ActionType[] = ["like", "comment", "neighbor_request"];

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

function classifyLoginError(msg: string): FailCode {
  const m = msg.toLowerCase();
  if (m.includes("captcha")) return "captcha_required";
  if (
    m.includes("login") ||
    m.includes("relogin") ||
    m.includes("session") ||
    m.includes("expired")
  ) {
    return "login_required";
  }
  return "adapter_execution_failed";
}

function smokeBlogId(): string | null {
  const id =
    process.env.VERIFY_NAVER_BLOG_ID?.trim() ||
    process.env.NAVER_SMOKE_BLOG_ID?.trim() ||
    "";
  return id || null;
}

function smokePostTarget(blogId: string): {
  postUrl: string | null;
  logNo: string | null;
  targetRef: Record<string, unknown>;
} {
  const postUrl = process.env.VERIFY_NAVER_POST_URL?.trim() || null;
  const logNo = process.env.VERIFY_NAVER_LOG_NO?.trim() || null;
  const targetRef: Record<string, unknown> = { blog_id: blogId };
  if (postUrl) targetRef.post_url = postUrl;
  if (logNo) targetRef.log_no = logNo;
  return { postUrl, logNo, targetRef };
}

function profileDir(): string {
  return (
    process.env.NAVER_BROWSER_PROFILE?.trim() ||
    process.env.BROWSER_USER_DATA_DIR?.trim() ||
    path.join(process.cwd(), ".data", "browser", "naver-profile")
  );
}

/** Hard guard — never execute like/comment/mutual from verify:naver. */
function assertSmokeExecuteAllowed(actionType: ActionType): void {
  if (!EXECUTABLE_SMOKE_ACTIONS.has(actionType)) {
    throw new Error(
      `risky_action_blocked: verify:naver cannot execute ${actionType} (visit only)`,
    );
  }
  if (process.env.VERIFY_NAVER_ALLOW_RISKY === "1") {
    console.warn(
      "  [WARN] VERIFY_NAVER_ALLOW_RISKY=1 ignored — like/comment/mutual still blocked",
    );
  }
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

function printCommandHelp() {
  console.log(`
=== commands ===
  # Live visit smoke (권장)
  NAVER_ADAPTER_MODE=live VERIFY_NAVER_BLOG_ID=<blogId> npm run verify:naver

  # 실행 없이 준비만 (login/target/plan jobs)
  npm run verify:naver -- --plan-only

  # fixture 유지
  npm run verify:naver -- --keep

  # mock만 (브라우저 없음)
  NAVER_ADAPTER_MODE=mock npm run verify:naver -- --allow-mock

  # 별도 seed 불필요 — Person/Workflow/ActionJob 은 이 스크립트가 생성
  # (verify:loop 용 npm run seed 는 mock 루프용이며 Live 대상과 무관)

=== DB created by this script ===
  persons          [verify:naver_visit] + discover_meta.verify
  workflows        next_action=visit
  channel_identities  verify_naver_<runId> (충돌 방지용 키)
  action_jobs      visit(planned→executed) + like/comment/neighbor(planned only)
  activity_items   visit 실행 결과

=== not executed (safety) ===
  like / comment / neighbor_request
`);
}

async function main() {
  const keep = process.argv.includes("--keep");
  const allowMock = process.argv.includes("--allow-mock");
  const planOnly = process.argv.includes("--plan-only");
  const checks: Check[] = [];
  const testRunId = newTestRunId();
  let personId: string | null = null;
  let session: BrowserSessionManager | null = null;

  console.log(`\n=== verify:naver test_run_id=${testRunId} ===`);
  console.log(
    `  mode_intent=live smoke · execute=${planOnly ? "none (--plan-only)" : "visit only"}\n`,
  );

  process.env.NAVER_DELAY_VISIT_MIN_MS ??= "200";
  process.env.NAVER_DELAY_VISIT_MAX_MS ??= "600";

  // ── 1) Env / Supabase ──────────────────────────────────────────
  console.log("1) Supabase / env");
  if (
    !process.env.SUPABASE_URL?.trim() ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  ) {
    checks.push(
      fail(
        "missing_env",
        "Supabase env",
        "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 필요",
      ),
    );
    printCommandHelp();
    return exitWithSummary(checks, 1);
  }
  checks.push(pass("Supabase env"));

  let repos: ReturnType<typeof createRepositories>;
  try {
    const db = createServiceClient();
    repos = createRepositories(db);
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
    printCommandHelp();
    return exitWithSummary(checks, 1);
  }

  // ── 2) Adapter mode ────────────────────────────────────────────
  console.log("\n2) NAVER_ADAPTER_MODE");
  const mode = resolveNaverAdapterMode();
  if (mode !== "live" && !allowMock) {
    checks.push(
      fail(
        "adapter_mode_invalid",
        "NAVER_ADAPTER_MODE",
        `mode=${mode} (live 필요 · mock이면 --allow-mock)`,
      ),
    );
    printCommandHelp();
    return exitWithSummary(checks, 1);
  }
  checks.push(
    pass(
      "NAVER_ADAPTER_MODE",
      mode === "live" ? "live" : `mock (--allow-mock)`,
    ),
  );

  // ── 3) Browser profile / session ───────────────────────────────
  console.log("\n3) BrowserSessionManager");
  const profile = profileDir();
  if (!fs.existsSync(profile)) {
    try {
      fs.mkdirSync(profile, { recursive: true });
      checks.push(pass("브라우저 프로필", `생성됨 ${profile}`));
    } catch (err) {
      checks.push(
        fail(
          "missing_browser_profile",
          "브라우저 프로필",
          err instanceof Error ? err.message : String(err),
        ),
      );
      return exitWithSummary(checks, 1);
    }
  } else {
    checks.push(pass("브라우저 프로필", profile));
  }

  if (mode === "mock") {
    checks.push(pass("BrowserSessionManager 실행", "mock — skip launch"));
  } else {
    try {
      session = getNaverBrowserSession();
      const page = await session.newPage();
      await page
        .goto("about:blank", { timeout: 15_000 })
        .catch(() => undefined);
      await page.close().catch(() => undefined);
      checks.push(pass("BrowserSessionManager 실행"));
    } catch (err) {
      checks.push(
        fail(
          "browser_session_failed",
          "BrowserSessionManager 실행",
          err instanceof Error ? err.message : String(err),
        ),
      );
      await session?.close().catch(() => undefined);
      return exitWithSummary(checks, 1);
    }
  }

  // ── 4) Naver login ─────────────────────────────────────────────
  console.log("\n4) Naver 로그인 상태");
  if (mode === "mock") {
    checks.push(pass("Naver 로그인", "mock — skip"));
  } else if (session) {
    try {
      const adapter = new NaverBlogAdapter(session);
      const ready = await adapter.checkLoginReady();
      if (ready.ready) {
        checks.push(pass("Naver 로그인", ready.state));
      } else {
        const hasCreds =
          Boolean(process.env.NAVER_ID?.trim()) &&
          Boolean(process.env.NAVER_PASSWORD?.trim());
        if (!hasCreds) {
          const health = readSessionHealth();
          checks.push(
            fail(
              "login_required",
              "Naver 로그인",
              `state=${ready.state}${health?.reason ? ` · ${health.reason}` : ""} · NAVER_ID/PASSWORD 또는 BROWSER_HEADLESS=false 수동 로그인`,
            ),
          );
          await session.close().catch(() => undefined);
          return exitWithSummary(checks, 1);
        }
        checks.push(
          pass(
            "Naver 로그인",
            `state=${ready.state} · credentials 있음 (visit ensureLogin)`,
          ),
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      checks.push(fail(classifyLoginError(msg), "Naver 로그인", msg));
      await session.close().catch(() => undefined);
      return exitWithSummary(checks, 1);
    }
  }

  // ── 5) Targets + fixtures ──────────────────────────────────────
  console.log("\n5) DB fixtures + target 검증");
  const blogId = smokeBlogId();
  if (!blogId) {
    checks.push(
      fail(
        "missing_target",
        "visit target",
        "VERIFY_NAVER_BLOG_ID (또는 NAVER_SMOKE_BLOG_ID) 필요",
      ),
    );
    await session?.close().catch(() => undefined);
    printCommandHelp();
    return exitWithSummary(checks, 1);
  }
  checks.push(pass("visit/mutual target", `blog_id=${blogId}`));

  const post = smokePostTarget(blogId);
  const resolvedPost = resolveNaverTarget({
    job: null as never,
    personId: "",
    channel: "blog",
    draftBody: null,
    targetRef: post.targetRef,
  });
  const postReady = Boolean(resolvedPost.postUrl);
  if (postReady) {
    checks.push(
      pass("like/comment target", `post_url=${resolvedPost.postUrl}`),
    );
  } else {
    checks.push(
      pass(
        "like/comment target",
        "미설정 (VERIFY_NAVER_POST_URL 또는 VERIFY_NAVER_LOG_NO) — plan만 스킵, visit은 진행",
      ),
    );
  }

  let visitJobId: string | null = null;
  try {
    const person = await repos.createPerson({
      display_name: `[verify:naver_visit] ${testRunId}`,
      discover_meta: buildVerifyDiscoverMeta(testRunId, "naver_visit", {
        blog_id: blogId,
        post_url: resolvedPost.postUrl,
      }),
    });
    personId = person.id;

    await repos.upsertBlogIdentity({
      person_id: person.id,
      blog_id: `verify_naver_${testRunId}`,
      profile_snapshot: {
        smoke_blog_id: blogId,
        smoke_post_url: resolvedPost.postUrl,
      },
    });

    const workflow = await repos.createWorkflow({
      person_id: person.id,
      current_stage: "warming",
      current_state: "active",
      next_action: "visit",
      last_decision_id: null,
      priority: 10,
      goal: "verify_naver_visit",
    });
    await repos.setPersonActiveWorkflow(person.id, workflow.id);
    checks.push(
      pass(
        "Person/Workflow 생성",
        `person=${person.id.slice(0, 8)}… workflow=${workflow.id.slice(0, 8)}…`,
      ),
    );

    const visitJob = await repos.createActionJob({
      parent_workflow_id: workflow.id,
      person_id: person.id,
      channel: "blog",
      action_type: "visit",
      risk: "low",
      status: "planned",
      target_ref: {
        blog_id: blogId,
        verify: true,
        test_run_id: testRunId,
        smoke: "visit_only",
      },
      inbox_priority: 0,
    });
    visitJobId = visitJob.id;
    checks.push(
      pass("visit ActionJob 생성", `status=planned id=${visitJob.id}`),
    );

    // Plan risky jobs — never execute
    console.log("\n5b) 위험 ActionJob plan only (실행 안 함)");
    for (const actionType of RISKY_ACTIONS) {
      const needsPost = actionType === "like" || actionType === "comment";
      if (needsPost && !postReady) {
        checks.push(
          pass(
            `${actionType} plan`,
            "skipped — post target 없음 (실행도 안 함)",
          ),
        );
        continue;
      }

      const risk = actionType === "like" ? "low" : "high";
      const target_ref: Record<string, unknown> = {
        blog_id: blogId,
        verify: true,
        test_run_id: testRunId,
        smoke: "plan_only_no_execute",
        planned_not_executed: true,
      };
      if (resolvedPost.postUrl) target_ref.post_url = resolvedPost.postUrl;
      if (resolvedPost.logNo) target_ref.log_no = resolvedPost.logNo;

      // Target shape check via resolveNaverTarget
      const shape = resolveNaverTarget({
        job: visitJob,
        personId: person.id,
        channel: "blog",
        draftBody:
          actionType === "comment" ? "verify plan-only draft (not sent)" : null,
        targetRef: target_ref,
      });
      if (needsPost && !shape.postUrl) {
        checks.push(
          fail("missing_target", `${actionType} target`, "post_url 해석 실패"),
        );
        continue;
      }
      if (
        actionType === "neighbor_request" &&
        !shape.blogId &&
        !shape.blogUrl
      ) {
        checks.push(
          fail("missing_target", `${actionType} target`, "blog_id 없음"),
        );
        continue;
      }

      const planned = await repos.createActionJob({
        parent_workflow_id: workflow.id,
        person_id: person.id,
        channel: "blog",
        action_type: actionType,
        risk,
        status: "planned",
        draft_body:
          actionType === "comment"
            ? "verify plan-only draft (not sent)"
            : actionType === "neighbor_request"
              ? "verify plan-only mutual (not sent)"
              : null,
        target_ref,
        inbox_priority: 0,
      });
      checks.push(
        pass(
          `${actionType} ActionJob plan`,
          `status=planned id=${planned.id} · execute=BLOCKED`,
        ),
      );
    }

    // Safety: confirm we never call execute for risky types
    for (const actionType of RISKY_ACTIONS) {
      try {
        assertSmokeExecuteAllowed(actionType);
        checks.push(
          fail(
            "risky_action_blocked",
            `${actionType} execute guard`,
            "guard failed to block",
          ),
        );
      } catch {
        checks.push(pass(`${actionType} execute guard`, "blocked"));
      }
    }

    // ── 6) visit execute (optional) ──────────────────────────────
    console.log("\n6) Adapter execute");
    if (planOnly) {
      checks.push(pass("Adapter execute", "skipped (--plan-only)"));
    } else {
      assertSmokeExecuteAllowed("visit");
      console.log("   → visit only (like/comment/mutual 실행 안 함)");
      const outcome = await executeActionJob(toPort(repos), visitJob, {
        personDisplayName: person.display_name,
      });
      if (!outcome.ok) {
        checks.push(
          fail(
            classifyLoginError(outcome.errorMessage),
            "visit execute",
            outcome.errorMessage,
          ),
        );
      } else {
        checks.push(pass("visit execute", `status=${outcome.job.status}`));
      }

      // ── 7) Activity ──────────────────────────────────────────
      console.log("\n7) Activity 기록");
      const acts = await repos.listRecentActivities(person.id, 20);
      const related = acts.filter((a) => a.action_job_id === visitJobId);
      if (related.length === 0) {
        checks.push(
          fail("activity_missing", "Activity 기록", "visit job Activity 없음"),
        );
      } else {
        const kinds = related.map((a) => a.kind).join(",");
        const expected = outcome.ok ? "executed" : "blocked";
        if (!related.some((a) => a.kind === expected)) {
          checks.push(
            fail(
              "activity_missing",
              "Activity 기록",
              `expected=${expected} got=${kinds}`,
            ),
          );
        } else {
          checks.push(pass("Activity 기록", `kind=${kinds}`));
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = msg.includes("risky_action_blocked")
      ? "risky_action_blocked"
      : classifyLoginError(msg);
    checks.push(fail(code, "verify pipeline", msg));
  } finally {
    await session?.close().catch(() => undefined);
    if (!keep && personId) {
      console.log("\n8) cleanup verify fixture");
      const cleaned = await cleanupVerifyPersons({ testRunId });
      console.log(
        `  deleted=${cleaned.deletedPersonIds.length} (test_run_id=${testRunId})`,
      );
    } else if (keep) {
      console.log(`\n8) --keep: fixture retained person=${personId}`);
    }
  }

  printCommandHelp();
  const failed = checks.filter((c) => !c.ok);
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
  console.log(code === 0 ? "\nverify:naver OK\n" : "\nverify:naver FAILED\n");
  process.exit(code);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
