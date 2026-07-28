/**
 * Structured action_job failure payload (admin adapter → target_ref.execution_failure).
 * Shape mirrors worker/src/jobs/actionFailure.ts for Admin UI parity.
 */

export type ActionFailureDetail = {
  error_code: string;
  error_message: string;
  failed_step: string;
  failed_at: string;
  detail?: Record<string, unknown>;
  steps?: string[];
  retryable: boolean;
};

const RETRYABLE_CODES = new Set([
  "GOTO_FAILED",
  "TIMEOUT",
  "NETWORK",
  "VERIFY_FAILED",
  "CLICK_FAILED",
  "SUBMIT_FAILED",
  "INPUT_NOT_FOUND",
  "COMMENT_INPUT_NOT_FOUND",
  "COMMENT_SUBMIT_NOT_FOUND",
  "NEIGHBOR_CONFIRM_NOT_FOUND",
  "PAGE_LOAD_FAILED",
  "LIKE_CLICK_FAILED",
  "LIKE_VERIFY_FAILED",
  "COMMENT_FILL_FAILED",
  "COMMENT_SUBMIT_FAILED",
  "COMMENT_VERIFY_FAILED",
]);

export function isRetryableErrorCode(code: string): boolean {
  return RETRYABLE_CODES.has(code);
}

export function makeFailure(input: {
  error_code: string;
  error_message: string;
  failed_step: string;
  detail?: Record<string, unknown>;
  steps?: string[];
  retryable?: boolean;
}): ActionFailureDetail {
  const error_code = input.error_code.trim() || "UNKNOWN";
  return {
    error_code,
    error_message: input.error_message.trim().slice(0, 2000) || error_code,
    failed_step: input.failed_step.trim() || "unknown",
    failed_at: new Date().toISOString(),
    detail: input.detail,
    steps: input.steps,
    retryable:
      input.retryable ?? isRetryableErrorCode(error_code),
  };
}

export function failureToErrorColumn(f: ActionFailureDetail): string {
  const step = f.failed_step ? ` @${f.failed_step}` : "";
  return `[${f.error_code}] ${f.error_message}${step}`.slice(0, 2000);
}

export function mergeExecutionFailureIntoTargetRef(
  previous: Record<string, unknown> | null | undefined,
  failure: ActionFailureDetail,
): Record<string, unknown> {
  const base =
    previous && typeof previous === "object" && !Array.isArray(previous)
      ? { ...previous }
      : {};
  return {
    ...base,
    execution_failure: failure,
    last_failed_at: failure.failed_at,
    error_code: failure.error_code,
  };
}

export function classifyWorkerErrorText(
  raw: string,
  fallbackStep = "unknown",
): ActionFailureDetail {
  const msg = raw.trim();
  const lower = msg.toLowerCase();

  if (/timeout/i.test(msg)) {
    return makeFailure({
      error_code: "TIMEOUT",
      error_message: msg,
      failed_step: fallbackStep,
    });
  }
  if (/goto failed|navigation|page\.goto/i.test(msg)) {
    return makeFailure({
      error_code: "GOTO_FAILED",
      error_message: msg,
      failed_step: "goto",
    });
  }
  if (/login required|LOGIN_REQUIRED|relogin|nid\.naver\.com/i.test(msg)) {
    return makeFailure({
      error_code: "LOGIN_REQUIRED",
      error_message: msg.includes("LOGIN")
        ? msg
        : "네이버 로그인이 필요합니다",
      failed_step: "post_loaded",
      retryable: false,
    });
  }
  if (/neighbor request button not found|NEIGHBOR_BUTTON_NOT_FOUND|NEIGHBOR_BUTTON_NOT_AVAILABLE/i.test(msg)) {
    return makeFailure({
      error_code: "NEIGHBOR_BUTTON_NOT_AVAILABLE",
      error_message: "서로이웃 신청 버튼 없음",
      failed_step: "button_search",
      retryable: false,
    });
  }
  if (/confirm button not found/i.test(msg)) {
    return makeFailure({
      error_code: "NEIGHBOR_CONFIRM_NOT_FOUND",
      error_message: "서로이웃 신청 확인 버튼을 찾지 못했습니다",
      failed_step: "confirm",
    });
  }
  if (/verify failed|still empty heart|did not register/i.test(msg)) {
    return makeFailure({
      error_code: "LIKE_VERIFY_FAILED",
      error_message: msg,
      failed_step: "verify",
    });
  }
  if (/like button not clickable|like click/i.test(lower)) {
    return makeFailure({
      error_code: "LIKE_CLICK_FAILED",
      error_message: msg,
      failed_step: "like_click",
    });
  }
  if (/like button not found|LIKE_BUTTON_NOT_FOUND|LIKE_BUTTON_NOT_AVAILABLE/i.test(msg)) {
    return makeFailure({
      error_code: "LIKE_BUTTON_NOT_AVAILABLE",
      error_message: "공감 버튼이 없는 글입니다.",
      failed_step: "button_search",
      retryable: false,
    });
  }
  if (/comment input|fill did not stick|not editable|COMMENT_INPUT_NOT_FOUND/i.test(msg)) {
    return makeFailure({
      error_code: "COMMENT_INPUT_NOT_FOUND",
      error_message: msg,
      failed_step: "comment_input_search",
    });
  }
  if (/comment fill|COMMENT_FILL_FAILED/i.test(msg)) {
    return makeFailure({
      error_code: "COMMENT_FILL_FAILED",
      error_message: msg,
      failed_step: "fill_begin",
    });
  }
  if (/submit button not found|comment submit|COMMENT_SUBMIT/i.test(lower)) {
    return makeFailure({
      error_code: "COMMENT_SUBMIT_FAILED",
      error_message: msg,
      failed_step: "comment_submit",
    });
  }
  if (/comment_not_found|COMMENT_VERIFY_FAILED/i.test(msg)) {
    return makeFailure({
      error_code: "COMMENT_VERIFY_FAILED",
      error_message: msg,
      failed_step: "verify",
    });
  }
  if (/econnrefused|network|websocket|cdp/i.test(lower)) {
    return makeFailure({
      error_code: "NETWORK",
      error_message: msg,
      failed_step: fallbackStep,
    });
  }

  return makeFailure({
    error_code: "UNKNOWN",
    error_message: msg || "알 수 없는 오류",
    failed_step: fallbackStep,
    retryable: true,
  });
}
