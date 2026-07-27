import type { ChannelActionInput } from "../types";

export function strRef(
  targetRef: Record<string, unknown>,
  ...keys: string[]
): string | null {
  for (const key of keys) {
    const v = targetRef[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/** Resolve Naver blogId / logNo / URLs from ActionJob.target_ref */
export function resolveNaverTarget(input: ChannelActionInput): {
  blogId: string | null;
  logNo: string | null;
  postUrl: string | null;
  blogUrl: string | null;
} {
  const ref = input.targetRef;
  let blogId = strRef(ref, "blog_id", "blogId", "blogID");
  let logNo = strRef(ref, "log_no", "logNo", "post_id", "postId");
  let postUrl = strRef(ref, "post_url", "url", "permalink");
  let blogUrl = strRef(ref, "blog_url", "profile_url");

  if (postUrl) {
    const m =
      postUrl.match(/blog\.naver\.com\/([^/?#]+)\/(\d+)/) ||
      postUrl.match(/[?&]blogId=([^&]+).*?[?&]logNo=(\d+)/) ||
      postUrl.match(/[?&]blogId=([^&]+)/);
    if (m) {
      blogId = blogId ?? decodeURIComponent(m[1]);
      if (m[2]) logNo = logNo ?? m[2];
    }
  }

  if (blogUrl && !blogId) {
    const m = blogUrl.match(/blog\.naver\.com\/([^/?#]+)/);
    if (m) blogId = decodeURIComponent(m[1]);
  }

  if (!blogUrl && blogId) {
    blogUrl = `https://m.blog.naver.com/${blogId}`;
  }
  if (!postUrl && blogId && logNo) {
    postUrl = `https://m.blog.naver.com/${blogId}/${logNo}`;
  }

  if (postUrl) postUrl = toMBlogUrl(postUrl);
  if (blogUrl) blogUrl = toMBlogUrl(blogUrl);

  return { blogId, logNo, postUrl, blogUrl };
}

/** Prefer m.blog mobile URLs for Playwright actions. */
export function toMBlogUrl(url: string): string {
  const trimmed = url.trim();
  try {
    const u = new URL(trimmed);
    if (
      u.hostname === "blog.naver.com" ||
      u.hostname === "m.blog.naver.com" ||
      u.hostname.endsWith(".blog.naver.com")
    ) {
      u.protocol = "https:";
      u.hostname = "m.blog.naver.com";
      return u.toString();
    }
  } catch {
    // fall through
  }
  return trimmed
    .replace(/^https?:\/\/blog\.naver\.com\//i, "https://m.blog.naver.com/")
    .replace(/^https?:\/\/m\.blog\.naver\.com\//i, "https://m.blog.naver.com/");
}
