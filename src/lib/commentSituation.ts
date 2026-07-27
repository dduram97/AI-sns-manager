/**
 * Comment situation labels for AI draft + Approval Inbox.
 */

export const COMMENT_SITUATIONS = [
  "맛집",
  "여행",
  "공감",
  "정보",
] as const;

export type CommentSituation = (typeof COMMENT_SITUATIONS)[number];

export function isCommentSituation(v: unknown): v is CommentSituation {
  return (
    typeof v === "string" &&
    (COMMENT_SITUATIONS as readonly string[]).includes(v)
  );
}

export function parseCommentSituation(
  v: unknown,
  fallback: CommentSituation = "공감",
): CommentSituation {
  return isCommentSituation(v) ? v : fallback;
}

export function commentSituationLabel(s: CommentSituation): string {
  switch (s) {
    case "맛집":
      return "맛집";
    case "여행":
      return "여행";
    case "공감":
      return "공감";
    case "정보":
      return "정보";
  }
}

/** Keyword heuristic when LLM unavailable. */
export function classifyCommentSituationHeuristic(
  title: string,
  content: string,
): CommentSituation {
  const text = `${title} ${content}`.toLowerCase();
  const hit = (words: string[]) => words.some((w) => text.includes(w));

  if (
    hit([
      "맛집",
      "카페",
      "음식",
      "식당",
      "베이커리",
      "빵",
      "고기",
      "메뉴",
      "라떼",
      "디저트",
      "맛있",
      "가성비",
      "갈비",
      "냉면",
    ])
  ) {
    return "맛집";
  }
  if (
    hit([
      "여행",
      "여행지",
      "풍경",
      "계곡",
      "호텔",
      "숙소",
      "관광",
      "바다",
      "산",
      "산책",
      "수승대",
      "당일치기",
    ])
  ) {
    return "여행";
  }
  if (
    hit([
      "레시피",
      "방법",
      "팁",
      "가이드",
      "정보",
      "다이어트",
      "시설",
      "골프",
      "라운딩",
      "후기 정리",
    ])
  ) {
    return "정보";
  }
  return "공감";
}
