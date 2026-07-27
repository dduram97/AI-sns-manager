/**
 * Approval Inbox display helpers (UI-only).
 * Strips verify/fixture noise for operator-facing screens.
 */

import type { ApprovalInboxItem } from "@/types/approvalInbox";

const INTERNAL_TEXT_RE =
  /\[verify[:\]]|verify:|test_run|vfy_|duplicate check|bundle_both|approval_modes|seed fixture|URL 테스트|중복 테스트|중복 모달|생성만|실행 없음|manual_url|smoke:|prior executed/i;

export const OPERATOR_RECOMMEND_REASONS = [
  "내 댓글 스타일과 유사한 글",
  "최근 활동이 있는 블로그",
  "댓글 참여 가능성이 높은 글",
  "관심 분야와 일치",
] as const;

export function isInternalDisplayText(text: string | null | undefined): boolean {
  if (!text) return false;
  return INTERNAL_TEXT_RE.test(text.trim());
}

export function cleanOperatorLabel(text: string): string {
  return text
    .replace(/^\[verify:[^\]]+\]\s*/i, "")
    .replace(/\s*·\s*duplicate check.*$/i, "")
    .replace(/\s*\(prior executed\)\s*$/i, "")
    .replace(/^\[verify\]\s*/i, "")
    .trim();
}

export function operatorAuthorName(item: ApprovalInboxItem): string {
  const raw =
    item.mutualRequest?.blogName?.trim() ||
    item.person.display_name?.trim() ||
    "";
  if (!raw || isInternalDisplayText(raw)) {
    const blogId = item.job.target_ref?.blog_id;
    if (typeof blogId === "string" && blogId.trim()) return blogId.trim();
    return "이웃 블로거";
  }
  const cleaned = cleanOperatorLabel(raw);
  return cleaned || "이웃 블로거";
}

/** Operator-facing published date (neighbor_feed cards). */
export function operatorPublishedDate(
  item: ApprovalInboxItem,
): string | null {
  const raw = item.publishedAt?.trim();
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("ko-KR", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function isNeighborFeedInboxItem(item: ApprovalInboxItem): boolean {
  return item.source === "neighbor_feed";
}

export function operatorPostTitle(item: ApprovalInboxItem): string {
  const raw = item.postTitle?.trim() || "";
  if (!raw) {
    // mutual / no title
    if (item.mutualRequest) return "서로이웃 신청";
    return "블로그 글";
  }
  if (isInternalDisplayText(raw)) {
    const cleaned = cleanOperatorLabel(raw);
    if (cleaned && !isInternalDisplayText(cleaned)) return cleaned;
    return "블로그 글";
  }
  const cleaned = cleanOperatorLabel(raw);
  return cleaned || "블로그 글";
}

export function operatorDraftBody(draft: string | null | undefined): string {
  const raw = (draft ?? "").trim();
  if (!raw) return "";
  if (isInternalDisplayText(raw) || /^\[verify\]/i.test(raw)) {
    return "";
  }
  return raw;
}

export function operatorRecommendReasons(
  item: ApprovalInboxItem,
): string[] {
  const fromMutual = item.mutualRequest?.recommendReasons ?? [];
  const fromDecision = item.decisionExplain?.reasons ?? [];
  const fromShort = item.reasonShort ? [item.reasonShort] : [];
  const explanation = item.decisionExplain?.explanation
    ? [item.decisionExplain.explanation]
    : [];

  const candidates = [
    ...fromMutual,
    ...fromDecision,
    ...explanation,
    ...fromShort,
  ]
    .map((r) => cleanOperatorLabel(r))
    .filter((r) => r.length > 0 && !isInternalDisplayText(r));

  const unique = [...new Set(candidates)];
  if (unique.length > 0) return unique.slice(0, 4);
  return [...OPERATOR_RECOMMEND_REASONS];
}

export function extractTestRunId(item: ApprovalInboxItem): string | null {
  const ctx = item.approval.presented_context ?? {};
  if (typeof ctx.test_run_id === "string" && ctx.test_run_id) {
    return ctx.test_run_id;
  }
  const ref = item.job.target_ref ?? {};
  if (typeof ref.test_run_id === "string" && ref.test_run_id) {
    return ref.test_run_id;
  }
  return null;
}
