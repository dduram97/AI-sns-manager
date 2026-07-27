/**
 * Normalize Naver blog post identity for duplicate detection.
 * Matches m.blog / blog / CommentList URL variants to the same key.
 */

export function parseNaverPostKeyFromUrl(
  url: string | null | undefined,
): string | null {
  if (!url || typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed) return null;

  // CommentList.naver?blogId=...&logNo=...
  const commentList = trimmed.match(
    /[?&]blogId=([^&]+).*?[?&]logNo=(\d+)/i,
  );
  if (commentList) {
    return `${decodeURIComponent(commentList[1]!).toLowerCase()}:${commentList[2]}`;
  }
  const commentListAlt = trimmed.match(
    /[?&]logNo=(\d+).*?[?&]blogId=([^&]+)/i,
  );
  if (commentListAlt) {
    return `${decodeURIComponent(commentListAlt[2]!).toLowerCase()}:${commentListAlt[1]}`;
  }

  const path = trimmed.match(/blog\.naver\.com\/([^/?#]+)\/(\d+)/i);
  if (path) {
    return `${path[1]!.toLowerCase()}:${path[2]}`;
  }
  return null;
}

export function postKeyFromTargetRef(
  targetRef: Record<string, unknown> | null | undefined,
): string | null {
  if (!targetRef) return null;
  const blogId =
    typeof targetRef.blog_id === "string" ? targetRef.blog_id.trim() : "";
  const logNoRaw =
    (typeof targetRef.log_no === "string" && targetRef.log_no) ||
    (typeof targetRef.post_id === "string" && targetRef.post_id) ||
    "";
  const logNo = String(logNoRaw).trim();
  if (blogId && /^\d+$/.test(logNo)) {
    return `${blogId.toLowerCase()}:${logNo}`;
  }
  const postUrl =
    typeof targetRef.post_url === "string" ? targetRef.post_url : null;
  return parseNaverPostKeyFromUrl(postUrl);
}
