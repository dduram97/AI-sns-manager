/**
 * Client-safe neighbor-feed comment AI error classification.
 * Raw OpenAI details stay in server logs only.
 */

export type NeighborCommentAiErrorType =
  | "auth"
  | "rate_limit"
  | "timeout"
  | "server"
  | "parse"
  | "network"
  | "missing_key"
  | "unknown";

export type NeighborCommentAiPreviewSuccess = {
  success: true;
  body: string;
  situation: string;
  source: string;
  generatedAt: string;
};

export type NeighborCommentAiPreviewFailure = {
  success: false;
  errorType: NeighborCommentAiErrorType;
  message: string;
};

export type NeighborCommentAiPreviewResult =
  | NeighborCommentAiPreviewSuccess
  | NeighborCommentAiPreviewFailure;

export function neighborCommentAiUserMessage(
  errorType: NeighborCommentAiErrorType,
): string {
  switch (errorType) {
    case "auth":
      return "AI 인증 오류";
    case "rate_limit":
      return "잠시 후 다시 시도해주세요.";
    case "timeout":
      return "AI 응답 시간이 초과되었습니다.";
    case "server":
      return "AI 서버 오류";
    case "parse":
      return "AI 응답 형식 오류";
    case "missing_key":
      return "AI API 키가 설정되지 않았습니다.";
    case "network":
      return "AI 네트워크 오류";
    default:
      return "AI 댓글 생성에 실패했습니다.";
  }
}

export function isRetryableNeighborCommentAiError(
  errorType: NeighborCommentAiErrorType,
): boolean {
  return (
    errorType === "timeout" ||
    errorType === "rate_limit" ||
    errorType === "network" ||
    errorType === "server"
  );
}

/** Classify from Error / OpenAI APIError / free-form message. */
export function classifyNeighborCommentAiError(err: unknown): {
  errorType: NeighborCommentAiErrorType;
  message: string;
  raw: string;
} {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : String(err ?? "unknown");
  const lower = raw.toLowerCase();

  const status =
    err &&
    typeof err === "object" &&
    "status" in err &&
    typeof (err as { status: unknown }).status === "number"
      ? (err as { status: number }).status
      : err &&
          typeof err === "object" &&
          "statusCode" in err &&
          typeof (err as { statusCode: unknown }).statusCode === "number"
        ? (err as { statusCode: number }).statusCode
        : null;

  let errorType: NeighborCommentAiErrorType = "unknown";

  if (
    status === 401 ||
    status === 403 ||
    /auth|unauthorized|invalid.?api.?key|incorrect.?api.?key|401|403/.test(
      lower,
    )
  ) {
    errorType = "auth";
  } else if (
    status === 429 ||
    /rate.?limit|too many requests|429|quota/.test(lower)
  ) {
    errorType = "rate_limit";
  } else if (
    status === 408 ||
    /timeout|timed?\s*out|aborted|abort|deadline/.test(lower)
  ) {
    errorType = "timeout";
  } else if (
    status != null &&
    status >= 500 &&
    status < 600
  ) {
    errorType = "server";
  } else if (
    /empty_or_unparseable|json|parse|normalized_body_empty|응답 형식/.test(
      lower,
    )
  ) {
    errorType = "parse";
  } else if (
    /openai_api_key missing|api.?key.*missing|missing_key/.test(lower)
  ) {
    errorType = "missing_key";
  } else if (
    /network|econnreset|econnrefused|fetch failed|socket|enotfound|etimedout/.test(
      lower,
    )
  ) {
    errorType = "network";
  } else if (/500|internal server|server error/.test(lower)) {
    errorType = "server";
  }

  return {
    errorType,
    message: neighborCommentAiUserMessage(errorType),
    raw,
  };
}

export class NeighborCommentAiError extends Error {
  readonly errorType: NeighborCommentAiErrorType;
  readonly raw: string;

  constructor(
    errorType: NeighborCommentAiErrorType,
    raw: string,
    message = neighborCommentAiUserMessage(errorType),
  ) {
    super(message);
    this.name = "NeighborCommentAiError";
    this.errorType = errorType;
    this.raw = raw;
  }
}
