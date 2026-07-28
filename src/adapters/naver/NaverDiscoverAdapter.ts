import type { Page } from "playwright";
import {
  getNaverBrowserSession,
  type BrowserSessionManager,
} from "../browser/BrowserSessionManager";
import { ensureNaverLogin } from "./login";
import {
  resolveNaverAdapterMode,
  type NaverAdapterMode,
} from "./NaverBlogAdapter";
import { applyAdapterDelay, sleep } from "./timing";
import {
  keywordRelevanceScore,
  matchesExclude,
  type DiscoverPolicy,
} from "../../domain/policy/discoverPolicy";
import { NEIGHBOR_AD_PENALTY_KEYWORDS } from "../../domain/policy/neighborPolicy";
import {
  hasNaverSearchApiCredentials,
  searchCandidatesViaNaverApi,
} from "./naverBlogSearchApi";

export interface DiscoverCandidate {
  blogName: string;
  blogId: string;
  url: string;
  recentlyActive: boolean;
  /** Best-effort ISO guess from search result date text */
  lastPostAt: string | null;
  dateText: string;
  keywordRelevance: number;
  matchedKeywords: string[];
  categoryHint: string | null;
  snippet: string;
  /** Latest post title from search hit (optional) */
  postTitle?: string | null;
}

/** Parse Naver mobile search relative/absolute date → activity within ~1 year. */
export function parseDiscoverDateText(dateText: string): {
  recentlyActive: boolean;
  lastPostAt: string | null;
} {
  const t = dateText.replace(/\s+/g, " ").trim();
  if (!t) return { recentlyActive: false, lastPostAt: null };

  const daysAgo = (days: number) => {
    const d = new Date(Date.now() - days * 86_400_000);
    return d.toISOString();
  };

  if (/방금|조금\s*전/.test(t) || /\d+\s*분\s*전/.test(t) || /\d+\s*시간\s*전/.test(t) || /오늘/.test(t)) {
    return { recentlyActive: true, lastPostAt: daysAgo(0) };
  }
  if (/어제/.test(t)) {
    return { recentlyActive: true, lastPostAt: daysAgo(1) };
  }
  const dayM = t.match(/(\d+)\s*일\s*전/);
  if (dayM) {
    const days = Number(dayM[1]);
    return {
      recentlyActive: Number.isFinite(days) && days <= 365,
      lastPostAt: Number.isFinite(days) ? daysAgo(days) : null,
    };
  }
  const weekM = t.match(/(\d+)\s*주\s*전/);
  if (weekM) {
    const days = Number(weekM[1]) * 7;
    return {
      recentlyActive: Number.isFinite(days) && days <= 365,
      lastPostAt: Number.isFinite(days) ? daysAgo(days) : null,
    };
  }
  const monthM = t.match(/(\d+)\s*(?:달|개월)\s*전/);
  if (monthM) {
    const days = Number(monthM[1]) * 30;
    return {
      recentlyActive: Number.isFinite(days) && days <= 365,
      lastPostAt: Number.isFinite(days) ? daysAgo(days) : null,
    };
  }
  if (/작년|지난해/.test(t)) {
    return { recentlyActive: true, lastPostAt: daysAgo(300) };
  }
  const abs = t.match(/(\d{4})[.\-/년]\s*(\d{1,2})[.\-/월]\s*(\d{1,2})/);
  if (abs) {
    const y = Number(abs[1]);
    const m = Number(abs[2]);
    const d = Number(abs[3]);
    const dt = new Date(y, m - 1, d);
    if (!Number.isNaN(dt.getTime())) {
      const ageDays = (Date.now() - dt.getTime()) / 86_400_000;
      return {
        recentlyActive: ageDays >= 0 && ageDays <= 365,
        lastPostAt: dt.toISOString(),
      };
    }
  }
  // Fallback: any relative "전" without year → treat as recent enough for search ranking
  if (/전/.test(t) && !/\d{4}/.test(t)) {
    return { recentlyActive: true, lastPostAt: daysAgo(14) };
  }
  return { recentlyActive: false, lastPostAt: null };
}

