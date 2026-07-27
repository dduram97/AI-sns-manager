/**
 * Scrape logged-in user's Naver Blog neighbor (buddy) list via CDP page.
 * Read-only — does not request/cancel neighbors.
 *
 * Modern mobile BuddyList links look like:
 *   https://m.blog.naver.com/PostList.naver?blogId={id}&trackingCode=blog_buddylist
 * CSS modules: .buddy_item__*, .list__*, .name__*
 */

import type { Page } from "playwright";
import { sleep } from "./timing";

export type NaverBuddyListItem = {
  blogId: string;
  blogName: string;
  blogUrl: string;
  /** mutual = 서로이웃 · neighbor = 일반 이웃 · unknown */
  relationKind: "mutual" | "neighbor" | "unknown";
};

export type BuddyListPageProbe = {
  requestedUrl: string;
  finalUrl: string;
  title: string;
  httpOk: boolean;
  loginLikely: boolean;
  pageAccess: "ok" | "not_found" | "login_required" | "error" | "empty_shell";
  neighborCountText: string | null;
  candidateElements: number;
  sampleHrefs: string[];
  extracted: number;
  signals: string[];
  error?: string;
};

export type BuddyListScrapeDebug = {
  ownBlogId: string | null;
  ownBlogIdSource: string;
  loginOk: boolean;
  pages: BuddyListPageProbe[];
  reasons: string[];
  extractedBlogs: number;
};

const BLOCKED_PATH_IDS = new Set(
  [
    "BuddyList",
    "BuddyAdd",
    "BuddyListView",
    "CommentList",
    "PostView",
    "PostList",
    "Section",
    "admin",
    "go",
    "Redirect",
    "MyBlog",
    "GoBlog",
    "FeedList",
    "SectionPostSearch",
    "login",
    "Logout",
  ].map((s) => s.toLowerCase()),
);

function logSync(parts: Record<string, unknown>): void {
  console.log(
    "[neighbor-sync]",
    Object.entries(parts)
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(" "),
  );
}

/** Explicit blog id only — never treat NAVER_ID (login) as blog id. */
function resolveConfiguredBlogId(): string | null {
  const raw = process.env.NAVER_BLOG_ID?.trim() || "";
  return raw || null;
}

export function parseBlogIdFromHref(href: string): string | null {
  if (!href || href.startsWith("javascript:") || href === "#") return null;
  try {
    const u = new URL(href, "https://m.blog.naver.com");
    const host = u.hostname.toLowerCase();
    if (
      host &&
      !host.includes("blog.naver.com") &&
      !host.includes("blog.me") &&
      host !== "naver.me"
    ) {
      // allow relative resolved to m.blog
      if (!host.includes("naver.com")) return null;
    }

    const q =
      u.searchParams.get("blogId") ||
      u.searchParams.get("blogid") ||
      u.searchParams.get("blog_id");
    if (q) {
      const id = decodeURIComponent(q).trim();
      if (isPlausibleBlogId(id)) return id;
    }

    // /{blogId} or /{blogId}/{logNo}
    const path = u.pathname.replace(/\/+/g, "/");
    const m = path.match(/^\/([A-Za-z0-9._-]{2,40})(?:\/\d+)?\/?$/);
    if (m?.[1] && !BLOCKED_PATH_IDS.has(m[1].toLowerCase())) {
      if (isPlausibleBlogId(m[1])) return m[1];
    }

    // /PostList.naver already handled via query; also path blog.naver.com/{id}
    const m2 = path.match(/\/(?:blog|m\.blog)\/([A-Za-z0-9._-]{2,40})/i);
    if (m2?.[1] && isPlausibleBlogId(m2[1])) return m2[1];
  } catch {
    // ignore
  }
  return null;
}

function isPlausibleBlogId(id: string): boolean {
  if (!id || id.length < 2 || id.length > 40) return false;
  if (!/^[A-Za-z0-9._-]+$/.test(id)) return false;
  if (BLOCKED_PATH_IDS.has(id.toLowerCase())) return false;
  if (/\.(naver|css|js|png|jpg|svg)$/i.test(id)) return false;
  return true;
}

