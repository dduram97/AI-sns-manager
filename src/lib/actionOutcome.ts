/**
 * Non-failure execution outcomes (skipped / not_available / excluded / executed).
 * Stored on target_ref.execution_result — mirrors worker/src/jobs/actionOutcome.ts.
 */

export type ActionSkipDetail = {
  outcome: "skipped" | "not_available" | "excluded";
  reason_code: string;
  reason_message: string;
  failed_step: string;
  skipped_at: string;
  detail?: Record<string, unknown>;
  steps?: string[];
};

export function makeSkip(input: {
  outcome?: "skipped" | "not_available" | "excluded";
  reason_code: string;
  reason_message: string;
  failed_step: string;
  detail?: Record<string, unknown>;
  steps?: string[];
}): ActionSkipDetail {
  return {
    outcome: input.outcome ?? "skipped",
    reason_code: input.reason_code.trim() || "SKIPPED",
    reason_message: input.reason_message.trim().slice(0, 2000) || "제외됨",
    failed_step: input.failed_step.trim() || "unknown",
    skipped_at: new Date().toISOString(),
    detail: input.detail,
    steps: input.steps,
  };
}

export function skipToErrorColumn(s: ActionSkipDetail): string {
  return `[${s.reason_code}] ${s.reason_message} @${s.failed_step}`.slice(
    0,
    2000,
  );
}

export function mergeExecutionResultIntoTargetRef(
  previous: Record<string, unknown> | null | undefined,
  result: {
    outcome: string;
    reason_code?: string;
    reason_message?: string;
    failed_step?: string;
    detail?: Record<string, unknown>;
    steps?: string[];
    like?: Record<string, unknown>;
    comment?: Record<string, unknown>;
    failure_reason?: { code: string; message: string };
    [key: string]: unknown;
  },
): Record<string, unknown> {
  const base =
    previous && typeof previous === "object" && !Array.isArray(previous)
      ? { ...previous }
      : {};
  return {
    ...base,
    execution_result: result,
  };
}

export function statusForSkip(s: ActionSkipDetail): "skipped" | "excluded" {
  if (
    s.outcome === "excluded" ||
    s.reason_code.startsWith("NEIGHBOR_") ||
    s.reason_code === "ALREADY_NEIGHBOR" ||
    s.reason_code === "ALREADY_PENDING" ||
    s.reason_code === "REQUEST_NOT_AVAILABLE"
  ) {
    return "excluded";
  }
  return "skipped";
}
