/**
 * Collect [TRACE] enter/RETURN events and print TRACE SUMMARY at verify end.
 */

export type TraceStep =
  | "executeActionJob"
  | "ChannelExecutor.execute"
  | "NaverBlogAdapter.like"
  | "withPage(like)"
  | "clickSympathyIfOff"
  | "runLikeClickEvidence";

type TraceEvent = {
  at: string;
  kind: "enter" | "return" | "blocked" | "skipped" | "gate";
  step?: TraceStep;
  reason?: string;
  detail?: string;
  raw: string;
};

const ORDER: TraceStep[] = [
  "executeActionJob",
  "ChannelExecutor.execute",
  "NaverBlogAdapter.like",
  "withPage(like)",
  "clickSympathyIfOff",
  "runLikeClickEvidence",
];

const events: TraceEvent[] = [];
const entered = new Set<TraceStep>();
const returned = new Map<TraceStep, string>();
let lastReturnReason: string | null = null;
let lastReturnStep: TraceStep | null = null;
let lastBlockedDetail: string | null = null;
const conditions: Record<string, string> = {};

function stamp(): string {
  return new Date().toISOString();
}

export function resetTraceSummary(): void {
  events.length = 0;
  entered.clear();
  returned.clear();
  lastReturnReason = null;
  lastReturnStep = null;
  lastBlockedDetail = null;
  for (const k of Object.keys(conditions)) delete conditions[k];
}

export function traceSetCondition(key: string, value: unknown): void {
  conditions[key] = String(value);
}

export function traceEnter(step: TraceStep, detail?: string): void {
  entered.add(step);
  const raw = `[TRACE] enter ${step}${detail ? ` ${detail}` : ""}`;
  events.push({ at: stamp(), kind: "enter", step, detail, raw });
  console.log(raw);
}

export function traceReturn(
  step: TraceStep,
  reason: string,
  detail?: string,
): void {
  returned.set(step, reason);
  lastReturnReason = reason;
  lastReturnStep = step;
  const raw = `[TRACE] RETURN reason=${reason}${detail ? ` detail=${detail}` : ""}`;
  events.push({ at: stamp(), kind: "return", step, reason, detail, raw });
  console.log(raw);
}

export function traceBlocked(reason: string, detail?: string): void {
  lastBlockedDetail = detail ? `${reason}: ${detail}` : reason;
  const raw = `[TRACE] blocked by ${reason}${detail ? ` ${detail}` : ""}`;
  events.push({ at: stamp(), kind: "blocked", reason, detail, raw });
  console.log(raw);
}

export function traceSkipped(reason: string, detail?: string): void {
  const raw = `[TRACE] skipped because ${reason}${detail ? ` ${detail}` : ""}`;
  events.push({ at: stamp(), kind: "skipped", reason, detail, raw });
  console.log(raw);
}

export function traceGate(detail: string): void {
  events.push({ at: stamp(), kind: "gate", detail, raw: `[TRACE] ${detail}` });
  console.log(`[TRACE] ${detail}`);
}

