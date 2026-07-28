/**
 * Naver Open API — Blog Search (non-login).
 * https://developers.naver.com/docs/serviceapi/search/blog/blog.md
 *
 * Auth: NAVER_CLIENT_ID / NAVER_CLIENT_SECRET
 */

import type { DiscoverCandidate } from "./NaverDiscoverAdapter";
import { keywordRelevanceScore } from "../../domain/policy/discoverPolicy";

export type NaverBlogSearchItem = {
  title: string;
  link: string;
  description: string;
  bloggername: string;
  bloggerlink: string;
  postdate: string;
};

type NaverBlogSearchResponse = {
  lastBuildDate?: string;
  total?: number;
  start?: number;
  display?: number;
  items?: NaverBlogSearchItem[];
  errorMessage?: string;
  errorCode?: string;
};

export function hasNaverSearchApiCredentials(): boolean {
  return Boolean(
    process.env.NAVER_CLIENT_ID?.trim() &&
      process.env.NAVER_CLIENT_SECRET?.trim(),
  );
}

function stripHtml(s: string): string {
  return s
    .replace(/<\/?b>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** postdate from API: YYYYMMDD */
export function parseNaverApiPostdate(postdate: string): {
  recentlyActive: boolean;
  lastPostAt: string | null;
  dateText: string;
} {
  const raw = postdate.trim();
  if (!/^\d{8}$/.test(raw)) {
    return { recentlyActive: false, lastPostAt: null, dateText: raw };
  }
  const y = Number(raw.slice(0, 4));
  const m = Number(raw.slice(4, 6));
  const d = Number(raw.slice(6, 8));
  const dt = new Date(y, m - 1, d);
  if (Number.isNaN(dt.getTime())) {
    return { recentlyActive: false, lastPostAt: null, dateText: raw };
  }
  const ageDays = (Date.now() - dt.getTime()) / 86_400_000;
  return {
    recentlyActive: ageDays >= 0 && ageDays <= 365,
    lastPostAt: dt.toISOString(),
    dateText: `${y}.${String(m).padStart(2, "0")}.${String(d).padStart(2, "0")}`,
  };
}

export function parseBlogIdFromNaverUrl(href: string): string | null {
  const raw = (href ?? "").trim();
  if (!raw) return null;

  // Naver Search API often returns bloggerlink without scheme:
  //   "blog.naver.com/decay8365"
  // URL(..., base) would treat that as a path → blogId="blog.naver.com" for ALL.
  let normalized = raw;
  if (!/^https?:\/\//i.test(normalized)) {
    normalized = normalized.replace(/^\/+/, "");
    normalized = `https://${normalized}`;
  }

  try {
    const u = new URL(normalized);
    const host = u.hostname.toLowerCase();

    // blog.naver.com/{blogId} or m.blog.naver.com/{blogId}
    if (host === "blog.naver.com" || host === "m.blog.naver.com") {
      const parts = u.pathname.split("/").filter(Boolean);
      const skip = new Set([
        "PostView.naver",
        "PostList.naver",
        "PostThumbnailList.naver",
        "section",
        "SympathyHistory.naver",
      ]);
      if (parts[0] && !skip.has(parts[0])) {
        const id = decodeURIComponent(parts[0]).trim();
        // Reject host-like false positives from bad relative URL resolution
        if (id && !/^blog\.naver\.com$/i.test(id) && !id.includes("/")) {
          return id;
        }
      }
    }

    const blogIdParam =
      u.searchParams.get("blogId") || u.searchParams.get("blogid");
    if (blogIdParam) {
      const id = decodeURIComponent(blogIdParam).trim();
      if (id) return id;
    }

    // Redirect/open-api short links sometimes embed blogId in query
    const redirect = u.searchParams.get("url") || u.searchParams.get("u");
    if (redirect) {
      const nested = parseBlogIdFromNaverUrl(redirect);
      if (nested) return nested;
    }
  } catch {
    // ignore
  }

  // Fallback: blog.naver.com/{id} plain string
  const m = raw.match(
    /(?:m\.)?blog\.naver\.com\/([A-Za-z0-9._-]+)(?:\/|$|\?)/i,
  );
  if (m?.[1] && m[1].toLowerCase() !== "postview.naver") {
    return m[1];
  }
  return null;
}

/** Prefer post link (has scheme) over bloggerlink (often scheme-less). */
export function extractBlogIdFromSearchItem(item: {
  link?: string;
  bloggerlink?: string;
}): string | null {
  return (
    parseBlogIdFromNaverUrl(item.link ?? "") ||
    parseBlogIdFromNaverUrl(item.bloggerlink ?? "")
  );
}

export async function searchNaverBlogsApi(input: {
  query: string;
  display?: number;
  start?: number;
  sort?: "sim" | "date";
}): Promise<NaverBlogSearchItem[]> {
  const clientId = process.env.NAVER_CLIENT_ID?.trim();
  const clientSecret = process.env.NAVER_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error(
      "NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 이 설정되지 않았습니다.",
    );
  }

  const display = Math.max(1, Math.min(100, input.display ?? 30));
  const start = Math.max(1, Math.min(1000, input.start ?? 1));
  const sort = input.sort ?? "date";
  const params = new URLSearchParams({
    query: input.query,
    display: String(display),
    start: String(start),
    sort,
  });

  const res = await fetch(
    `https://openapi.naver.com/v1/search/blog.json?${params.toString()}`,
    {
      method: "GET",
      headers: {
        "X-Naver-Client-Id": clientId,
        "X-Naver-Client-Secret": clientSecret,
      },
      cache: "no-store",
    },
  );

  const body = (await res.json()) as NaverBlogSearchResponse;
  if (!res.ok) {
    throw new Error(
      body.errorMessage ||
        body.errorCode ||
        `Naver blog search HTTP ${res.status}`,
    );
  }
  if (body.errorMessage) {
    throw new Error(body.errorMessage);
  }

  return Array.isArray(body.items) ? body.items : [];
}

/**
 * Map API items → DiscoverCandidate (same shape as CDP scrape).
 */
export function mapNaverBlogItemsToCandidates(
  items: NaverBlogSearchItem[],
  keyword: string,
  allKeywords: string[],
): DiscoverCandidate[] {
  const out: DiscoverCandidate[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const blogId = extractBlogIdFromSearchItem(item);
    if (!blogId || seen.has(blogId.toLowerCase())) continue;
    seen.add(blogId.toLowerCase());

    const title = stripHtml(item.title);
    const description = stripHtml(item.description);
    const blogName = stripHtml(item.bloggername) || blogId;
    const haystack = `${title} ${description} ${blogName}`;
    const activity = parseNaverApiPostdate(item.postdate);
    const matchedKeywords = allKeywords.filter((k) =>
      haystack.toLowerCase().includes(k.toLowerCase()),
    );
    const relevance = keywordRelevanceScore(haystack, allKeywords);

    let categoryHint: string | null = null;
    for (const cat of allKeywords) {
      if (haystack.toLowerCase().includes(cat.toLowerCase())) {
        categoryHint = cat;
        break;
      }
    }

    out.push({
      blogName,
      blogId,
      url: `https://m.blog.naver.com/${blogId}`,
      recentlyActive: activity.recentlyActive,
      lastPostAt: activity.lastPostAt,
      dateText: activity.dateText,
      keywordRelevance: Math.max(
        relevance,
        matchedKeywords.length > 0 ? 40 : 25,
      ),
      matchedKeywords:
        matchedKeywords.length > 0 ? matchedKeywords : [keyword],
      categoryHint,
      snippet: description.slice(0, 240) || title.slice(0, 240),
      postTitle: title.slice(0, 120) || null,
    });
  }

  return out;
}

/**
 * Search all keywords via Naver Blog Search API (fast path).
 * Paginates per keyword when maxPerKeyword > 100 (API display cap).
 */
export async function searchCandidatesViaNaverApi(input: {
  keywords: string[];
  maxPerKeyword?: number;
  maxTotal?: number;
  /** Naver API sort — default date (neighbor collect). Use sim for relevance ranking. */
  sort?: "sim" | "date";
}): Promise<{
  candidates: DiscoverCandidate[];
  errors: string[];
  /** Raw API item rows before blog_id dedupe */
  rawItemCount: number;
  duplicatesRemoved: number;
}> {
  const errors: string[] = [];
  const all: DiscoverCandidate[] = [];
  const seen = new Set<string>();
  const maxPerKeyword = input.maxPerKeyword ?? 30;
  const maxTotal = input.maxTotal ?? 120;
  const sort = input.sort ?? "date";
  let rawItemCount = 0;
  let duplicatesRemoved = 0;

  for (const keyword of input.keywords) {
    if (all.length >= maxTotal) break;
    let collectedForKeyword = 0;
    let start = 1;
    try {
      while (
        collectedForKeyword < maxPerKeyword &&
        all.length < maxTotal &&
        start <= 1000
      ) {
        const pageSize = Math.min(100, maxPerKeyword - collectedForKeyword);
        const items = await searchNaverBlogsApi({
          query: keyword,
          display: pageSize,
          start,
          sort,
        });
        if (items.length === 0) break;
        rawItemCount += items.length;

        const mapped = mapNaverBlogItemsToCandidates(
          items,
          keyword,
          input.keywords,
        );
        // mapped already dedupes within page; count unmapped/dupes vs raw
        let addedThisPage = 0;
        for (const c of mapped) {
          const key = c.blogId.toLowerCase();
          if (seen.has(key)) {
            duplicatesRemoved += 1;
            continue;
          }
          seen.add(key);
          all.push(c);
          collectedForKeyword += 1;
          addedThisPage += 1;
          if (all.length >= maxTotal || collectedForKeyword >= maxPerKeyword) {
            break;
          }
        }
        // Items that failed blog_id parse also reduce unique yield
        const unresolved = Math.max(0, items.length - mapped.length);
        duplicatesRemoved += unresolved;

        start += items.length;
        // Only stop paging when API returned a short page (no more results)
        if (items.length < pageSize) break;
        // If this page added nothing but API still returned a full page,
        // continue — may be parse failures or cross-page dups.
      }
    } catch (err) {
      errors.push(
        `${keyword}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  all.sort((a, b) => b.keywordRelevance - a.keywordRelevance);
  return {
    candidates: all,
    errors,
    rawItemCount,
    duplicatesRemoved: Math.max(0, rawItemCount - all.length),
  };
}
