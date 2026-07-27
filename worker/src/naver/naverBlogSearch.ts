/**
 * Naver Blog Search Open API (worker copy — no app path imports).
 * https://developers.naver.com/docs/serviceapi/search/blog/blog.md
 */

export type NaverBlogSearchItem = {
  title: string;
  link: string;
  description: string;
  bloggername: string;
  bloggerlink: string;
  postdate: string;
};

export type DiscoveredBlogHit = {
  blogId: string;
  blogUrl: string;
  postUrl: string | null;
  lastActiveAt: string | null;
  blogName: string;
  snippet: string;
  postTitle: string | null;
  keyword: string;
};

type NaverBlogSearchResponse = {
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
export function parseNaverApiPostdate(postdate: string): string | null {
  const raw = postdate.trim();
  if (!/^\d{8}$/.test(raw)) return null;
  const y = Number(raw.slice(0, 4));
  const m = Number(raw.slice(4, 6));
  const d = Number(raw.slice(6, 8));
  const dt = new Date(y, m - 1, d);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString();
}

export function parseBlogIdFromNaverUrl(href: string): string | null {
  const raw = (href ?? "").trim();
  if (!raw) return null;

  let normalized = raw;
  if (!/^https?:\/\//i.test(normalized)) {
    normalized = normalized.replace(/^\/+/, "");
    normalized = `https://${normalized}`;
  }

  try {
    const u = new URL(normalized);
    const host = u.hostname.toLowerCase();

    if (host === "blog.naver.com" || host === "m.blog.naver.com") {
      const parts = u.pathname.split("/").filter(Boolean);
      const skip = new Set([
        "PostView.naver",
        "PostList.naver",
        "PostThumbnailList.naver",
        "section",
        "SympathyHistory.naver",
        "BuddyAdd.naver",
      ]);
      if (parts[0] && !skip.has(parts[0])) {
        const id = decodeURIComponent(parts[0]).trim();
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
  } catch {
    // ignore
  }

  const m = raw.match(
    /(?:m\.)?blog\.naver\.com\/([A-Za-z0-9._-]+)(?:\/|$|\?)/i,
  );
  if (m?.[1] && m[1].toLowerCase() !== "postview.naver") {
    return m[1];
  }
  return null;
}

export function extractBlogIdFromSearchItem(item: {
  link?: string;
  bloggerlink?: string;
}): string | null {
  return (
    parseBlogIdFromNaverUrl(item.link ?? "") ||
    parseBlogIdFromNaverUrl(item.bloggerlink ?? "")
  );
}

function toMBlogUrl(url: string): string {
  const trimmed = url.trim();
  try {
    const u = new URL(
      /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`,
    );
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
  return trimmed;
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

export function mapSearchItemsToHits(
  items: NaverBlogSearchItem[],
  keyword: string,
): DiscoveredBlogHit[] {
  const out: DiscoveredBlogHit[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const blogId = extractBlogIdFromSearchItem(item);
    if (!blogId || seen.has(blogId.toLowerCase())) continue;
    seen.add(blogId.toLowerCase());

    const title = stripHtml(item.title);
    const description = stripHtml(item.description);
    const blogName = stripHtml(item.bloggername) || blogId;
    const postUrlRaw = (item.link ?? "").trim();
    const postUrl = postUrlRaw
      ? toMBlogUrl(
          /^https?:\/\//i.test(postUrlRaw)
            ? postUrlRaw
            : `https://${postUrlRaw.replace(/^\/+/, "")}`,
        )
      : null;

    out.push({
      blogId,
      blogUrl: `https://m.blog.naver.com/${blogId}`,
      postUrl,
      lastActiveAt: parseNaverApiPostdate(item.postdate),
      blogName,
      snippet: description.slice(0, 240) || title.slice(0, 240),
      postTitle: title.slice(0, 120) || null,
      keyword,
    });
  }

  return out;
}

/**
 * Phase 3-1 defaults: 1 keyword, max unique blogs (Phase 3-2 pool up to 100).
 */
export async function searchBlogCandidates(input: {
  keyword: string;
  maxTotal?: number;
}): Promise<{
  hits: DiscoveredBlogHit[];
  rawItemCount: number;
  duplicatesRemoved: number;
}> {
  const keyword = input.keyword.trim();
  if (!keyword) {
    throw new Error("keyword is required");
  }
  const maxTotal = Math.max(1, Math.min(100, input.maxTotal ?? 10));

  const all: DiscoveredBlogHit[] = [];
  const seen = new Set<string>();
  let rawItemCount = 0;
  let start = 1;

  while (all.length < maxTotal && start <= 1000) {
    const pageSize = Math.min(100, Math.max(maxTotal - all.length, 10));
    const items = await searchNaverBlogsApi({
      query: keyword,
      display: pageSize,
      start,
      sort: "date",
    });
    if (items.length === 0) break;
    rawItemCount += items.length;

    const mapped = mapSearchItemsToHits(items, keyword);
    for (const hit of mapped) {
      const key = hit.blogId.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(hit);
      if (all.length >= maxTotal) break;
    }

    start += items.length;
    if (items.length < pageSize) break;
  }

  return {
    hits: all.slice(0, maxTotal),
    rawItemCount,
    duplicatesRemoved: Math.max(0, rawItemCount - all.length),
  };
}