async function withPage<T>(
  session: BrowserSessionManager,
  label: string,
  fn: (page: Page) => Promise<T>,
): Promise<T> {
  return session.runWithTimeout(label, async () => {
    const acquired = await session.acquireWorkPage();
    try {
      await ensureNaverLogin(session, acquired.page);
      return await fn(acquired.page);
    } finally {
      await session.saveCookies();
      await session.releaseWorkPage(acquired.page, acquired.ephemeral);
    }
  });
}

function parseBlogIdFromHref(href: string): string | null {
  try {
    const u = new URL(href, "https://m.blog.naver.com");
    const m = u.pathname.match(/\/(?:section\/)?([^/?#]+)/);
    if (u.hostname.includes("blog.naver.com")) {
      const parts = u.pathname.split("/").filter(Boolean);
      if (
        parts[0] &&
        parts[0] !== "PostView.naver" &&
        parts[0] !== "PostList.naver"
      ) {
        return decodeURIComponent(parts[0]);
      }
    }
    const blogId = u.searchParams.get("blogId");
    if (blogId) return decodeURIComponent(blogId);
    if (m && m[1] && !["PostView.naver", "search"].includes(m[1])) {
      return decodeURIComponent(m[1]);
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Naver Discover Adapter — keyword search → candidate blogs.
 * Does not write DB; worker creates Person(stage=discover).
 */
export class NaverDiscoverAdapter {
  private readonly session: BrowserSessionManager;
  private readonly mode: NaverAdapterMode;

  constructor(session?: BrowserSessionManager, mode?: NaverAdapterMode) {
    this.session = session ?? getNaverBrowserSession();
    this.mode = mode ?? resolveNaverAdapterMode();
  }

  getMode(): NaverAdapterMode {
    return this.mode;
  }

  async searchCandidates(policy: DiscoverPolicy): Promise<DiscoverCandidate[]> {
    await applyAdapterDelay("sync");

    if (policy.search_keywords.length === 0) {
      console.log("[NaverDiscoverAdapter] no search_keywords — skip");
      return [];
    }

    if (this.mode === "mock") {
      console.log("[NaverDiscoverAdapter:mock] searchCandidates");
      return this.mockCandidates(policy);
    }

    const all: DiscoverCandidate[] = [];
    const seen = new Set<string>();

    const mergeBatch = (batch: DiscoverCandidate[]) => {
      for (const c of batch) {
        if (seen.has(c.blogId)) continue;
        seen.add(c.blogId);
        all.push(c);
      }
    };

    if (hasNaverSearchApiCredentials()) {
      try {
        const perKeyword = Math.max(
          20,
          Math.ceil(
            policy.max_candidates_per_tick /
              Math.max(1, policy.search_keywords.length),
          ),
        );
        const api = await searchCandidatesViaNaverApi({
          keywords: policy.search_keywords,
          maxPerKeyword: perKeyword,
          maxTotal: Math.max(policy.max_candidates_per_tick * 4, perKeyword),
          sort: "sim",
        });
        const adKeywords = [...NEIGHBOR_AD_PENALTY_KEYWORDS];
        const apiFiltered = api.candidates.filter((c) => {
          const haystack = `${c.blogName} ${c.snippet} ${c.postTitle ?? ""}`;
          if (matchesExclude(haystack, policy.exclude_keywords)) return false;
          if (matchesExclude(haystack, adKeywords)) return false;
          if (!c.recentlyActive) return false;
          return true;
        });
        mergeBatch(apiFiltered);
        if (api.errors.length > 0) {
          console.warn(
            "[NaverDiscoverAdapter] API keyword errors:",
            api.errors,
          );
        }
        if (apiFiltered.length > 0) {
          console.log(
            `[NaverDiscoverAdapter] API search added ${apiFiltered.length} candidates (raw ${api.rawItemCount})`,
          );
        }
      } catch (err) {
        console.warn(
          "[NaverDiscoverAdapter] API search failed:",
          err instanceof Error ? err.message : err,
        );
      }
    }

    for (const keyword of policy.search_keywords) {
      try {
        const batch = await withPage(
          this.session,
          `discover:${keyword}`,
          (page) => this.scrapeKeyword(page, keyword, policy),
        );
        mergeBatch(batch);
      } catch (err) {
        console.warn(
          `[NaverDiscoverAdapter] keyword=${keyword} failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    all.sort((a, b) => b.keywordRelevance - a.keywordRelevance);
    return all.slice(0, policy.max_candidates_per_tick);
  }

  private mockCandidates(policy: DiscoverPolicy): DiscoverCandidate[] {
    // Deterministic empty unless NAVER_DISCOVER_MOCK=1
    if (process.env.NAVER_DISCOVER_MOCK !== "1") return [];
    const kw = policy.search_keywords[0] ?? "discover";
    return [
      {
        blogName: `샘플_${kw}_로그`,
        blogId: `sample_${kw.replace(/\s+/g, "_")}`,
        url: `https://m.blog.naver.com/sample_${kw.replace(/\s+/g, "_")}`,
        recentlyActive: true,
        lastPostAt: new Date().toISOString(),
        dateText: "오늘",
        keywordRelevance: 80,
        matchedKeywords: [kw],
        categoryHint: policy.target_categories[0] ?? null,
        snippet: `${kw} 관련 샘플 후보 (mock)`,
      },
    ];
  }

  private async scrapeKeyword(
    page: Page,
    keyword: string,
    policy: DiscoverPolicy,
  ): Promise<DiscoverCandidate[]> {
    const q = encodeURIComponent(keyword);
    const url = `https://m.search.naver.com/search.naver?ssc=tab.m_blog.all&sm=mtb_jum&query=${q}`;
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: this.session.navigationTimeoutMs,
    });
    await sleep(1_500);

    const raw = await page.evaluate(() => {
      const items: Array<{
        href: string;
        name: string;
        snippet: string;
        dateText: string;
      }> = [];
      const anchors = Array.from(
        document.querySelectorAll(
          "a[href*='blog.naver.com'], a[href*='m.blog.naver.com']",
        ),
      );
      for (const a of anchors) {
        const href = (a as HTMLAnchorElement).href || "";
        if (!href) continue;
        const block =
          a.closest("li, article, .bx, .total_wrap, div") ?? a.parentElement;
        const name = (a.textContent ?? "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 80);
        const snippet = (block?.textContent ?? "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 240);
        const dateText = (
          block?.querySelector("time, .sub_time, .date, .txt_inline")
            ?.textContent ?? ""
        )
          .replace(/\s+/g, " ")
          .trim();
        items.push({ href, name, snippet, dateText });
        if (items.length >= 40) break;
      }
      return items;
    });

    const out: DiscoverCandidate[] = [];
    const seen = new Set<string>();

    for (const item of raw) {
      const blogId = parseBlogIdFromHref(item.href);
      if (!blogId || seen.has(blogId)) continue;
      seen.add(blogId);

      const haystack = `${item.name} ${item.snippet}`;
      if (matchesExclude(haystack, policy.exclude_keywords)) continue;

      const relevance = keywordRelevanceScore(haystack, policy.search_keywords);
      if (relevance <= 0 && policy.search_keywords.length > 0) {
        // At least matched search keyword page — give baseline
      }

      const matchedKeywords = policy.search_keywords.filter((k) =>
        haystack.toLowerCase().includes(k.toLowerCase()),
      );

      let categoryHint: string | null = null;
      for (const cat of policy.target_categories) {
        if (haystack.toLowerCase().includes(cat.toLowerCase())) {
          categoryHint = cat;
          break;
        }
      }

      const activity = parseDiscoverDateText(item.dateText);

      out.push({
        blogName: item.name || blogId,
        blogId,
        url: `https://m.blog.naver.com/${blogId}`,
        recentlyActive: activity.recentlyActive,
        lastPostAt: activity.lastPostAt,
        dateText: item.dateText,
        keywordRelevance: Math.max(
          relevance,
          matchedKeywords.length > 0 ? 40 : 20,
        ),
        matchedKeywords:
          matchedKeywords.length > 0 ? matchedKeywords : [keyword],
        categoryHint,
        snippet: item.snippet,
        postTitle: (item.name || "").slice(0, 120) || null,
      });
    }

    return out;
  }
}
