import type { Page } from "playwright";
import type { NaverPostSnapshot } from "./posts";
import { summarizeContent } from "./posts";
import { sleep } from "./timing";

function absPostUrl(
  blogId: string,
  href: string,
): { logNo: string; postUrl: string } | null {
  try {
    const u = new URL(href, "https://m.blog.naver.com");
    const pathMatch = u.pathname.match(/\/([^/]+)\/(\d+)/);
    if (pathMatch) {
      return {
        logNo: pathMatch[2],
        postUrl: `https://m.blog.naver.com/${pathMatch[1]}/${pathMatch[2]}`,
      };
    }
    const blog = u.searchParams.get("blogId") ?? blogId;
    const logNo = u.searchParams.get("logNo");
    if (logNo) {
      return {
        logNo,
        postUrl: `https://m.blog.naver.com/${blog}/${logNo}`,
      };
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Scrape latest post links from a Naver blog home (mobile).
 */
export async function scrapeLatestPostLinks(
  page: Page,
  blogId: string,
  limit: number,
): Promise<Array<{ logNo: string; postUrl: string; titleHint: string }>> {
  const url = `https://m.blog.naver.com/${encodeURIComponent(blogId)}`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await sleep(1_200);

  const raw = await page.evaluate(
    ({ id, max }: { id: string; max: number }) => {
      const out: Array<{ href: string; title: string }> = [];
      const seen = new Set<string>();
      const anchors = Array.from(document.querySelectorAll("a[href]"));
      for (const a of anchors) {
        const href = (a as HTMLAnchorElement).href || "";
        if (!href.includes(id) && !href.includes("logNo=")) continue;
        if (!/\/\d+/.test(href) && !href.includes("logNo=")) continue;
        if (href.includes("BuddyAdd") || href.includes("Comment")) continue;
        const key = href.split("?")[0];
        if (seen.has(key)) continue;
        seen.add(key);
        const title = (a.textContent ?? "").replace(/\s+/g, " ").trim();
        out.push({ href, title });
        if (out.length >= max * 3) break;
      }
      return out;
    },
    { id: blogId, max: limit },
  );

  const posts: Array<{ logNo: string; postUrl: string; titleHint: string }> =
    [];
  const seenLog = new Set<string>();
  for (const item of raw) {
    const parsed = absPostUrl(blogId, item.href);
    if (!parsed) continue;
    if (seenLog.has(parsed.logNo)) continue;
    seenLog.add(parsed.logNo);
    posts.push({
      logNo: parsed.logNo,
      postUrl: parsed.postUrl,
      titleHint: item.title.slice(0, 120),
    });
    if (posts.length >= limit) break;
  }
  return posts;
}

/**
 * Open a post and extract title, body text, published time.
 */
export async function scrapePostDetail(
  page: Page,
  blogId: string,
  link: { logNo: string; postUrl: string; titleHint: string },
): Promise<NaverPostSnapshot> {
  await page.goto(link.postUrl, {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  });
  await sleep(1_000);

  const detail = await page.evaluate(() => {
    const titleEl =
      document.querySelector(
        "h2.se-title-text, .se_title, .tit_h3, h3.tit_h3, .blog2_title",
      ) ?? document.querySelector("h2, h3");
    const title = (titleEl?.textContent ?? "").replace(/\s+/g, " ").trim();

    const bodyEl =
      document.querySelector(
        ".se-main-container, .se_component_wrap, #postViewArea, .post_ct",
      ) ?? document.querySelector("article");
    const contentRaw = (bodyEl?.textContent ?? "").replace(/\s+/g, " ").trim();

    const timeEl =
      document.querySelector(
        "time, .se_publishDate, .date, .blog2_list_time",
      ) ?? document.querySelector("[class*='date']");
    const publishedRaw =
      timeEl?.getAttribute("datetime") ??
      (timeEl?.textContent ?? "").replace(/\s+/g, " ").trim() ??
      null;

    return { title, contentRaw, publishedRaw };
  });

  let publishedAt: string | null = null;
  if (detail.publishedRaw) {
    const parsed = Date.parse(detail.publishedRaw);
    if (!Number.isNaN(parsed)) {
      publishedAt = new Date(parsed).toISOString();
    }
  }

  const title = detail.title || link.titleHint || `post-${link.logNo}`;
  const contentRaw = detail.contentRaw || "";

  return {
    blogId,
    logNo: link.logNo,
    postUrl: link.postUrl,
    title,
    contentRaw,
    contentSummary: summarizeContent(contentRaw || title),
    publishedAt,
  };
}
