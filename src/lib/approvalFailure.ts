/**
 * Classify Approval / ActionJob failure for Inbox UI.
 * Display-only — does not change execution policy.
 */

export type ApprovalFailureStage =
  | "comment"
  | "like"
  | "adapter"
  | "network"
  | "login"
  | "navigation"
  | "unknown";

export type FriendlyFailureMessage = {
  stage: ApprovalFailureStage;
  /** Short cause line for the card */
  cause: string;
  /** Longer operator-facing detail */
  detail: string;
  /** Modal headline */
  headline: string;
};

export function classifyApprovalFailureStage(
  errorMessage: string | null | undefined,
  actionType?: string | null,
): ApprovalFailureStage {
  return toFriendlyFailure(errorMessage, actionType).stage;
}

export function toFriendlyFailure(
  errorMessage: string | null | undefined,
  actionType?: string | null,
): FriendlyFailureMessage {
  const raw = (errorMessage ?? "").trim();
  const msg = raw.toLowerCase();

  if (
    /LIKE_BUTTON_NOT_AVAILABLE|LIKE_BUTTON_NOT_FOUND/i.test(raw) ||
    /공감 버튼이 없는 글/.test(raw)
  ) {
    return {
      stage: "like",
      cause: "공감 버튼이 없는 글입니다.",
      detail: "이 글은 공감 처리 대상이 아닙니다.",
      headline: "공감 불가",
    };
  }

  if (/서로이웃이 불가한 블로그|NEIGHBOR_MUTUAL_NOT_AVAILABLE/i.test(raw)) {
    return {
      stage: "adapter",
      cause: "서로이웃이 불가한 블로그입니다.",
      detail: "이 블로그는 자동 제외 목록에 추가됩니다.",
      headline: "서로이웃 불가",
    };
  }

  if (/이미 이웃인 블로그|ALREADY_NEIGHBOR/i.test(raw)) {
    return {
      stage: "adapter",
      cause: "이미 이웃인 블로그입니다.",
      detail: "중복 신청하지 않고 건너뜁니다.",
      headline: "이미 이웃",
    };
  }

  if (
    /relogin|login required|logged_out|needs_relogin|captcha|세션|로그인/i.test(
      msg,
    )
  ) {
    return {
      stage: "login",
      cause: "네이버 로그인이 필요합니다.",
      detail: "잠시 후 다시 시도해주세요.",
      headline: "로그인 필요",
    };
  }

  if (
    /cdp|connectovercdp|econnrefused|net::|network|websocket|browser.*closed|socket hang up/i.test(
      msg,
    )
  ) {
    return {
      stage: "network",
      cause: "네트워크 문제로 처리하지 못했습니다.",
      detail: "잠시 후 다시 시도해주세요.",
      headline: "네트워크 오류",
    };
  }

  if (
    /navigation|goto|page\.goto|err_name_not_resolved|net::err_|불러오지|page closed/i.test(
      msg,
    )
  ) {
    return {
      stage: "navigation",
      cause: "네이버 페이지를 불러오지 못했습니다.",
      detail: "잠시 후 다시 시도해주세요.",
      headline: "페이지 접근 실패",
    };
  }

  if (
    /write_textarea|u_cbox|navercomment|댓글 입력|comment input|focusandfill|draft_body is empty/i.test(
      msg,
    ) ||
    (actionType === "comment" &&
      /locator\.(waitfor|click|fill)|timeout \d+ms exceeded/i.test(msg))
  ) {
    return {
      stage: "comment",
      cause: "네이버 댓글 입력창을 찾지 못했습니다.",
      detail: "잠시 후 다시 시도해주세요.",
      headline: "댓글 등록 실패",
    };
  }

  if (
    /sympathy|likeit|공감|u_likeit|reactiontype=like|zeroface/i.test(msg) ||
    (actionType === "like" &&
      /locator\.(waitfor|click)|timeout \d+ms exceeded/i.test(msg))
  ) {
    return {
      stage: "like",
      cause: "네이버 공감 버튼을 처리하지 못했습니다.",
      detail: "잠시 후 다시 시도해주세요.",
      headline: "공감 처리 실패",
    };
  }

  if (/submit|등록|upload|btn_upload/i.test(msg) && actionType === "comment") {
    return {
      stage: "comment",
      cause: "네이버 댓글 등록 버튼을 처리하지 못했습니다.",
      detail: "잠시 후 다시 시도해주세요.",
      headline: "댓글 등록 실패",
    };
  }

  if (
    /서로이웃|이웃추가|buddyadd|buddy_add|mutual|neighbor/i.test(msg) ||
    (actionType === "neighbor_request" &&
      /locator\.(waitfor|click)|timeout \d+ms exceeded|button not found/i.test(
        msg,
      ))
  ) {
    if (/이미\s*서로이웃|already\s*(a\s*)?neighbor|buddy.?already|서로이웃입니다/i.test(raw)) {
      return {
        stage: "adapter",
        cause: "이미 서로이웃 상태입니다.",
        detail: "이 블로그는 건너뛰고 다른 후보를 신청하세요.",
        headline: "이미 서로이웃",
      };
    }
    if (
      /오늘.*신청|신청 가능|daily.*limit|quota|가능 수량|횟수.*초과|모두 사용/i.test(
        raw,
      )
    ) {
      return {
        stage: "adapter",
        cause: "오늘 신청 가능 횟수를 초과했습니다.",
        detail: "내일 다시 시도하거나 설정에서 하루 한도를 확인하세요.",
        headline: "하루 신청 한도",
      };
    }
    if (
      /신청할 수 없|cannot\s*add|차단|받지\s*않|거절|비공개|권한/i.test(raw)
    ) {
      return {
        stage: "adapter",
        cause: "상대 블로그에서 신청할 수 없습니다.",
        detail: "상대가 서로이웃을 받지 않거나 신청이 제한된 상태일 수 있습니다.",
        headline: "신청 불가",
      };
    }
    if (/연결|cdp|browser|session|websocket/i.test(msg)) {
      return {
        stage: "network",
        cause: "네이버 연결 오류가 발생했습니다.",
        detail: "잠시 후 다시 시도해주세요.",
        headline: "연결 오류",
      };
    }
    return {
      stage: "adapter",
      cause: "서로이웃 추가 버튼을 처리하지 못했습니다.",
      detail: "잠시 후 다시 시도해주세요.",
      headline: "서로이웃 추가 실패",
    };
  }

  if (/locator|selector|playwright|timeout \d+ms|adapter/i.test(msg)) {
    return {
      stage: "adapter",
      cause: "화면 요소를 찾지 못해 처리하지 못했습니다.",
      detail: "잠시 후 다시 시도해주세요.",
      headline: "실행 실패",
    };
  }

  if (actionType === "like") {
    return {
      stage: "like",
      cause: "네이버 공감 처리에 실패했습니다.",
      detail: "잠시 후 다시 시도해주세요.",
      headline: "공감 처리 실패",
    };
  }
  if (actionType === "comment") {
    return {
      stage: "comment",
      cause: "네이버 댓글 등록에 실패했습니다.",
      detail: "잠시 후 다시 시도해주세요.",
      headline: "댓글 등록 실패",
    };
  }
  if (actionType === "neighbor_request") {
    if (/이미\s*서로이웃|already\s*(a\s*)?neighbor/i.test(raw)) {
      return {
        stage: "adapter",
        cause: "이미 서로이웃 상태입니다.",
        detail: "이 블로그는 건너뛰고 다른 후보를 신청하세요.",
        headline: "이미 서로이웃",
      };
    }
    if (/오늘.*신청|신청 가능|가능 수량|횟수.*초과|모두 사용/i.test(raw)) {
      return {
        stage: "adapter",
        cause: "오늘 신청 가능 횟수를 초과했습니다.",
        detail: "내일 다시 시도하거나 설정에서 하루 한도를 확인하세요.",
        headline: "하루 신청 한도",
      };
    }
    if (/신청할 수 없|차단|받지\s*않|거절|비공개/i.test(raw)) {
      return {
        stage: "adapter",
        cause: "상대 블로그에서 신청할 수 없습니다.",
        detail: "상대가 서로이웃을 받지 않거나 신청이 제한된 상태일 수 있습니다.",
        headline: "신청 불가",
      };
    }
    if (/연결|cdp|network|browser|session/i.test(msg)) {
      return {
        stage: "network",
        cause: "네이버 연결 오류가 발생했습니다.",
        detail: "잠시 후 다시 시도해주세요.",
        headline: "연결 오류",
      };
    }
    return {
      stage: "adapter",
      cause: "서로이웃 추가에 실패했습니다.",
      detail: "잠시 후 다시 시도해주세요.",
      headline: "서로이웃 추가 실패",
    };
  }

  return {
    stage: "unknown",
    cause: "처리 중 알 수 없는 오류가 발생했습니다.",
    detail: "잠시 후 다시 시도해주세요.",
    headline: "처리 실패",
  };
}

export function approvalFailureStageLabel(
  stage: ApprovalFailureStage,
): string {
  switch (stage) {
    case "comment":
      return "댓글";
    case "like":
      return "공감";
    case "adapter":
      return "어댑터";
    case "network":
      return "네트워크";
    case "login":
      return "로그인";
    case "navigation":
      return "페이지";
    default:
      return "알 수 없음";
  }
}

export function formatApprovalFailureTime(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${day} ${hh}:${mm}`;
}
