/**
 * Phase 2-2: execute action_jobs.action_type = visit via CDP.
 * Navigate to Naver blog URL, dwell briefly, report success/failure.
 */

import type { BrowserContext, Page } from "playwright";

export type VisitTargetRef = Record<string, unknown> | null | undefined;

export type VisitExecuteInput = {
  jobId: string;
  targetRef: VisitTargetRef;
};

export type VisitExecuteResult =
  | { ok: true; jobId: string; url: string; title: string; dwellMs: number }
  | { ok: false; jobId: string; error: string };

function strRef(
  ref: Record<string, unknown>,
  ...keys: string[]
): string | null {
  for (const key of keys) {
    const v = ref[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function toMBlogUrl(url: string): string {
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
    .replace(
      /^https?:\/\/m\.blog\.naver\.com\//i,
      "https://m.blog.naver.com/",
    );
}

/** Resolve visit URL from target_ref (mirrors app resolveNaverTarget for visit). */
export function resolveVisitUrl(targetRef: VisitTargetRef): string | null {
  const ref = targetRef ?? {};
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
      blogId = blogId ?? decodeURIComponent(m[1]!);
      if (m[2]) logNo = logNo ?? m[2];
    }
  }

  if (blogUrl && !blogId) {
    const m = blogUrl.match(/blog\.naver\.com\/([^/?#]+)/);
    if (m) blogId = decodeURIComponent(m[1]!);
  }

  if (!blogUrl && blogId) {
    blogUrl = `https://m.blog.naver.com/${blogId}`;
  }
  if (!postUrl && blogId && logNo) {
    postUrl = `https://m.blog.naver.com/${blogId}/${logNo}`;
  }

  const raw = postUrl ?? blogUrl;
  if (!raw) return null;
  return toMBlogUrl(raw);
}

function dwellMs(): number {
  const min = Number(process.env.WORKER_VISIT_DWELL_MIN_MS ?? 5_000) || 5_000;
  const max = Number(process.env.WORKER_VISIT_DWELL_MAX_MS ?? 10_000) || 10_000;
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Open target URL on a new CDP page, wait for load, dwell, close page.
 */
export async function executeVisit(
  context: BrowserContext,
  input: VisitExecuteInput,
): Promise<VisitExecuteResult> {
  const { jobId, targetRef } = input;
  const url = resolveVisitUrl(targetRef);
  if (!url) {
    console.error(`[worker] visit aborted job=${jobId} reason=missing_url`);
    return {
      ok: false,
      jobId,
      error:
        "visit: target_ref needs post_url/url/blog_url or blog_id (optional log_no)",
    };
  }

  console.info(`[worker] visit start job=${jobId} url=${url}`);
  let page: Page | null = null;
  try {
    page = await context.newPage();
    const navTimeout =
      Number(process.env.BROWSER_NAV_TIMEOUT_MS ?? 45_000) || 45_000;
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: navTimeout,
    });
    const title = await page.title();
    const finalUrl = page.url();
    console.info(
      `[worker] page loaded job=${jobId} url=${finalUrl} title=${title}`,
    );

    const waitMs = dwellMs();
    console.info(`[worker] visit dwell job=${jobId} ms=${waitMs}`);
    await sleep(waitMs);

    console.info(`[worker] visit completed job=${jobId}`);
    return { ok: true, jobId, url: finalUrl, title, dwellMs: waitMs };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[worker] visit failed job=${jobId} error=${message}`);
    return { ok: false, jobId, error: message.slice(0, 2000) };
  } finally {
    if (page) {
      await page.close().catch(() => undefined);
    }
  }
}