/** Map RETURN reason → file / approximate line / if condition (maintained with code) */
function locateReturn(reason: string): {
  file: string;
  line: string;
  ifCondition: string;
} {
  const table: Record<
    string,
    { file: string; line: string; ifCondition: string }
  > = {
    preflight_failed: {
      file: "src/adapters/executeActionJob.ts",
      line: "runPreflightGuards → if (blocked)",
      ifCondition: "blocked = await runPreflightGuards(...)  // truthy",
    },
    mark_running_failed: {
      file: "src/adapters/executeActionJob.ts",
      line: "markJobRunning catch",
      ifCondition: "catch (err) around port.markJobRunning",
    },
    adapter_failed: {
      file: "src/adapters/executeActionJob.ts",
      line: "if (!result.ok)",
      ifCondition: "!result.ok after ChannelExecutor.execute",
    },
    executed: {
      file: "src/adapters/executeActionJob.ts",
      line: "success return",
      ifCondition: "result.ok === true",
    },
    adapter_resolve_failed: {
      file: "src/adapters/channelExecutor.ts",
      line: "registry.resolve catch",
      ifCondition: "catch on registry.resolve",
    },
    unsupported_action: {
      file: "src/adapters/channelExecutor.ts",
      line: "if (!method)",
      ifCondition: "!ACTION_METHOD_REGISTRY[job.action_type]",
    },
    no_target: {
      file: "src/adapters/naver/NaverBlogAdapter.ts / sympathy.ts",
      line: "validateLikeTarget fail OR probe missing",
      ifCondition: "isFailResult(validated) OR probe.state==='missing'||!xpath||!locator",
    },
    mock_mode: {
      file: "src/adapters/naver/NaverBlogAdapter.ts",
      line: "if (this.mode === \"mock\")",
      ifCondition: 'this.mode === "mock"',
    },
    needs_relogin: {
      file: "src/adapters/naver/NaverBlogAdapter.ts",
      line: "withPage ensureNaverLogin check",
      ifCondition: 'session.getLoginState() !== "logged_in"',
    },
    withPage_throw: {
      file: "src/adapters/naver/NaverBlogAdapter.ts",
      line: "withPage catch",
      ifCondition: "catch after ensureNaverLogin or page fn",
    },
    withPage_fn_ok: {
      file: "src/adapters/naver/NaverBlogAdapter.ts",
      line: "withPage after fn(page)",
      ifCondition: "fn(page) completed without throw",
    },
    already_liked: {
      file: "src/adapters/naver/NaverBlogAdapter.ts or sympathy.ts",
      line: 'if (probe.state === "on")',
      ifCondition: 'probe.state === "on"',
    },
    structure_fail: {
      file: "src/adapters/naver/sympathy.ts",
      line: "if (!structure.ok)",
      ifCondition: "!scanTrusted && !structure.ok",
    },
    debug_disabled: {
      file: "src/adapters/naver/sympathy.ts",
      line: "if (!debugOn) / if (debugOn)",
      ifCondition: "sympathyDebugEnabled() === false",
    },
    evidence_done: {
      file: "src/adapters/naver/sympathy.ts",
      line: "after runLikeClickEvidence",
      ifCondition: "debugOn === true (evidence path)",
    },
    click_failed: {
      file: "src/adapters/naver/sympathy.ts",
      line: "if (!click.ok && !click.verifiedOn)",
      ifCondition: "!click.ok && !click.verifiedOn",
    },
    still_empty_heart: {
      file: "src/adapters/naver/sympathy.ts",
      line: "fallback verify path",
      ifCondition: "verified.on === false",
    },
    fatal: {
      file: "src/adapters/naver/sympathy.ts",
      line: "clickSympathyIfOff catch",
      ifCondition: "catch (err)",
    },
    browser_launch_failed: {
      file: "src/adapters/browser/BrowserSessionManager.ts",
      line: "chromium.launchPersistentContext",
      ifCondition: "launchPersistentContext throws (Executable doesn't exist)",
    },
    like_throw: {
      file: "src/adapters/naver/NaverBlogAdapter.ts",
      line: "like() catch",
      ifCondition: "catch (err) in like()",
    },
    like_ok: {
      file: "src/adapters/naver/NaverBlogAdapter.ts",
      line: "like success",
      ifCondition: "withPage completed && !skipped",
    },
    channel_executor_done: {
      file: "src/adapters/channelExecutor.ts",
      line: "after adapter[method]",
      ifCondition: "adapter method returned",
    },
    fallback_click_ok: {
      file: "src/adapters/naver/sympathy.ts",
      line: "fallback verify success",
      ifCondition: "verified.on === true",
    },
    runLikeClickEvidence_done: {
      file: "src/adapters/naver/likeClickDebug.ts",
      line: "end of runLikeClickEvidence try",
      ifCondition: "evidence collection finished",
    },
  };

  // normalize reason prefix
  const key = Object.keys(table).find((k) => reason === k || reason.startsWith(k)) ?? reason;
  return (
    table[key] ?? {
      file: "(TRACE reason not mapped — see last RETURN log)",
      line: "(unknown)",
      ifCondition: `(reason=${reason})`,
    }
  );
}

function passFail(step: TraceStep): "PASS" | "FAIL" {
  return entered.has(step) ? "PASS" : "FAIL";
}

