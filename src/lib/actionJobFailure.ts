/**
 * Parse action_jobs failure / skip for Admin UI
 * (mirrors worker target_ref.execution_failure | execution_result).
 */

export type ParsedActionFailure = {
  errorCode: string;
  errorMessage: string;
  failedStep: string;
  failedStepLabel: string;
  failedAt: string | null;
  detail: Record<string, unknown> | null;
  steps: string[];
  retryable: boolean;
  /** One-line summary for cards */
  summary: string;
  /** soft skip / excluded (not a hard failure) */
  kind: "failure" | "skipped" | "excluded";
};

const STEP_LABELS: Record<string, string> = {
  goto: "페이지 이동",
  goto_begin: "페이지 이동",
  visit_start: "방문 시작",
  page_loaded: "페이지 로드",
  post_loaded: "글 로드",
  relation_detect: "관계 판별",
  relation_probe: "관계 판별",
  button_search: "버튼 탐색",
  button_click: "버튼 클릭",
  modal_open: "모달 열림",
  option_select: "옵션 선택",
  open_classic: "이웃추가 버튼 탐색(classic)",
  open_discover: "이웃추가 버튼 탐색(discover)",
  open_buddy: "이웃추가 버튼 탐색",
  fill_message: "신청 메시지 입력",
  confirm: "신청 확인",
  confirm_click: "확인 클릭",
  submit: "신청 제출",
  verify: "결과 검증",
  like_button_search: "공감 버튼 탐색",
  find_like_button: "공감 버튼 탐색",
  like_click: "공감 클릭",
  comment_input_search: "댓글 입력창 탐색",
  comment_submit: "댓글 등록",
  fill_begin: "댓글 입력",
  unknown: "알 수 없음",
};

export function failedStepLabel(step: string | null | undefined): string {
  if (!step) return "알 수 없음";
  return STEP_LABELS[step] ?? step;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function fromStructured(
  raw: Record<string, unknown>,
  input: { error?: string | null; targetRef?: Record<string, unknown> | null },
  kind: "failure" | "skipped" | "excluded",
): ParsedActionFailure {
  const errorCode =
    typeof raw.error_code === "string" && raw.error_code.trim()
      ? raw.error_code.trim()
      : typeof raw.reason_code === "string" && raw.reason_code.trim()
        ? raw.reason_code.trim()
        : "UNKNOWN";
  const errorMessage =
    typeof raw.error_message === "string" && raw.error_message.trim()
      ? raw.error_message.trim()
      : typeof raw.reason_message === "string" && raw.reason_message.trim()
        ? raw.reason_message.trim()
        : (input.error ?? "").trim() || errorCode;
  const failedStep =
    typeof raw.failed_step === "string" && raw.failed_step.trim()
      ? raw.failed_step.trim()
      : "unknown";
  const failedAt =
    typeof raw.failed_at === "string"
      ? raw.failed_at
      : typeof raw.skipped_at === "string"
        ? raw.skipped_at
        : null;
  const detail = asRecord(raw.detail);
  const steps = Array.isArray(raw.steps)
    ? raw.steps.filter((s): s is string => typeof s === "string")
    : [];
  const retryable =
    kind === "failure"
      ? typeof raw.retryable === "boolean"
        ? raw.retryable
        : true
      : false;
  const prefix =
    kind === "excluded" ? "제외" : kind === "skipped" ? "미처리" : "❌ 실패";
  return {
    errorCode,
    errorMessage,
    failedStep,
    failedStepLabel: failedStepLabel(failedStep),
    failedAt,
    detail,
    steps,
    retryable,
    kind,
    summary: `${prefix} · ${failedStepLabel(failedStep)} · ${errorMessage}`,
  };
}

export function parseActionJobFailure(input: {
  error?: string | null;
  targetRef?: Record<string, unknown> | null;
  status?: string | null;
}): ParsedActionFailure | null {
  const ref = input.targetRef ?? {};
  const status = (input.status ?? "").trim();

  const result = asRecord(ref.execution_result);
  if (result) {
    const outcome =
      typeof result.outcome === "string" ? result.outcome : "skipped";
    const kind: "skipped" | "excluded" =
      outcome === "excluded" ||
      status === "excluded" ||
      (typeof result.reason_code === "string" &&
        result.reason_code.startsWith("NEIGHBOR_"))
        ? "excluded"
        : "skipped";
    return fromStructured(result, input, kind);
  }

  const raw = asRecord(ref.execution_failure);
  if (raw) {
    return fromStructured(raw, input, "failure");
  }

  const legacy = (input.error ?? "").trim();
  if (!legacy) return null;

  // Soft skip codes in error column
  if (
    status === "skipped" ||
    status === "excluded" ||
    /LIKE_BUTTON_NOT_AVAILABLE|NEIGHBOR_BUTTON_NOT_AVAILABLE|ALREADY_NEIGHBOR|ALREADY_PENDING/.test(
      legacy,
    )
  ) {
    const m = legacy.match(/^\[([A-Z0-9_]+)\]\s*(.*?)(?:\s*@([\w.-]+))?$/);
    const errorCode = m?.[1] ?? "SKIPPED";
    const errorMessage = (m?.[2] || legacy).trim();
    const failedStep = m?.[3] || "unknown";
    const kind: "skipped" | "excluded" =
      status === "excluded" || errorCode.startsWith("NEIGHBOR_")
        ? "excluded"
        : "skipped";
    const prefix = kind === "excluded" ? "제외" : "미처리";
    return {
      errorCode,
      errorMessage,
      failedStep,
      failedStepLabel: failedStepLabel(failedStep),
      failedAt: null,
      detail: null,
      steps: [],
      retryable: false,
      kind,
      summary: `${prefix} · ${failedStepLabel(failedStep)} · ${errorMessage}`,
    };
  }

  // Parse "[CODE] message @step" written by worker
  const m = legacy.match(/^\[([A-Z0-9_]+)\]\s*(.*?)(?:\s*@([\w.-]+))?$/);
  if (m) {
    const errorCode = m[1]!;
    const errorMessage = (m[2] || errorCode).trim();
    const failedStep = m[3] || "unknown";
    return {
      errorCode,
      errorMessage,
      failedStep,
      failedStepLabel: failedStepLabel(failedStep),
      failedAt: null,
      detail: null,
      steps: [],
      retryable: true,
      kind: "failure",
      summary: `❌ 실패 · ${failedStepLabel(failedStep)} · ${errorMessage}`,
    };
  }

  return {
    errorCode: "UNKNOWN",
    errorMessage: legacy,
    failedStep: "unknown",
    failedStepLabel: failedStepLabel("unknown"),
    failedAt: null,
    detail: null,
    steps: [],
    retryable: true,
    kind: "failure",
    summary: `❌ 실패 · ${legacy}`,
  };
}

export function detailUrl(
  detail: Record<string, unknown> | null,
): string | null {
  if (!detail) return null;
  for (const key of ["url", "current_url", "page_url", "target_url"]) {
    const v = detail[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/** UI label for like soft-skip */
export function likeSkipUiLabel(code: string | null | undefined): string {
  if (
    code === "LIKE_BUTTON_NOT_AVAILABLE" ||
    code === "LIKE_BUTTON_NOT_FOUND"
  ) {
    return "공감 버튼이 없는 글입니다.";
  }
  return "미처리";
}
