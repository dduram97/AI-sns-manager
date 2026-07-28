/**
 * Non-failure execution outcomes (skipped / not_available / excluded).
 * Stored on target_ref.execution_result — does not count toward success quota.
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

/** Soft / non-retryable skip codes (ops exclusion, not hard failures). */
export const SKIP_REASON_CODES = new Set([
  "LIKE_BUTTON_NOT_AVAILABLE",
  "LIKE_BUTTON_NOT_FOUND",
  "NEIGHBOR_MUTUAL_NOT_AVAILABLE",
  "NEIGHBOR_BUTTON_NOT_AVAILABLE",
  "NEIGHBOR_BUTTON_NOT_FOUND",
  "ALREADY_NEIGHBOR",
  "ALREADY_PENDING",
  "REQUEST_NOT_AVAILABLE",
]);

export function isSkipReasonCode(code: string): boolean {
  return SKIP_REASON_CODES.has(code);
}

/** DB status for a skip detail */
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