export function printTraceSummary(): void {
  const lastReached =
    [...ORDER].reverse().find((s) => entered.has(s)) ?? "(none)";

  // First step that did not enter after a previous enter, or last return before evidence
  let stoppedAt: string = "(none — all steps entered)";
  for (let i = 0; i < ORDER.length; i++) {
    if (!entered.has(ORDER[i])) {
      stoppedAt = ORDER[i];
      break;
    }
  }
  if (entered.has("runLikeClickEvidence")) {
    stoppedAt = "(reached runLikeClickEvidence)";
  }

  const outerNoise = new Set([
    "adapter_failed",
    "channel_executor_done",
    "executed",
  ]);
  // Prefer deepest step's return over outer wrappers
  let reason = lastReturnReason ?? "(no RETURN recorded)";
  let reasonStep = lastReturnStep;
  for (const step of [...ORDER].reverse()) {
    const r = returned.get(step);
    if (r && !outerNoise.has(r)) {
      reason = r;
      reasonStep = step;
      break;
    }
  }

  const loc = locateReturn(reason);

  const condLines =
    Object.keys(conditions).length > 0
      ? Object.entries(conditions)
          .map(([k, v]) => `${k} = ${v}`)
          .join("\n")
      : "(no condition snapshots recorded)";

  const stackLines: string[] = [];
  for (const step of ORDER) {
    if (!entered.has(step)) break;
    stackLines.push(step);
  }
  stackLines.push(`RETURN (${reason})`);

  // Root cause one-liner from evidence only
  let root = `마지막 RETURN reason=${reason} (step=${lastReturnStep ?? "n/a"})`;
  if (!entered.has("executeActionJob")) {
    root = "executeActionJob에 진입하지 않음 — verify가 adapter execute까지 가지 않음";
  } else if (!entered.has("NaverBlogAdapter.like")) {
    root = `ChannelExecutor 이전/내부에서 중단 — RETURN=${reason}`;
  } else if (!entered.has("withPage(like)")) {
    root = `NaverBlogAdapter.like 진입 후 withPage 전에 중단 — RETURN=${reason}`;
  } else if (!entered.has("clickSympathyIfOff")) {
    root = `withPage(like) 내부에서 clickSympathyIfOff 호출 전 중단 — RETURN=${reason}`;
  } else if (!entered.has("runLikeClickEvidence")) {
    root = `clickSympathyIfOff까지 왔으나 runLikeClickEvidence 미진입 — RETURN/blocked=${reason} / ${lastBlockedDetail ?? ""}`;
  } else {
    root = `runLikeClickEvidence까지 도달함 — 최종 RETURN=${reason}`;
  }

  let nextFile = loc.file;
  let nextFn = String(reasonStep ?? stoppedAt);
  let nextIf = loc.ifCondition;

  // Refine root from deepest stop
  if (reason === "like_throw" || reason === "browser_launch_failed") {
    root =
      "withPage(like)에서 브라우저 launch/newPage 실패로 clickSympathyIfOff에 진입하지 못함";
    nextFile = "src/adapters/browser/BrowserSessionManager.ts";
    nextFn = "getContext / launchPersistentContext";
    nextIf = "chromium.launchPersistentContext (Executable doesn't exist)";
  } else if (!entered.has("runLikeClickEvidence") && entered.has("clickSympathyIfOff")) {
    root = `clickSympathyIfOff까지 왔으나 runLikeClickEvidence 미진입 — RETURN=${reason}`;
  } else if (!entered.has("clickSympathyIfOff") && entered.has("withPage(like)")) {
    root = `withPage(like) 진입 후 clickSympathyIfOff 호출 전 중단 — RETURN=${reason}`;
  }

  console.log(`
==========================
TRACE SUMMARY
==========================

executeActionJob          : ${passFail("executeActionJob")}
ChannelExecutor.execute   : ${passFail("ChannelExecutor.execute")}
NaverBlogAdapter.like     : ${passFail("NaverBlogAdapter.like")}
withPage(like)            : ${passFail("withPage(like)")}
clickSympathyIfOff        : ${passFail("clickSympathyIfOff")}
runLikeClickEvidence      : ${passFail("runLikeClickEvidence")}

마지막으로 도달한 함수:
${lastReached}

중간에 종료된 함수:
${stoppedAt}

RETURN reason:
${reason}

해당 return이 발생한 파일:
${loc.file}

해당 줄 번호:
${loc.line}

해당 if 조건:
${loc.ifCondition}

실제 조건값:
${condLines}

실행 경로(call stack):

${stackLines.join("\n↓\n")}

==========================
FINAL ROOT CAUSE
==========================

${root}

다음에 수정해야 할 파일
${nextFile}

다음에 수정해야 할 함수
${nextFn}

다음에 수정해야 할 if문
${nextIf}
`);
}