/**
 * Detect the logged-in account's blogId.
 * Prefer NAVER_BLOG_ID env, then MyBlog / session redirect — never NAVER_ID login alone.
 */
export async function resolveOwnNaverBlogId(
  page: Page,
): Promise<{ blogId: string; source: string }> {
  const configured = resolveConfiguredBlogId();
  if (configured) {
    logSync({ page: "resolveOwnBlogId", source: "env:NAVER_BLOG_ID", url: configured });
    return { blogId: configured, source: "env:NAVER_BLOG_ID" };
  }

  const candidates: Array<{ url: string; label: string }> = [
    { url: "https://blog.naver.com/MyBlog.naver", label: "MyBlog.naver" },
    { url: "https://m.blog.naver.com/GoBlog.naver", label: "GoBlog.naver" },
    {
      url: "https://section.blog.naver.com/BlogHome.naver",
      label: "BlogHome.naver",
    },
    {
      url: "https://admin.blog.naver.com/AdminHome.naver",
      label: "AdminHome.naver",
    },
  ];

  for (const c of candidates) {
    try {
      logSync({ page: "resolveOwnBlogId", url: c.url, step: "goto" });
      await page.goto(c.url, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
      await sleep(1_000);
      const finalUrl = page.url();
      logSync({ page: "resolveOwnBlogId", label: c.label, finalUrl });

      const fromUrl = parseBlogIdFromHref(finalUrl);
      if (fromUrl) {
        return { blogId: fromUrl, source: `redirect:${c.label}` };
      }

      // admin / section often embed blogId in query or data attrs
      const fromDom = await page.evaluate(() => {
        const out: string[] = [];
        const push = (v: string | null | undefined) => {
          if (v && v.trim()) out.push(v.trim());
        };
        push(location.href);
        for (const a of Array.from(
          document.querySelectorAll<HTMLAnchorElement>("a[href]"),
        ).slice(0, 80)) {
          push(a.href);
        }
        for (const el of Array.from(
          document.querySelectorAll<HTMLElement>(
            "[data-blog-id], [data-blogid], [data-blogId], [blogid]",
          ),
        ).slice(0, 40)) {
          push(
            el.getAttribute("data-blog-id") ||
              el.getAttribute("data-blogid") ||
              el.getAttribute("data-blogId") ||
              el.getAttribute("blogid"),
          );
        }
        const meta = document.querySelector(
          'meta[property="og:url"], link[rel="canonical"]',
        ) as HTMLMetaElement | HTMLLinkElement | null;
        if (meta) {
          push(
            "content" in meta
              ? meta.content
              : "href" in meta
                ? meta.href
                : null,
          );
        }
        // __NEXT_DATA__ / window state
        const next = document.querySelector("#__NEXT_DATA__");
        if (next?.textContent) {
          const m = next.textContent.match(/"blogId"\s*:\s*"([^"]+)"/);
          if (m?.[1]) push(m[1]);
        }
        const html = document.documentElement.innerHTML.slice(0, 200_000);
        const re = /["']blogId["']\s*[:=]\s*["']([A-Za-z0-9._-]{2,40})["']/g;
        let mm: RegExpExecArray | null;
        while ((mm = re.exec(html)) && out.length < 30) {
          push(mm[1]);
        }
        return out;
      });

      for (const raw of fromDom) {
        const id = parseBlogIdFromHref(raw) || (isPlausibleBlogId(raw) ? raw : null);
        if (id) {
          logSync({
            page: "resolveOwnBlogId",
            source: `dom:${c.label}`,
            blogId: id,
          });
          return { blogId: id, source: `dom:${c.label}` };
        }
      }
    } catch (err) {
      logSync({
        page: "resolveOwnBlogId",
        label: c.label,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  throw new Error(
    "내 블로그 ID를 확인하지 못했습니다. 로그인 ID와 블로그 ID가 다를 수 있습니다. .env에 NAVER_BLOG_ID=실제블로그아이디 를 설정해 주세요.",
  );
}

async function scrollBuddyList(page: Page, maxRounds = 30): Promise<void> {
  let stable = 0;
  let lastCount = 0;
  for (let i = 0; i < maxRounds; i++) {
    await page.evaluate(`(() => {
      window.scrollTo(0, document.body.scrollHeight);
      var nodes = document.querySelectorAll(
        ".buddy_list_wrap__StVtt, [class*='buddy_list'], [class*='list__'], main, #content, .list_buddy"
      );
      for (var i = 0; i < nodes.length; i++) {
        nodes[i].scrollTop = nodes[i].scrollHeight;
      }
      if (document.scrollingElement) {
        document.scrollingElement.scrollTop = document.scrollingElement.scrollHeight;
      }
    })()`);
    await sleep(450);

    const next = await page
      .locator(
        'a[href*="blogId="], a[href*="PostList.naver"], [class*="buddy_item"], [class*="item__"]',
      )
      .count()
      .catch(() => 0);

    if (next <= lastCount) {
      stable += 1;
      if (stable >= 3) break;
    } else {
      stable = 0;
      lastCount = next;
    }

    const more = page
      .locator(
        'a:has-text("더보기"), button:has-text("더보기"), a:has-text("다음"), button:has-text("다음"), [class*="btn_more"], a.pg_next',
      )
      .first();
    if ((await more.count().catch(() => 0)) > 0) {
      try {
        await more.click({ timeout: 1_500 });
        await sleep(700);
      } catch {
        // ignore
      }
    }
  }
}

/** String source — avoid tsx/esbuild __name injection into page.evaluate */
const EXTRACT_BUDDIES_SOURCE = `(function(ownBlogId) {
  var own = (ownBlogId || "").toLowerCase();
  var blocked = {
    buddylist: 1, buddyadd: 1, commentlist: 1, postview: 1, postlist: 1,
    section: 1, admin: 1, redirect: 1, myblog: 1, goblog: 1, feedlist: 1
  };
  var signals = [];
  var sampleHrefs = [];
  var map = {};

  function plausible(id) {
    return !!id && id.length >= 2 && id.length <= 40 &&
      /^[A-Za-z0-9._-]+$/.test(id) && !blocked[id.toLowerCase()];
  }

  function parseId(href) {
    if (!href || href.indexOf("javascript:") === 0 || href === "#") return null;
    try {
      var u = new URL(href, location.origin);
      var q = u.searchParams.get("blogId") || u.searchParams.get("blogid") || u.searchParams.get("blog_id");
      if (q) {
        q = decodeURIComponent(q);
        if (plausible(q)) return q;
      }
      var parts = u.pathname.split("/").filter(Boolean);
      if (parts.length >= 1) {
        var cand = decodeURIComponent(parts[0] || "");
        if (plausible(cand) && !/\\.naver$/i.test(cand)) return cand;
      }
    } catch (e) {}
    var m = href.match(/[?&]blogId=([A-Za-z0-9._-]{2,40})/i);
    if (m && m[1] && plausible(m[1])) return m[1];
    return null;
  }

  function upsert(id, name, href, mutual) {
    if (!plausible(id) || id.toLowerCase() === own) return;
    var key = id.toLowerCase();
    var cleanName = (name || id)
      .replace(/이웃추가|서로이웃|블로그|방문|이웃맺기/g, "")
      .replace(/\\s+/g, " ")
      .trim()
      .slice(0, 80);
    var prev = map[key];
    if (!prev || (mutual && !prev.mutual) ||
        (cleanName && cleanName !== id && prev.blogName === prev.blogId)) {
      map[key] = {
        blogId: id,
        blogName: cleanName || id,
        blogUrl: "https://m.blog.naver.com/" + id,
        mutual: mutual || !!(prev && prev.mutual)
      };
    }
  }

  var itemSelectors = [
    '[class*="buddy_item"] a[href]',
    '[class*="buddy_list"] a[href]',
    'a[href*="PostList.naver?blogId="]',
    'a[href*="blogId="][data-click-area*="ngr"]',
    'a[href*="trackingCode=blog_buddylist"]',
    'a.link__vh8uU[href]',
    ".list_buddy a[href]",
    "#buddyList a[href]"
  ];
  var candidateElements = 0;
  for (var si = 0; si < itemSelectors.length; si++) {
    var nodes = document.querySelectorAll(itemSelectors[si]);
    candidateElements += nodes.length;
    if (nodes.length > 0) signals.push("selector:" + itemSelectors[si] + "=" + nodes.length);
  }

  var allAnchors = Array.prototype.slice.call(document.querySelectorAll("a[href]"));
  signals.push("anchors_total=" + allAnchors.length);

  for (var i = 0; i < allAnchors.length; i++) {
    var a = allAnchors[i];
    var href = a.href || a.getAttribute("href") || "";
    if (sampleHrefs.length < 12 && href) sampleHrefs.push(String(href).slice(0, 160));
    if (/nidlogin|Help\\.naver|notice|logout/i.test(href)) continue;
    if (/BuddyAdd|buddyadd/i.test(href) && !/[?&]blogId=/i.test(href)) continue;
    var id = parseId(href);
    if (!id) continue;
    var block = a.closest('[class*="buddy_item"], [class*="item__"], li, tr, article, .buddy') || a.parentElement;
    var blockText = ((block && block.textContent) || "").replace(/\\s+/g, " ");
    var mutual = /서로이웃/.test(blockText);
    var nameEl = block ? block.querySelector('[class*="name__"], .name, strong, em, [class*="title__"]') : null;
    var name = ((nameEl && nameEl.textContent) || a.getAttribute("title") || a.textContent || "")
      .replace(/\\s+/g, " ").trim() || id;
    upsert(id, name, href, mutual);
  }

  var dataEls = document.querySelectorAll("[data-blog-id], [data-blogid], [data-blogId], [blogid]");
  for (var d = 0; d < dataEls.length; d++) {
    var el = dataEls[d];
    var did = el.getAttribute("data-blog-id") || el.getAttribute("data-blogid") ||
      el.getAttribute("data-blogId") || el.getAttribute("blogid");
    if (!did) continue;
    candidateElements += 1;
    var dname = ((el.textContent || "").replace(/\\s+/g, " ").trim()).slice(0, 80);
    upsert(did, dname || did, "https://m.blog.naver.com/" + did, false);
  }

  var keys = Object.keys(map);
  if (keys.length === 0) {
    signals.push("fallback:html_blogId_scan");
    var html = document.documentElement.innerHTML;
    var re = /[?&]blogId=([A-Za-z0-9._-]{2,40})/gi;
    var seen = {};
    var mm;
    while ((mm = re.exec(html))) {
      var hid = mm[1];
      if (seen[hid.toLowerCase()]) continue;
      seen[hid.toLowerCase()] = 1;
      upsert(hid, hid, "https://m.blog.naver.com/PostList.naver?blogId=" + hid, false);
      if (Object.keys(seen).length >= 500) break;
    }
    signals.push("html_blogId_unique=" + Object.keys(seen).length);
  }

  var next = document.querySelector("#__NEXT_DATA__");
  if (next && next.textContent) {
    signals.push("found:__NEXT_DATA__");
    var re2 = /"blogId"\\s*:\\s*"([A-Za-z0-9._-]{2,40})"/g;
    var m2;
    while ((m2 = re2.exec(next.textContent))) {
      upsert(m2[1], m2[1], "https://m.blog.naver.com/" + m2[1], false);
    }
  }

  if (Object.keys(map).length === 0) {
    var body = (document.body && document.body.innerText) || "";
    if (/로그인/.test(body)) signals.push("body_has_login_text");
    if (/존재하지\\s*않|없는\\s*블로그|404/.test(body)) signals.push("body_blog_not_found");
    if (/이웃\\s*이\\s*없|등록된\\s*이웃이\\s*없/.test(body)) signals.push("body_empty_neighbors");
  }

  var items = Object.keys(map).map(function(k) {
    var v = map[k];
    return {
      blogId: v.blogId,
      blogName: v.blogName,
      blogUrl: v.blogUrl,
      relationKind: v.mutual ? "mutual" : "neighbor"
    };
  });

  return {
    items: items,
    candidateElements: candidateElements,
    sampleHrefs: sampleHrefs,
    signals: signals
  };
})`;

async function extractBuddiesViaEvaluate(
  page: Page,
  ownBlogId: string,
): Promise<{
  items: NaverBuddyListItem[];
  candidateElements: number;
  sampleHrefs: string[];
  signals: string[];
}> {
  const raw = (await page.evaluate(
    `${EXTRACT_BUDDIES_SOURCE}(${JSON.stringify(ownBlogId)})`,
  )) as {
    items: NaverBuddyListItem[];
    candidateElements: number;
    sampleHrefs: string[];
    signals: string[];
  };
  return raw;
}

async function probeAndScrapePage(
  page: Page,
  requestedUrl: string,
  ownBlogId: string,
): Promise<{ items: NaverBuddyListItem[]; probe: BuddyListPageProbe }> {
  const probe: BuddyListPageProbe = {
    requestedUrl,
    finalUrl: "",
    title: "",
    httpOk: false,
    loginLikely: true,
    pageAccess: "error",
    neighborCountText: null,
    candidateElements: 0,
    sampleHrefs: [],
    extracted: 0,
    signals: [],
  };

  try {
    logSync({ page: "BuddyList", url: requestedUrl, step: "goto" });
    const resp = await page.goto(requestedUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await sleep(1_500);
    // wait for list or count
    await page
      .waitForSelector(
        '[class*="buddy_item"], [class*="buddy_list"], a[href*="blogId="], [class*="number__"]',
        { timeout: 8_000 },
      )
      .catch(() => null);

    probe.finalUrl = page.url();
    probe.title = await page.title().catch(() => "");
    const status = resp?.status() ?? 0;
    probe.httpOk = status >= 200 && status < 400;
    probe.signals.push(`http_status=${status}`);

    const bodyText = await page.locator("body").innerText().catch(() => "");
    const compact = bodyText.replace(/\s+/g, " ").trim();

    if (/nidlogin|로그인\s*해주세요|로그인\s*후/i.test(probe.finalUrl + compact.slice(0, 500))) {
      probe.loginLikely = false;
      probe.pageAccess = "login_required";
      probe.signals.push("login_required");
    } else if (
      status === 404 ||
      /존재하지\s*않|없는\s*블로그|페이지를\s*찾을\s*수\s*없/i.test(compact)
    ) {
      probe.pageAccess = "not_found";
      probe.signals.push("blog_or_page_not_found");
    } else {
      probe.pageAccess = "ok";
    }

    const countText = await page
      .locator('[class*="number__"], [class*="count__"]')
      .first()
      .innerText()
      .catch(() => "");
    if (countText) {
      probe.neighborCountText = countText.replace(/\s+/g, " ").trim();
      probe.signals.push(`count_text=${probe.neighborCountText}`);
    }

    let extracted = await extractBuddiesViaEvaluate(page, ownBlogId);
    if (probe.pageAccess === "ok") {
      await scrollBuddyList(page);
      const afterScroll = await extractBuddiesViaEvaluate(page, ownBlogId);
      if (afterScroll.items.length >= extracted.items.length) {
        extracted = afterScroll;
      } else {
        const byId = new Map(
          extracted.items.map((i) => [i.blogId.toLowerCase(), i]),
        );
        for (const item of afterScroll.items) {
          byId.set(item.blogId.toLowerCase(), item);
        }
        extracted = {
          ...afterScroll,
          items: [...byId.values()],
          candidateElements: Math.max(
            extracted.candidateElements,
            afterScroll.candidateElements,
          ),
          signals: [
            ...extracted.signals,
            ...afterScroll.signals,
            "merged_scroll",
          ],
        };
      }
    }

    probe.candidateElements = extracted.candidateElements;
    probe.sampleHrefs = extracted.sampleHrefs;
    probe.signals.push(...extracted.signals);
    probe.extracted = extracted.items.length;

    if (probe.pageAccess === "ok" && extracted.items.length === 0) {
      if (extracted.candidateElements === 0) {
        probe.pageAccess = "empty_shell";
        probe.signals.push("selector_miss_or_empty_dom");
      }
    }

    logSync({
      page: "BuddyList",
      url: probe.finalUrl,
      login: probe.loginLikely ? "ok" : "need_login",
      access: probe.pageAccess,
      candidate_elements: probe.candidateElements,
      extracted_blogs: probe.extracted,
      samples: probe.sampleHrefs.slice(0, 5),
    });

    return { items: extracted.items, probe };
  } catch (err) {
    probe.error = err instanceof Error ? err.message : String(err);
    probe.pageAccess = "error";
    probe.signals.push(`error=${probe.error}`);
    logSync({ page: "BuddyList", url: requestedUrl, error: probe.error });
    return { items: [], probe };
  }
}

/**
 * Try async buddy list endpoints from the logged-in page context (cookies).
 * String evaluate — avoid tsx __name injection.
 */
async function fetchBuddyListViaAsyncApi(
  page: Page,
  ownBlogId: string,
  maxItems: number,
): Promise<NaverBuddyListItem[]> {
  const expr = `(async function(blogId, max) {
    var out = [];
    var seen = {};
    function add(id, name) {
      var key = String(id || "").toLowerCase();
      if (!id || seen[key] || key === String(blogId).toLowerCase()) return;
      if (!/^[A-Za-z0-9._-]{2,40}$/.test(id)) return;
      seen[key] = 1;
      out.push({
        blogId: id,
        blogName: String(name || id).slice(0, 80),
        blogUrl: "https://m.blog.naver.com/" + id,
        relationKind: "neighbor"
      });
    }
    function harvest(text) {
      var re = /"blogId"\\s*:\\s*"([A-Za-z0-9._-]{2,40})"/g;
      var m;
      while ((m = re.exec(text))) add(m[1], m[1]);
      var re2 = /[?&]blogId=([A-Za-z0-9._-]{2,40})/g;
      while ((m = re2.exec(text))) add(m[1], m[1]);
    }
    var bases = [
      "https://m.blog.naver.com/BuddyListAsyncTpl.naver?blogId=" + encodeURIComponent(blogId),
      "https://m.blog.naver.com/BuddyListOrderByUpdatePostAsyncTpl.naver?blogId=" + encodeURIComponent(blogId)
    ];
    for (var pageNo = 1; pageNo <= 20 && out.length < max; pageNo++) {
      var gotAny = false;
      for (var bi = 0; bi < bases.length; bi++) {
        var url = bases[bi] + "&currentPage=" + pageNo + "&countPerPage=30";
        try {
          var res = await fetch(url, {
            credentials: "include",
            headers: { Accept: "text/html, application/json, */*" }
          });
          if (!res.ok) continue;
          var text = await res.text();
          var before = out.length;
          harvest(text);
          if (out.length > before) gotAny = true;
        } catch (e) {}
      }
      if (!gotAny) break;
    }
    return out.slice(0, max);
  })(${JSON.stringify(ownBlogId)}, ${JSON.stringify(maxItems)})`;

  const items = (await page.evaluate(expr)) as NaverBuddyListItem[];
  logSync({
    page: "BuddyListAsync",
    extracted_blogs: items.length,
  });
  return items;
}

/**
 * Load buddy list for the logged-in blog and return unique neighbors + debug.
 */
export async function scrapeOwnBuddyList(
  page: Page,
  opts?: { ownBlogId?: string; maxItems?: number },
): Promise<{
  ownBlogId: string;
  items: NaverBuddyListItem[];
  debug: BuddyListScrapeDebug;
}> {
  const maxItems = opts?.maxItems ?? 2_000;
  let ownBlogId: string;
  let ownBlogIdSource: string;

  if (opts?.ownBlogId?.trim()) {
    ownBlogId = opts.ownBlogId.trim();
    ownBlogIdSource = "opts";
  } else {
    const resolved = await resolveOwnNaverBlogId(page);
    ownBlogId = resolved.blogId;
    ownBlogIdSource = resolved.source;
  }

  logSync({
    page: "start",
    ownBlogId,
    ownBlogIdSource,
    login: "checking",
  });

  const debug: BuddyListScrapeDebug = {
    ownBlogId,
    ownBlogIdSource,
    loginOk: true,
    pages: [],
    reasons: [],
    extractedBlogs: 0,
  };

  const urls = [
    `https://m.blog.naver.com/BuddyList.naver?blogId=${encodeURIComponent(ownBlogId)}`,
    `https://blog.naver.com/BuddyListView.naver?blogId=${encodeURIComponent(ownBlogId)}`,
    `https://m.blog.naver.com/${encodeURIComponent(ownBlogId)}`,
  ];

  const byId = new Map<string, NaverBuddyListItem>();

  for (const url of urls) {
    const { items, probe } = await probeAndScrapePage(page, url, ownBlogId);
    debug.pages.push(probe);
    if (!probe.loginLikely) debug.loginOk = false;

    for (const item of items) {
      const key = item.blogId.toLowerCase();
      if (!byId.has(key)) byId.set(key, item);
      if (byId.size >= maxItems) break;
    }
    if (byId.size >= Math.min(10, maxItems)) break;
  }

  // Async API fallback when DOM empty
  if (byId.size === 0 && debug.loginOk) {
    debug.reasons.push("DOM에서 이웃 0명 → Async API 시도");
    try {
      // stay on last buddy page for cookies
      const asyncItems = await fetchBuddyListViaAsyncApi(page, ownBlogId, maxItems);
      for (const item of asyncItems) {
        byId.set(item.blogId.toLowerCase(), item);
      }
    } catch (err) {
      debug.reasons.push(
        `Async API 실패: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const items = [...byId.values()].slice(0, maxItems);
  debug.extractedBlogs = items.length;

  // Build human reasons
  if (!debug.loginOk) {
    debug.reasons.push("권한/로그인 필요 — CDP Chrome에서 네이버 로그인 상태를 확인하세요");
  }
  const notFound = debug.pages.some((p) => p.pageAccess === "not_found");
  if (notFound) {
    debug.reasons.push(
      `블로그 ID '${ownBlogId}' 페이지를 찾지 못했습니다 (404). NAVER_BLOG_ID가 실제 블로그 주소인지 확인하세요. (로그인 ID와 다를 수 있음)`,
    );
  }
  const selectorMiss = debug.pages.every(
    (p) => p.candidateElements === 0 && p.pageAccess !== "not_found",
  );
  if (items.length === 0 && selectorMiss && !notFound) {
    debug.reasons.push("셀렉터 실패 — 이웃 목록 element를 찾지 못했습니다");
  }
  const loadFail = debug.pages.every((p) => p.pageAccess === "error");
  if (loadFail) {
    debug.reasons.push("페이지 로딩 실패");
  }
  if (items.length === 0 && debug.pages.some((p) => p.pageAccess === "ok")) {
    debug.reasons.push("페이지 접근 성공 · 이웃 목록 발견 0개");
  }
  if (debug.pages.some((p) => p.pageAccess === "ok")) {
    debug.reasons.unshift("페이지 접근 성공");
  }
  if (debug.loginOk) {
    debug.reasons.unshift("로그인 확인 성공");
  }

  logSync({
    page: "done",
    url: debug.pages[0]?.finalUrl ?? "",
    login: debug.loginOk ? "ok" : "need_login",
    candidate_elements: debug.pages.reduce((s, p) => s + p.candidateElements, 0),
    extracted_blogs: items.length,
    saved: 0,
    reasons: debug.reasons,
  });

  return { ownBlogId, items, debug };
}
