import "server-only";

import type { Page } from "playwright";
import { getNaverBrowserSession } from "@/adapters/browser/BrowserSessionManager";
import { fetchBlogRecentPostsViaRss } from "@/adapters/naver/naverBlogRss";
import { parseNeighborRelationStatus } from "@/domain/neighbor/relationStatus";
import {
  extractCommentApiError,
  extractCommentList,
  extractLikeCount,
  extractLikeUsers,
  fetchNaverBlogComments,
  fetchNaverBlogLikeGuests,
  fetchNaverBlogLikes,
  fetchNaverCommentMeta,
} from "@/lib/naverBlogInboundApi";
import {
  analyzeBlogRelationsFromInbound,
  countRelationWindowFilter,
  extractSympathyUserViewList,
  mergeRelationUsersAcrossPosts,
  summarizeBlogRelations,
  type BlogRelationUser,
} from "@/lib/naverBlogRelationAnalysis";
import { createServiceClient } from "@/lib/supabase";
import { createSupervisorRepos } from "@/repositories/index";
import { blogNameFromPerson } from "@/services/todayDashboard/todayDashboardShared";

const REPLY_WINDOW_DAYS = 3;
const DISPLAY_LIMIT = 20;
/** RSS에서 가져올 내 블로그 글 수 (작성일 무관 — 활동일로 필터) */
const MAX_OWN_POSTS_TO_SCAN = 50;
const COMMENT_PAGE_SIZE = 100;

/** Verbose investigation logs — enable with REPLY_QUEUE_DEBUG=1 */
function rqVerbose(...args: unknown[]) {
  if (process.env.REPLY_QUEUE_DEBUG === "1") console.info(...args);
}

export type TodayReplyQueueItem = {
  id: string;
  personId: string;
  blogName: string;
  reason: string;
  reasonLabel: string;
  likeCount: number;
  commentCount: number;
  lastActivityAt: string;
  lastActivityLabel: string;
  relationScore: number;
  relationType: string | null;
  isInteractionUser: boolean;
  activityClassLabel: string;
  /** 답방 대상 이웃의 최신 블로그 글 (RSS 1건) */
  latestPostTitle: string | null;
  latestPostUrl: string | null;
};

type InboundAgg = {
  personId: string;
  likeCount: number;
  commentCount: number;
  lastActivityAt: string;
  relationScore: number;
  relationType: string | null;
  isInteraction: boolean;
};

type RawInboundEvent = {
  actorBlogId: string;
  kind: "like" | "comment";
  occurredAt: string;
};

type InboundActivityProbeRow = {
  blogId: string;
  nickname: string | null;
  createdAt: string | null;
  windowStatus: "included" | "excluded";
  reason: string;
};

type InboundApiCallProbe = {
  kind: "comment" | "like";
  url: string;
  method: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  cookie: string;
  referer: string;
  status: number | null;
  ok: boolean | null;
  responseSnippet: string | null;
  error: string | null;
};

type InboundPostProbeResult = {
  events: RawInboundEvent[];
  commentCount: number;
  commentRows: InboundActivityProbeRow[];
  likeCount: number;
  likeRows: InboundActivityProbeRow[];
  commentSamples: unknown[];
  likeSamples: unknown[];
  apiCalls: InboundApiCallProbe[];
  pageUrl: string;
  commentInvestigate: {
    httpStatus: number | null;
    responseBody: string | null;
    jsonParseOk: boolean;
    commentsLength: number;
    sample: unknown | null;
    sampleBlogId: string | null;
    sampleNickname: string | null;
    sampleCreatedAt: string | null;
    sampleWithin3Days: boolean | null;
    includedInWindowCount: number;
    fetchError: string | null;
  };
};

type BrowserNetworkProbe = {
  url: string;
  method: string;
  resourceType: string;
  status?: number;
  responseContentType?: string;
};

/**
 * Recent-3-days window in KST: from midnight KST of (today - 3 days).
 * Example: if today is 7/29 KST → since 7/26 00:00 KST.
 */
function replyWindowStartMs(now = Date.now()): number {
  const KST_OFFSET_MS = 9 * 60 * 60_000;
  const kst = new Date(now + KST_OFFSET_MS);
  const startOfTodayKstUtc =
    Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate()) -
    KST_OFFSET_MS;
  return startOfTodayKstUtc - REPLY_WINDOW_DAYS * 86_400_000;
}

function replyWindowStartIso(now = Date.now()): string {
  return new Date(replyWindowStartMs(now)).toISOString();
}

function resolveOwnBlogId(): string | null {
  const id = process.env.NAVER_BLOG_ID?.trim();
  return id || null;
}

function replyQueueRssUrls(blogId: string): string[] {
  const id = blogId.trim();
  return [
    `https://rss.blog.naver.com/${encodeURIComponent(id)}.xml`,
    `https://blog.rss.naver.com/${encodeURIComponent(id)}.xml`,
  ];
}

/** Investigation-only RSS probe (does not affect fetchBlogRecentPostsViaRss). */
async function logReplyQueueRssProbe(blogId: string): Promise<void> {
  const urls = replyQueueRssUrls(blogId);
  for (const url of urls) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8_000);
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: {
          Accept: "application/rss+xml, application/xml, text/xml, */*",
          "User-Agent": "AI-SNS-Manager/1.0 (neighbor-feed)",
        },
        cache: "no-store",
      });
      clearTimeout(timer);
      const text = await res.text();
      const itemBlocks = text.match(/<item[\s\S]*?<\/item>/gi) ?? [];
      const firstBlock = itemBlocks[0] ?? "";
      const pubDateRaw =
        firstBlock.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i)?.[1]?.trim() ??
        null;
      rqVerbose("[reply_queue][debug][rss]", {
        url,
        status: res.status,
        ok: res.ok,
        itemCount: itemBlocks.length,
        hasItemTag: text.includes("<item"),
        firstPubDateRaw: pubDateRaw,
      });
    } catch (err) {
      rqVerbose("[reply_queue][debug][rss]", {
        url,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

function reasonFromCounts(likeCount: number, commentCount: number): string {
  if (likeCount > 0 && commentCount > 0) return "like_comment";
  if (commentCount > 0) return "comment";
  return "like";
}

export function replyReasonLabel(
  reason: string,
  likeCount: number,
  commentCount: number,
  isInteractionUser = false,
): string {
  if (isInteractionUser || (likeCount > 0 && commentCount > 0)) {
    return "교류 사용자";
  }
  if (commentCount > 0) return "댓글";
  if (likeCount > 0) return "공감";
  if (reason === "like_comment") return "교류 사용자";
  if (reason === "comment") return "댓글";
  if (reason === "like") return "공감";
  return reason;
}

export function formatReplyActivityRelativeKo(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diffMs = Date.now() - t;
  if (diffMs < 60_000) return "방금 전";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "1일 전";
  if (days < 7) return `${days}일 전`;
  return new Date(iso).toLocaleDateString("ko-KR", {
    month: "short",
    day: "numeric",
  });
}

async function loadAcceptedNeighborBlogMap(): Promise<Map<string, string>> {
  const db = createServiceClient();
  const repos = createSupervisorRepos(db);
  const rows = await repos.person.listCrmRows();
  const map = new Map<string, string>();

  for (const row of rows) {
    const meta = row.person.discover_meta ?? {};
    if (parseNeighborRelationStatus(meta) !== "accepted") continue;

    const personId = row.person.id;
    const metaBlogId =
      (typeof meta.blog_id === "string" && meta.blog_id.trim()) ||
      (typeof meta.blogId === "string" && meta.blogId.trim()) ||
      null;
    if (metaBlogId) map.set(metaBlogId.toLowerCase(), personId);
  }

  const { data: identities, error } = await db
    .from("channel_identities")
    .select("person_id, external_key")
    .eq("channel", "blog");
  if (error) {
    throw new Error(`replyQueue.loadIdentities: ${error.message}`);
  }
  for (const row of identities ?? []) {
    const personId = String(row.person_id ?? "");
    const blogId = String(row.external_key ?? "").trim().toLowerCase();
    if (!personId || !blogId) continue;
    const crm = rows.find((r) => r.person.id === personId);
    if (!crm) continue;
    const meta = crm.person.discover_meta ?? {};
    if (parseNeighborRelationStatus(meta) !== "accepted") continue;
    map.set(blogId, personId);
  }

  return map;
}

async function fetchNeighborLatestPost(blogId: string): Promise<{
  title: string;
  postUrl: string;
} | null> {
  const id = blogId.trim();
  if (!id) return null;
  const posts = await fetchBlogRecentPostsViaRss(id, 1);
  const latest = posts[0];
  if (!latest) return null;
  return { title: latest.title, postUrl: latest.postUrl };
}


function isInboundNetworkProbeUrl(url: string): boolean {
  return /commentbox|commentBox|cbox|web_naver_list|comments-info|comments-template|blogfe\/like|blogserver\/like|likeIt|sympathy|guestbook|CommentList|like\/v1/i.test(
    url,
  );
}

function resolveInternalApiBase(): string {
  const explicit = process.env.INTERNAL_API_BASE?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (appUrl) return appUrl.replace(/\/$/, "");
  if (process.env.VERCEL_URL?.trim()) {
    return `https://${process.env.VERCEL_URL.trim().replace(/\/$/, "")}`;
  }
  return `http://127.0.0.1:${process.env.PORT?.trim() || "3000"}`;
}

type BffInboundResponse = {
  ok: boolean;
  status: number | null;
  url: string;
  method: string;
  query: Record<string, string>;
  requestHeaders: Record<string, string>;
  cookie: string;
  referer: string;
  bodySnippet: string;
  json: unknown | null;
  jsonParseOk: boolean;
  error: string | null;
  attempts?: Array<{
    url: string;
    status: number | null;
    ok: boolean;
    bodySnippet: string;
    error: string | null;
  }>;
};

async function callNaverInboundBff(
  kind: "comments" | "likes",
  input: {
    blogId: string;
    logNo: string;
    cookie: string;
    referer: string;
    pageSize: number;
    q?: string | null;
    callback?: string | null;
  },
): Promise<BffInboundResponse> {
  const base = resolveInternalApiBase();
  const endpoint = `${base}/api/naver/blog/${kind}`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5_000);
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(input),
      cache: "no-store",
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const json = (await res.json()) as BffInboundResponse;
    if (!res.ok && json.error == null) {
      return {
        ...json,
        ok: false,
        status: res.status,
        error: json.error ?? `BFF HTTP ${res.status}`,
      };
    }
    return json;
  } catch (err) {
    // RSC self-fetch can fail/deadlock; fall back to in-process BFF (same as Route Handler).
    console.warn("[reply_queue][bff] HTTP call failed, using in-process BFF", {
      endpoint,
      error: err instanceof Error ? err.message : String(err),
    });
    if (kind === "comments") {
      const result = await fetchNaverBlogComments(input);
      return {
        ok: result.ok,
        status: result.status,
        url: result.url,
        method: result.method,
        query: result.query,
        requestHeaders: result.requestHeaders,
        cookie: result.cookie,
        referer: result.referer,
        bodySnippet: result.bodySnippet,
        json: result.json,
        jsonParseOk: result.jsonParseOk,
        error: result.error,
      };
    }
    const { primary, attempts } = await fetchNaverBlogLikes(input);
    return {
      ok: primary.ok,
      status: primary.status,
      url: primary.url,
      method: primary.method,
      query: primary.query,
      requestHeaders: primary.requestHeaders,
      cookie: primary.cookie,
      referer: primary.referer,
      bodySnippet: primary.bodySnippet,
      json: primary.json,
      jsonParseOk: primary.jsonParseOk,
      error: primary.error,
      attempts: attempts.map((a) => ({
        url: a.url,
        status: a.status,
        ok: a.ok,
        bodySnippet: a.bodySnippet,
        error: a.error,
      })),
    };
  }
}

function parseActivityMs(mod: unknown): number | null {
  if (typeof mod === "number") return mod > 1e12 ? mod : mod * 1000;
  if (typeof mod === "string") {
    const parsed = Date.parse(mod);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

function mapCommentRows(
  list: unknown[],
  sinceMs: number,
): {
  events: RawInboundEvent[];
  rows: InboundActivityProbeRow[];
  includedInWindowCount: number;
} {
  const events: RawInboundEvent[] = [];
  const rows: InboundActivityProbeRow[] = [];
  let includedInWindowCount = 0;
  for (const item of list) {
    const c = (item ?? {}) as Record<string, unknown>;
    const actor = String(
      // Commentbox: author id is profileUserId (not sympathyUserViewList).
      c.profileUserId ??
        c.profile_user_id ??
        c.userId ??
        c.user_id ??
        c.maskedUserId ??
        c.blogId ??
        "",
    ).trim();
    const nickname =
      String(
        c.userName ?? c.user_name ?? c.nickname ?? c.writer ?? "",
      ).trim() || null;
    const ms = parseActivityMs(
      c.modTime ?? c.modTimeInMilli ?? c.regTime ?? c.regTimeInMilli ?? c.date,
    );
    const createdAt = ms != null ? new Date(ms).toISOString() : null;
    if (!actor) {
      rows.push({
        blogId: "",
        nickname,
        createdAt,
        windowStatus: "excluded",
        reason: "missing blogId",
      });
      continue;
    }
    const actorLower = actor.toLowerCase();
    if (ms == null) {
      rows.push({
        blogId: actorLower,
        nickname,
        createdAt,
        windowStatus: "excluded",
        reason: "activity date parse failed",
      });
      continue;
    }
    if (ms < sinceMs) {
      rows.push({
        blogId: actorLower,
        nickname,
        createdAt,
        windowStatus: "excluded",
        reason: "activity older than 3 days",
      });
      continue;
    }
    rows.push({
      blogId: actorLower,
      nickname,
      createdAt,
      windowStatus: "included",
      reason: "activity within window",
    });
    includedInWindowCount += 1;
    events.push({
      actorBlogId: actorLower,
      kind: "comment",
      occurredAt: new Date(ms).toISOString(),
    });
  }
  return { events, rows, includedInWindowCount };
}

function mapLikeRows(
  list: unknown[],
  sinceMs: number,
): { events: RawInboundEvent[]; rows: InboundActivityProbeRow[] } {
  const events: RawInboundEvent[] = [];
  const rows: InboundActivityProbeRow[] = [];
  for (const item of list) {
    const u = (item ?? {}) as Record<string, unknown>;
    const actor = String(
      u.userId ??
        u.user_id ??
        u.blogId ??
        u.blog_id ??
        u.maskedId ??
        u.id ??
        "",
    ).trim();
    const nickname =
      String(
        u.userNickName ??
          u.nickname ??
          u.nickName ??
          u.userName ??
          u.name ??
          "",
      ).trim() || null;
    const ms = parseActivityMs(
      u.createdAt ?? u.created_at ?? u.likeTime ?? u.likeTimeInMilli ?? u.date,
    );
    const createdAt = ms != null ? new Date(ms).toISOString() : null;
    if (!actor) {
      rows.push({
        blogId: "",
        nickname,
        createdAt,
        windowStatus: "excluded",
        reason: "missing blogId",
      });
      continue;
    }
    const actorLower = actor.toLowerCase();
    if (ms == null) {
      rows.push({
        blogId: actorLower,
        nickname,
        createdAt,
        windowStatus: "excluded",
        reason: "activity date parse failed",
      });
      continue;
    }
    if (ms < sinceMs) {
      rows.push({
        blogId: actorLower,
        nickname,
        createdAt,
        windowStatus: "excluded",
        reason: "activity older than 3 days",
      });
      continue;
    }
    rows.push({
      blogId: actorLower,
      nickname,
      createdAt,
      windowStatus: "included",
      reason: "activity within window",
    });
    events.push({
      actorBlogId: actorLower,
      kind: "like",
      occurredAt: new Date(ms).toISOString(),
    });
  }
  return { events, rows };
}

async function collectPageCookieHeader(page: Page): Promise<string> {
  const cookies = await page.context().cookies([
    "https://m.blog.naver.com",
    "https://blog.naver.com",
    "https://naver.com",
    "https://www.naver.com",
    "https://apis.naver.com",
  ]);
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

function extractBlogfeLikeParams(
  browserNetwork: BrowserNetworkProbe[],
): { q: string | null; callback: string | null } {
  for (const n of browserNetwork) {
    if (!/blogfe\/like\/v1\/search\/contents/i.test(n.url)) continue;
    try {
      const u = new URL(n.url);
      return {
        q: u.searchParams.get("q"),
        callback: u.searchParams.get("callback"),
      };
    } catch {
      // continue
    }
  }
  return { q: null, callback: null };
}

function extractCommentboxUrl(
  browserNetwork: BrowserNetworkProbe[],
): string | null {
  for (const n of browserNetwork) {
    if (!/commentBox\/cbox\/web_naver_list|web_naver_list_json/i.test(n.url)) {
      continue;
    }
    // Prefer real mobile objectId shape: {blogNo}_201_{logNo}
    if (/objectId=\d+_201_\d+/i.test(n.url) || /pool=blogid/i.test(n.url)) {
      return n.url;
    }
  }
  for (const n of browserNetwork) {
    if (/web_naver_list_json/i.test(n.url)) return n.url;
  }
  return null;
}

function sampleProfileUserIds(commentList: unknown[], limit = 3): string[] {
  const out: string[] = [];
  for (const item of commentList) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    const id = String(
      c.profileUserId ?? c.profile_user_id ?? c.userId ?? "",
    ).trim();
    if (!id) continue;
    out.push(id);
    if (out.length >= limit) break;
  }
  return out;
}

function sampleSympathyUserIds(likeJson: unknown, limit = 3): string[] {
  const list = extractSympathyUserViewList(likeJson);
  const out: string[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const id = String(
      (item as Record<string, unknown>).userId ??
        (item as Record<string, unknown>).user_id ??
        "",
    ).trim();
    if (!id) continue;
    out.push(id);
    if (out.length >= limit) break;
  }
  return out;
}

async function fetchInboundFromPost(
  page: Page,
  ownBlogId: string,
  logNo: string,
  sinceMs: number,
  opts?: { blogNo?: string | null },
): Promise<{ events: RawInboundEvent[]; relations: BlogRelationUser[] }> {
  const postUrl = `https://m.blog.naver.com/${encodeURIComponent(ownBlogId)}/${logNo}`;

  rqVerbose("[reply_queue][devtools-hint]", {
    logNo,
    postUrl,
    howToFindRealCommentApi:
      "Chrome DevTools → Network → filter: commentbox OR cbox OR web_naver_list OR CommentList",
      howToFindRealLikeApi:
      "Chrome DevTools → Network → filter: blogfe/like OR blogserver/like OR likeIt OR sympathy",
    compareAgainst:
      "Compare those request URLs / query / headers / referer / cookie with [reply_queue][api-call] logs below",
  });

  const browserNetwork: BrowserNetworkProbe[] = [];
  const onRequest = (req: {
    url: () => string;
    method: () => string;
    resourceType: () => string;
  }) => {
    const url = req.url();
    if (!isInboundNetworkProbeUrl(url)) return;
    browserNetwork.push({
      url,
      method: req.method(),
      resourceType: req.resourceType(),
    });
  };
  const onResponse = async (res: {
    url: () => string;
    status: () => number;
    request: () => { method: () => string; resourceType: () => string };
    headers: () => Record<string, string>;
  }) => {
    const url = res.url();
    if (!isInboundNetworkProbeUrl(url)) return;
    browserNetwork.push({
      url,
      method: res.request().method(),
      resourceType: res.request().resourceType(),
      status: res.status(),
      responseContentType: res.headers()["content-type"],
    });
  };
  page.on("request", onRequest);
  page.on("response", onResponse);

  try {
    await page.goto(postUrl, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    // Cookie + like JSONP only; comment list uses comments-info blogNo (no CommentList nav).
    await page.waitForTimeout(1_500);

    const cookie = await collectPageCookieHeader(page);
    const referer = postUrl;
    const pageUrl = page.url();
    const blogfeParams = extractBlogfeLikeParams(browserNetwork);
    const commentboxUrl = extractCommentboxUrl(browserNetwork);
    rqVerbose("[reply_queue][like-bff-params]", {
      logNo,
      capturedQ: blogfeParams.q,
      capturedCallback: blogfeParams.callback,
      fallbackQ: `blog[${ownBlogId}_${logNo}]`,
    });
    rqVerbose("[reply_queue][comment-bff-params]", {
      logNo,
      capturedCommentboxUrl: commentboxUrl,
      cookiePresent: Boolean(cookie.trim()),
      cookieLen: cookie.length,
    });

    // Prefer in-process Naver fetch during relation sync (avoid self-fetch / empty BFF).
    const commentBff = await fetchNaverBlogComments({
      blogId: ownBlogId,
      logNo,
      cookie,
      referer,
      pageSize: COMMENT_PAGE_SIZE,
      urlOverride: commentboxUrl,
      blogNo: opts?.blogNo ?? null,
    });
    const likeSearch = await fetchNaverBlogLikes({
      blogId: ownBlogId,
      logNo,
      cookie,
      referer,
      pageSize: COMMENT_PAGE_SIZE,
      q: blogfeParams.q,
      callback: blogfeParams.callback,
    });
    const likeGuests = await fetchNaverBlogLikeGuests({
      blogId: ownBlogId,
      logNo,
      cookie,
      referer,
      pageSize: COMMENT_PAGE_SIZE,
    });

    const likeBff = {
      ok: likeGuests.primary.ok || likeSearch.primary.ok,
      status: likeGuests.primary.status ?? likeSearch.primary.status,
      url: likeGuests.primary.url || likeSearch.primary.url,
      method: "GET",
      query: likeGuests.primary.query ?? likeSearch.primary.query,
      requestHeaders:
        likeGuests.primary.requestHeaders ?? likeSearch.primary.requestHeaders,
      cookie,
      referer,
      bodySnippet:
        likeGuests.primary.bodySnippet || likeSearch.primary.bodySnippet,
      json: likeGuests.primary.json ?? likeSearch.primary.json,
      jsonParseOk:
        likeGuests.primary.jsonParseOk || likeSearch.primary.jsonParseOk,
      error: likeGuests.primary.error ?? likeSearch.primary.error,
      attempts: [...likeGuests.attempts, ...likeSearch.attempts],
    };

    // Prefer guests/sympathy payload for relation merge when present.
    const likeJsonForRelation =
      extractSympathyUserViewList(likeGuests.primary.json).length > 0
        ? likeGuests.primary.json
        : extractSympathyUserViewList(likeSearch.primary.json).length > 0
          ? likeSearch.primary.json
          : likeGuests.primary.json ?? likeSearch.primary.json;

    const commentList = extractCommentList(commentBff.json);
    const likeList = extractLikeUsers(likeJsonForRelation);
    const mappedComments = mapCommentRows(commentList, sinceMs);
    const mappedLikes = mapLikeRows(likeList, sinceMs);
    const events = [...mappedComments.events, ...mappedLikes.events];

    const windowStats = countRelationWindowFilter({
      comments: commentList,
      likeJson: likeJsonForRelation,
      likeList,
      sinceMs,
    });
    const relations = analyzeBlogRelationsFromInbound({
      commentJson: commentBff.json,
      likeJson: likeJsonForRelation,
      commentList,
      likeList,
      sinceMs,
    });

    const commentApiError = extractCommentApiError(commentBff.json);
    const sympathyList = extractSympathyUserViewList(likeJsonForRelation);
    rqVerbose("[relation_sync][debug]", {
      logNo,
      scannedPostLogNo: logNo,
      commentApiStatus: commentBff.status,
      commentApiOk: commentBff.ok,
      commentJsonParseOk: commentBff.jsonParseOk,
      commentApiErrorCode: commentApiError.errorCode,
      commentApiMessage: commentApiError.message,
      commentListLength: commentList.length,
      sampleProfileUserIds: sampleProfileUserIds(commentList, 3),
      commentObjectId: commentBff.query?.objectId ?? null,
      commentPool: commentBff.query?.pool ?? null,
      sympathyUserViewListLength: sympathyList.length,
      sympathySampleUserIds: sampleSympathyUserIds(likeJsonForRelation, 3),
      commentEventsInWindow: mappedComments.events.length,
      likeEventsInWindow: mappedLikes.events.length,
      commentsFilteredOut: windowStats.commentsFilteredOut,
      likesFilteredOut: windowStats.likesFilteredOut,
      relationUserCount: relations.length,
      usedBrowserCommentboxUrl: Boolean(commentboxUrl),
      cookiePresent: Boolean(cookie.trim()),
      commentBodySnippet: commentBff.bodySnippet?.slice(0, 240) ?? null,
      guestsUrl: likeGuests.primary.url,
      likeSearchUrl: likeSearch.primary.url,
    });

    const relationSummary = summarizeBlogRelations(relations);
    for (const r of relationSummary.sorted) {
      rqVerbose("[reply_queue][relation]", {
        userId: r.userId,
        hasComment: r.hasComment,
        hasLike: r.hasLike,
        relationType: r.relationType,
        commentCount: r.commentCount,
        likeCount: r.likeCount,
        relationScore: r.relationScore,
        activityClass: r.activityClass,
        activityClassLabel: r.activityClassLabel,
        isInteractionUser: r.isInteractionUser,
      });
    }
    rqVerbose("[reply_queue][relation][summary]", {
      logNo,
      total: relationSummary.total,
      commentOnly: relationSummary.commentOnly,
      likeOnly: relationSummary.likeOnly,
      interaction: relationSummary.interaction,
      byRelationType: {
        BOTH_NEIGHBOR: relationSummary.byRelationType.BOTH_NEIGHBOR,
        NEIGHBOR: relationSummary.byRelationType.NEIGHBOR,
        LOGIN_USER: relationSummary.byRelationType.LOGIN_USER,
      },
    });

    const sample = (commentList[0] ?? null) as Record<string, unknown> | null;
    const sampleBlogId = sample
      ? String(
          sample.profileUserId ??
            sample.profile_user_id ??
            sample.userId ??
            sample.user_id ??
            sample.maskedUserId ??
            sample.blogId ??
            "",
        ).trim() || null
      : null;
    const sampleNickname = sample
      ? String(
          sample.userName ??
            sample.user_name ??
            sample.nickname ??
            sample.writer ??
            "",
        ).trim() || null
      : null;
    const sampleMs = sample
      ? parseActivityMs(
          sample.modTime ??
            sample.modTimeInMilli ??
            sample.regTime ??
            sample.regTimeInMilli ??
            sample.date,
        )
      : null;
    const sampleCreatedAt =
      sampleMs != null ? new Date(sampleMs).toISOString() : null;

    rqVerbose("[reply_queue][comment-investigate]", {
      logNo,
      "1_httpStatus": commentBff.status,
      "2_responseBody": commentBff.bodySnippet?.slice(0, 500) ?? null,
      "3_jsonParseOk": commentBff.jsonParseOk,
      "4_commentsLength": commentList.length,
      "5_sample": sample,
      "6_blogId": sampleBlogId,
      "7_nickname": sampleNickname,
      "8_createdAt": sampleCreatedAt,
      "9_within3Days": sampleMs != null ? sampleMs >= sinceMs : null,
      includedInWindowCount: mappedComments.includedInWindowCount,
      fetchError: commentBff.error,
      via: "bff:/api/naver/blog/comments",
    });

    const apiCalls: InboundApiCallProbe[] = [
      {
        kind: "comment",
        url: commentBff.url,
        method: commentBff.method || "GET",
        query: commentBff.query ?? {},
        headers: commentBff.requestHeaders ?? {},
        cookie: commentBff.cookie || cookie,
        referer: commentBff.referer || referer,
        status: commentBff.status,
        ok: commentBff.ok,
        responseSnippet: commentBff.bodySnippet?.slice(0, 800) ?? null,
        error: commentBff.error,
      },
    ];
    if (likeBff.attempts && likeBff.attempts.length > 0) {
      for (const attempt of likeBff.attempts) {
        apiCalls.push({
          kind: "like",
          url: attempt.url,
          method: "GET",
          query: {},
          headers: likeBff.requestHeaders ?? {},
          cookie: likeBff.cookie || cookie,
          referer: likeBff.referer || referer,
          status: attempt.status,
          ok: attempt.ok,
          responseSnippet: attempt.bodySnippet?.slice(0, 800) ?? null,
          error: attempt.error,
        });
      }
    } else {
      apiCalls.push({
        kind: "like",
        url: likeBff.url,
        method: likeBff.method || "GET",
        query: likeBff.query ?? {},
        headers: likeBff.requestHeaders ?? {},
        cookie: likeBff.cookie || cookie,
        referer: likeBff.referer || referer,
        status: likeBff.status,
        ok: likeBff.ok,
        responseSnippet: likeBff.bodySnippet?.slice(0, 800) ?? null,
        error: likeBff.error,
      });
    }

    for (const call of apiCalls) {
      rqVerbose("[reply_queue][api-call]", {
        kind: call.kind,
        url: call.url,
        method: call.method,
        query: call.query,
        headers: call.headers,
        cookie: call.cookie,
        referer: call.referer,
        status: call.status,
        ok: call.ok,
        responseSnippet: call.responseSnippet,
        error: call.error,
      });
    }

    const codeUrls = apiCalls.map((c) => c.url);
    const browserUrls = [
      ...new Set(browserNetwork.map((n) => n.url.split("?")[0] ?? n.url)),
    ];
    const codeUrlBases = [
      ...new Set(codeUrls.map((u) => u.split("?")[0] ?? u)),
    ];
    rqVerbose("[reply_queue][browser-network]", {
      logNo,
      pageUrl,
      count: browserNetwork.length,
      requests: browserNetwork.slice(0, 30),
    });
    rqVerbose("[reply_queue][api-compare]", {
      logNo,
      codeCalledUrlBases: codeUrlBases,
      browserObservedUrlBases: browserUrls,
      sameAsBrowser:
        codeUrlBases.length > 0 &&
        codeUrlBases.every((u) =>
          browserUrls.some((b) => b === u || b.includes(u) || u.includes(b)),
        ),
      note:
        "Inbound APIs are fetched via Next.js BFF (/api/naver/blog/*) from Node to avoid browser CORS. Compare BFF upstream URLs with browser-network.",
    });

    const comments = events.filter((e) => e.kind === "comment");
    const likes = events.filter((e) => e.kind === "like");
    rqVerbose("[reply_queue][raw]", {
      logNo,
      comments: comments.length,
      likes: likes.length,
    });
    for (const comment of commentList.slice(0, 5)) {
      rqVerbose("[reply_queue][raw][comment]", JSON.stringify(comment));
    }
    for (const like of likeList.slice(0, 5)) {
      rqVerbose("[reply_queue][raw][like]", JSON.stringify(like));
    }

    rqVerbose("[reply_queue][comment]", {
      logNo,
      commentCount: commentList.length,
    });
    for (const row of mappedComments.rows) {
      rqVerbose("[reply_queue][comment]", {
        blogId: row.blogId,
        nickname: row.nickname,
        createdAt: row.createdAt,
        status: row.windowStatus,
        reason: row.reason,
      });
    }

    rqVerbose("[reply_queue][like]", {
      logNo,
      likeCount: extractLikeCount(likeBff.json),
      likeUserCount: likeList.length,
    });
    for (const row of mappedLikes.rows) {
      rqVerbose("[reply_queue][like]", {
        blogId: row.blogId,
        nickname: row.nickname,
        createdAt: row.createdAt,
        status: row.windowStatus,
        reason: row.reason,
      });
    }

    return { events, relations };
  } finally {
    page.off("request", onRequest);
    page.off("response", onResponse);
  }
}


function aggregateInbound(
  events: RawInboundEvent[],
  neighborBlogMap: Map<string, string>,
  ownBlogId: string,
): Map<string, InboundAgg> {
  const byPerson = new Map<string, InboundAgg>();
  const own = ownBlogId.toLowerCase();

  for (const ev of events) {
    if (!ev.actorBlogId || ev.actorBlogId === own) {
      if (ev.actorBlogId) {
        rqVerbose(`[reply_queue][neighbor] lookup blogId=${ev.actorBlogId}`);
        rqVerbose("[reply_queue][neighbor] SKIPPED (own blog)");
      }
      continue;
    }
    rqVerbose(`[reply_queue][neighbor] lookup blogId=${ev.actorBlogId}`);
    const personId = neighborBlogMap.get(ev.actorBlogId);
    if (!personId) {
      rqVerbose("[reply_queue][neighbor] NOT FOUND");
      continue;
    }
    rqVerbose(`[reply_queue][neighbor] FOUND personId=${personId}`);

    const prev = byPerson.get(personId);
    if (!prev) {
      byPerson.set(personId, {
        personId,
        likeCount: ev.kind === "like" ? 1 : 0,
        commentCount: ev.kind === "comment" ? 1 : 0,
        lastActivityAt: ev.occurredAt,
        relationScore: 0,
        relationType: null,
        isInteraction: false,
      });
      continue;
    }

    if (ev.kind === "like") prev.likeCount += 1;
    else prev.commentCount += 1;
    if (ev.occurredAt > prev.lastActivityAt) {
      prev.lastActivityAt = ev.occurredAt;
    }
  }

  return byPerson;
}

/**
 * Prefer relation-analysis rows (comment/like merge + score) as source of truth.
 * lastActivityAt must come from real interaction time (no now fallback).
 */
function aggregateFromRelations(
  relations: BlogRelationUser[],
  neighborBlogMap: Map<string, string>,
  ownBlogId: string,
): Map<string, InboundAgg> {
  const own = ownBlogId.toLowerCase();
  const byPerson = new Map<string, InboundAgg>();

  for (const rel of relations) {
    const blogId = rel.userId.trim().toLowerCase();
    if (!blogId || blogId === own) continue;
    if (!rel.lastInteractionAt) continue;
    rqVerbose(`[reply_queue][neighbor] lookup blogId=${blogId}`);
    const personId = neighborBlogMap.get(blogId);
    if (!personId) {
      rqVerbose("[reply_queue][neighbor] NOT FOUND");
      continue;
    }
    rqVerbose(`[reply_queue][neighbor] FOUND personId=${personId}`);

    const lastActivityAt = rel.lastInteractionAt;
    const prev = byPerson.get(personId);
    if (!prev) {
      byPerson.set(personId, {
        personId,
        likeCount: rel.likeCount,
        commentCount: rel.commentCount,
        lastActivityAt,
        relationScore: rel.relationScore,
        relationType: rel.relationType,
        isInteraction: rel.isInteractionUser,
      });
      continue;
    }
    prev.likeCount += rel.likeCount;
    prev.commentCount += rel.commentCount;
    prev.isInteraction =
      prev.isInteraction ||
      rel.isInteractionUser ||
      (prev.likeCount > 0 && prev.commentCount > 0);
    if (rel.relationScore > prev.relationScore) {
      prev.relationScore = rel.relationScore;
    }
    if (rel.relationType && !prev.relationType) {
      prev.relationType = rel.relationType;
    }
    if (lastActivityAt > prev.lastActivityAt) {
      prev.lastActivityAt = lastActivityAt;
    }
  }

  for (const agg of byPerson.values()) {
    agg.isInteraction = agg.likeCount > 0 && agg.commentCount > 0;
    const base =
      (agg.commentCount > 0 ? 3 : 0) +
      (agg.likeCount > 0 ? 1 : 0) +
      (String(agg.relationType ?? "").toUpperCase() === "BOTH_NEIGHBOR"
        ? 2
        : 0);
    agg.relationScore = Math.max(agg.relationScore, base);
  }

  return byPerson;
}

async function persistReplyQueue(aggregates: Map<string, InboundAgg>): Promise<void> {
  if (aggregates.size === 0) return;

  rqVerbose(`[reply_queue][upsert] upsert rows = ${aggregates.size}`);
  for (const agg of aggregates.values()) {
    const reason = reasonFromCounts(agg.likeCount, agg.commentCount);
    rqVerbose("[reply_queue][upsert]", {
      personId: agg.personId,
      reason,
      likeCount: agg.likeCount,
      commentCount: agg.commentCount,
      lastActivityAt: agg.lastActivityAt,
      relationScore: agg.relationScore,
      relationType: agg.relationType,
      isInteraction: agg.isInteraction,
    });
  }

  const db = createServiceClient();

  for (const agg of aggregates.values()) {
    const reason = reasonFromCounts(agg.likeCount, agg.commentCount);
    const withRelation = {
      person_id: agg.personId,
      reason,
      like_count: agg.likeCount,
      comment_count: agg.commentCount,
      last_activity_at: agg.lastActivityAt,
      relation_score: agg.relationScore,
      relation_type: agg.relationType,
      is_interaction: agg.isInteraction,
      processed: false,
      processed_at: null,
    };
    let { error } = await db
      .from("reply_queue")
      .upsert(withRelation, { onConflict: "person_id" });

    if (error && /relation_score|relation_type|is_interaction|schema cache/i.test(error.message)) {
      console.warn(
        "[reply_queue] upsert with relation columns failed, legacy fallback",
        error.message,
      );
      const legacy = await db.from("reply_queue").upsert(
        {
          person_id: agg.personId,
          reason,
          like_count: agg.likeCount,
          comment_count: agg.commentCount,
          last_activity_at: agg.lastActivityAt,
          processed: false,
          processed_at: null,
        },
        { onConflict: "person_id" },
      );
      error = legacy.error;
    }

    if (error) {
      throw new Error(`replyQueue.upsert: ${error.message}`);
    }
  }

  rqVerbose("[reply_queue][persist:after]", "upsert success");
}

export type SyncReplyQueueResult = {
  rowsUpserted: number;
  relationUsers: number;
  replyQueueRows: number;
  postsScanned?: number;
  durationMs?: number;
};

async function persistBlogRelations(input: {
  relations: BlogRelationUser[];
  neighborBlogMap: Map<string, string>;
  sinceMs: number;
  analyzedAt: string;
}): Promise<{ upserted: number; skipped: number }> {
  const db = createServiceClient();
  let upserted = 0;
  let skipped = 0;
  const keptBlogIds: string[] = [];

  for (const rel of input.relations) {
    const blogId = rel.userId.trim();
    if (!blogId) {
      skipped += 1;
      continue;
    }
    const lastInteractionAt = rel.lastInteractionAt;
    if (!lastInteractionAt) {
      skipped += 1;
      continue;
    }
    const lastMs = Date.parse(lastInteractionAt);
    if (!Number.isFinite(lastMs) || lastMs < input.sinceMs) {
      skipped += 1;
      continue;
    }

    const blogKey = blogId.toLowerCase();
    const personId = input.neighborBlogMap.get(blogKey) ?? null;

    let latestPostTitle: string | null = null;
    let latestPostUrl: string | null = null;
    try {
      const latest = await fetchNeighborLatestPost(blogId);
      latestPostTitle = latest?.title ?? null;
      latestPostUrl = latest?.postUrl ?? null;
    } catch {
      // RSS optional at sync time
    }

    const row = {
      person_id: personId,
      user_id: blogId,
      blog_id: blogKey,
      nickname: rel.userNickName,
      profile_user_id: blogId,
      has_comment: rel.hasComment,
      comment_count: rel.commentCount,
      has_like: rel.hasLike,
      like_count: rel.likeCount,
      relation_type: rel.relationType,
      activity_class: rel.activityClass,
      relation_score: rel.relationScore,
      last_interaction_at: lastInteractionAt,
      analyzed_at: input.analyzedAt,
      latest_post_title: latestPostTitle,
      latest_post_url: latestPostUrl,
      updated_at: input.analyzedAt,
    };

    const { error } = await db
      .from("blog_relations")
      .upsert(row, { onConflict: "blog_id" });
    if (error) {
      console.warn("[reply_queue][blog_relations] upsert failed", {
        blogId: blogKey,
        error: error.message,
      });
      skipped += 1;
      continue;
    }
    keptBlogIds.push(blogKey);
    upserted += 1;
  }

  // Drop stale / out-of-window rows from prior incorrect syncs.
  const sinceIso = new Date(input.sinceMs).toISOString();
  const { error: delOldErr } = await db
    .from("blog_relations")
    .delete()
    .lt("last_interaction_at", sinceIso);
  if (delOldErr) {
    console.warn(
      "[reply_queue][blog_relations] delete out-of-window failed",
      delOldErr.message,
    );
  }
  if (keptBlogIds.length > 0) {
    const { data: existing } = await db
      .from("blog_relations")
      .select("blog_id");
    const keep = new Set(keptBlogIds);
    const toDelete = (existing ?? [])
      .map((r) => String(r.blog_id ?? "").toLowerCase())
      .filter((id) => id && !keep.has(id));
    if (toDelete.length > 0) {
      const { error: delStaleErr } = await db
        .from("blog_relations")
        .delete()
        .in("blog_id", toDelete);
      if (delStaleErr) {
        console.warn(
          "[reply_queue][blog_relations] delete stale failed",
          delStaleErr.message,
        );
      }
    }
  } else {
    // No valid relations this run → clear table snapshot.
    const { error: clearErr } = await db
      .from("blog_relations")
      .delete()
      .neq("blog_id", "");
    if (clearErr) {
      console.warn(
        "[reply_queue][blog_relations] clear-all failed",
        clearErr.message,
      );
    }
  }

  console.info("[reply_queue][blog_relations] upserted", {
    count: upserted,
    skipped,
  });
  return { upserted, skipped };
}

export async function syncReplyQueueFromInbound(): Promise<SyncReplyQueueResult> {
  const syncStartedAt = Date.now();
  const empty: SyncReplyQueueResult = {
    rowsUpserted: 0,
    relationUsers: 0,
    replyQueueRows: 0,
    postsScanned: 0,
    durationMs: 0,
  };
  const envBlogId = process.env.NAVER_BLOG_ID?.trim() ?? null;
  const ownBlogId = resolveOwnBlogId();
  rqVerbose("[reply_queue][debug] NAVER_BLOG_ID", {
    envRaw: envBlogId,
    resolved: ownBlogId,
  });
  if (!ownBlogId) {
    console.info("[reply_queue] skip sync — NAVER_BLOG_ID not set");
    return { ...empty, durationMs: Date.now() - syncStartedAt };
  }
  console.info("[reply_queue] sync start", { ownBlogId });

  const nowIso = new Date().toISOString();
  const sinceIso = replyWindowStartIso();
  const sinceMs = new Date(sinceIso).getTime();
  rqVerbose("[reply_queue][debug] activityWindow", {
    replyWindowDays: REPLY_WINDOW_DAYS,
    activityCutoffIso: sinceIso,
    activityCutoffMs: sinceMs,
    nowIso,
    nowMs: Date.now(),
    note: "3-day filter applies to comment/like activity time, not post publish date",
  });
  rqVerbose("[reply_queue][debug] rssUrls", replyQueueRssUrls(ownBlogId));

  const posts = await fetchBlogRecentPostsViaRss(
    ownBlogId,
    MAX_OWN_POSTS_TO_SCAN,
  );
  rqVerbose("[reply_queue][debug] rssFetchResult", {
    postCount: posts.length,
    maxOwnPostsToScan: MAX_OWN_POSTS_TO_SCAN,
    postPublishDateIgnored: true,
    samplePosts: posts.slice(0, 3).map((p) => ({
      title: p.title,
      link: p.postUrl,
      publishedAt: p.publishedAt,
    })),
  });

  if (posts.length === 0) {
    await logReplyQueueRssProbe(ownBlogId);
    console.info("[reply_queue] no own posts from RSS — cannot scan inbound activity");
    return {
      ...empty,
      postsScanned: 0,
      durationMs: Date.now() - syncStartedAt,
    };
  }

  const neighborBlogMap = await loadAcceptedNeighborBlogMap();
  if (neighborBlogMap.size === 0) {
    console.info("[reply_queue] no accepted neighbors in DB");
    return {
      ...empty,
      postsScanned: posts.length,
      durationMs: Date.now() - syncStartedAt,
    };
  }

  const session = getNaverBrowserSession();
  const { page, ephemeral } = await session.acquireWorkPage();
  const allEvents: RawInboundEvent[] = [];
  const relationBatches: BlogRelationUser[][] = [];

  // Resolve numeric blogNo once (commentBox objectId = {blogNo}_201_{logNo}).
  let cachedBlogNo: string | null = null;
  try {
    const firstLogNo = posts.find((p) => p.logNo)?.logNo;
    if (firstLogNo) {
      const seedUrl = `https://m.blog.naver.com/${encodeURIComponent(ownBlogId)}/${firstLogNo}`;
      await page.goto(seedUrl, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
      const seedCookie = await collectPageCookieHeader(page);
      const meta = await fetchNaverCommentMeta({
        blogId: ownBlogId,
        logNo: firstLogNo,
        cookie: seedCookie,
        referer: seedUrl,
      });
      cachedBlogNo = meta.blogNo;
      rqVerbose("[relation_sync][debug]", {
        phase: "comment_meta",
        blogNo: cachedBlogNo,
        commentTotalOnSeedPost: meta.totalCount,
      });
    }
  } catch (err) {
    console.warn(
      "[relation_sync] comment meta resolve failed",
      err instanceof Error ? err.message : err,
    );
  }

  try {
    for (const post of posts) {
      const logNo = post.logNo;
      if (!logNo) continue;
      rqVerbose("[reply_queue][scan]", { logNo, title: post.title });
      try {
        const { events, relations } = await fetchInboundFromPost(
          page,
          ownBlogId,
          logNo,
          sinceMs,
          { blogNo: cachedBlogNo },
        );
        if (events.length > 0 || relations.length > 0) {
          rqVerbose("[reply_queue][debug][post-scan]", {
            logNo,
            ownPostTitle: post.title,
            ownPostPublishedAt: post.publishedAt,
            inboundEventsInWindow: events.length,
            relationUsers: relations.length,
          });
        }
        allEvents.push(...events);
        if (relations.length > 0) relationBatches.push(relations);
      } catch (err) {
        console.warn(
          "[reply_queue] post scan failed",
          logNo,
          err instanceof Error ? err.message : err,
        );
      }
    }
  } finally {
    if (ephemeral) {
      try {
        await page.close();
      } catch {
        // ignore
      }
    }
  }

  const mergedRelations = mergeRelationUsersAcrossPosts(relationBatches);
  const relationSummary = summarizeBlogRelations(mergedRelations);
  rqVerbose("[reply_queue][relation][merged-summary]", {
    total: relationSummary.total,
    commentOnly: relationSummary.commentOnly,
    likeOnly: relationSummary.likeOnly,
    interaction: relationSummary.interaction,
    byRelationType: {
      BOTH_NEIGHBOR: relationSummary.byRelationType.BOTH_NEIGHBOR,
      NEIGHBOR: relationSummary.byRelationType.NEIGHBOR,
      LOGIN_USER: relationSummary.byRelationType.LOGIN_USER,
    },
  });
  for (const r of relationSummary.sorted) {
    rqVerbose("[reply_queue][relation]", {
      userId: r.userId,
      hasComment: r.hasComment,
      hasLike: r.hasLike,
      relationType: r.relationType,
      commentCount: r.commentCount,
      likeCount: r.likeCount,
      relationScore: r.relationScore,
    });
  }

  rqVerbose("[relation_sync][debug]", {
    phase: "scan_complete",
    scannedPostCount: posts.length,
    commentEvents: allEvents.filter((e) => e.kind === "comment").length,
    likeEvents: allEvents.filter((e) => e.kind === "like").length,
    relationUsersBeforePersist: mergedRelations.length,
    commentOnly: relationSummary.commentOnly,
    likeOnly: relationSummary.likeOnly,
    interaction: relationSummary.interaction,
    activityCutoffIso: sinceIso,
  });

  const persistResult = await persistBlogRelations({
    relations: mergedRelations,
    neighborBlogMap,
    sinceMs,
    analyzedAt: nowIso,
  });

  rqVerbose("[relation_sync][debug]", {
    phase: "persist_complete",
    scannedPostCount: posts.length,
    commentEvents: allEvents.filter((e) => e.kind === "comment").length,
    likeEvents: allEvents.filter((e) => e.kind === "like").length,
    filteredOutSkippedPersist: persistResult.skipped,
    finalRelationUsers: persistResult.upserted,
  });

  // Ensure reply_visit_tasks for new relations only (never reset completed).
  try {
    const { ensureReplyVisitTasksFromRelations } = await import(
      "@/services/replyVisitTaskService"
    );
    const ensured = await ensureReplyVisitTasksFromRelations();
    rqVerbose("[relation_sync][debug]", {
      phase: "reply_visit_tasks_ensure",
      ...ensured,
    });
  } catch (err) {
    console.warn(
      "[relation_sync] reply_visit_tasks ensure failed",
      err instanceof Error ? err.message : err,
    );
  }

  rqVerbose("[reply_queue][debug] inboundSummary", {
    ownPostsScanned: posts.length,
    inboundEventsInWindow: allEvents.length,
    relationUsers: persistResult.upserted,
    activityCutoffIso: sinceIso,
  });

  const comments = allEvents.filter((e) => e.kind === "comment");
  const likes = allEvents.filter((e) => e.kind === "like");
  rqVerbose("[reply_queue][aggregate:before]", {
    comments: comments.length,
    likes: likes.length,
    relations: mergedRelations.length,
  });

  const aggregatesFromRelations = aggregateFromRelations(
    mergedRelations,
    neighborBlogMap,
    ownBlogId,
  );
  const aggregatesFromEvents = aggregateInbound(
    allEvents,
    neighborBlogMap,
    ownBlogId,
  );
  const aggregates =
    aggregatesFromRelations.size > 0
      ? aggregatesFromRelations
      : aggregatesFromEvents;

  if (aggregatesFromRelations.size > 0) {
    for (const [personId, evAgg] of aggregatesFromEvents) {
      if (aggregates.has(personId)) continue;
      aggregates.set(personId, {
        ...evAgg,
        relationScore:
          (evAgg.commentCount > 0 ? 3 : 0) + (evAgg.likeCount > 0 ? 1 : 0),
        isInteraction: evAgg.likeCount > 0 && evAgg.commentCount > 0,
      });
    }
  }

  const commentAggregatePersons = [...aggregates.values()].filter(
    (a) => a.commentCount > 0,
  ).length;
  rqVerbose("[reply_queue][comment-investigate][aggregate]", {
    "10_commentAggregatePersonCount": commentAggregatePersons,
    totalAggregatePersons: aggregates.size,
  });
  rqVerbose("[reply_queue][aggregate:after]", {
    persons: aggregates.size,
  });
  rqVerbose(`[reply_queue][aggregate] aggregate persons = ${aggregates.size}`);
  for (const agg of aggregates.values()) {
    rqVerbose("[reply_queue][aggregate]", {
      personId: agg.personId,
      likeCount: agg.likeCount,
      commentCount: agg.commentCount,
      lastActivity: agg.lastActivityAt,
      relationScore: agg.relationScore,
      relationType: agg.relationType,
      isInteraction: agg.isInteraction,
    });
  }

  if (aggregates.size === 0) {
    const durationMs = Date.now() - syncStartedAt;
    console.info("[reply_queue] no inbound activity in window", {
      postsScanned: posts.length,
      relationUsers: persistResult.upserted,
      durationMs,
    });
    rqVerbose("[reply_queue][debug] noInboundReason", {
      ownPostsScanned: posts.length,
      inboundEventsInWindow: allEvents.length,
      relationUsers: mergedRelations.length,
      summary:
        allEvents.length === 0 && mergedRelations.length === 0
          ? "No comment/like on your posts within the last 3 days (API returned none in window)"
          : "Inbound events/relations existed but none mapped to accepted neighbors (see neighbor lookup logs)",
    });
    return {
      rowsUpserted: persistResult.upserted,
      relationUsers: persistResult.upserted,
      replyQueueRows: 0,
      postsScanned: posts.length,
      durationMs,
    };
  }

  rqVerbose("[reply_queue][persist:before]", {
    rows: aggregates.size,
  });
  await persistReplyQueue(aggregates);
  const durationMs = Date.now() - syncStartedAt;
  console.info("[reply_queue] sync done", {
    postsScanned: posts.length,
    relationUsers: persistResult.upserted,
    replyQueueRows: aggregates.size,
    activityWindowDays: REPLY_WINDOW_DAYS,
    durationMs,
  });

  return {
    rowsUpserted: Math.max(persistResult.upserted, aggregates.size),
    relationUsers: persistResult.upserted,
    replyQueueRows: aggregates.size,
    postsScanned: posts.length,
    durationMs,
  };
}

async function mapBlogRelationRowsToItems(
  rows: Array<Record<string, unknown>>,
): Promise<TodayReplyQueueItem[]> {
  const db = createServiceClient();
  const repos = createSupervisorRepos(db);
  const items: TodayReplyQueueItem[] = [];

  for (const row of rows) {
    const blogId = String(row.blog_id ?? row.user_id ?? "").trim();
    const personId = row.person_id ? String(row.person_id) : "";
    const likeCount = Number(row.like_count ?? 0) || 0;
    const commentCount = Number(row.comment_count ?? 0) || 0;
    const isInteractionUser =
      row.has_comment === true && row.has_like === true
        ? true
        : String(row.activity_class ?? "") === "interaction" ||
          (likeCount > 0 && commentCount > 0);
    const relationScore = Number(row.relation_score ?? 0) || 0;
    const relationType =
      typeof row.relation_type === "string" && row.relation_type.trim()
        ? row.relation_type.trim()
        : null;
    const reason = reasonFromCounts(likeCount, commentCount);
    const activityClassLabel = replyReasonLabel(
      reason,
      likeCount,
      commentCount,
      isInteractionUser,
    );
    const lastActivityAt = String(
      row.last_interaction_at ?? row.analyzed_at ?? "",
    );

    let blogName =
      (typeof row.nickname === "string" && row.nickname.trim()) || blogId;
    if (personId) {
      const person = await repos.person.getById(personId);
      if (person) blogName = blogNameFromPerson(person);
    }

    items.push({
      id: String(row.id ?? `${blogId}:${personId}`),
      personId,
      blogName,
      reason,
      reasonLabel: activityClassLabel,
      likeCount,
      commentCount,
      lastActivityAt,
      lastActivityLabel: formatReplyActivityRelativeKo(lastActivityAt),
      relationScore,
      relationType,
      isInteractionUser,
      activityClassLabel,
      latestPostTitle:
        typeof row.latest_post_title === "string"
          ? row.latest_post_title
          : null,
      latestPostUrl:
        typeof row.latest_post_url === "string" ? row.latest_post_url : null,
    });
  }

  return items;
}

/**
 * Fast Today read — DB only. Never runs relation analysis / CDP.
 */
export async function listTodayReplyQueue(): Promise<{
  totalCount: number;
  items: TodayReplyQueueItem[];
  lastAnalyzedAt: string | null;
}> {
  const db = createServiceClient();
  const sinceIso = replyWindowStartIso();

  // Prefer blog_relations snapshot (batch-written).
  {
    const { count, error: countError } = await db
      .from("blog_relations")
      .select("id", { count: "exact", head: true })
      .gte("last_interaction_at", sinceIso);
    if (!countError) {
      const { data, error } = await db
        .from("blog_relations")
        .select(
          "id, person_id, user_id, blog_id, nickname, profile_user_id, has_comment, comment_count, has_like, like_count, relation_type, activity_class, relation_score, last_interaction_at, analyzed_at, latest_post_title, latest_post_url",
        )
        .gte("last_interaction_at", sinceIso)
        .order("relation_score", { ascending: false })
        .order("last_interaction_at", { ascending: false })
        .limit(DISPLAY_LIMIT);
      if (!error) {
        const items = await mapBlogRelationRowsToItems(
          (data ?? []) as Array<Record<string, unknown>>,
        );
        let lastAnalyzedAt: string | null = null;
        for (const row of data ?? []) {
          const at = (row as { analyzed_at?: string }).analyzed_at;
          if (typeof at === "string" && (!lastAnalyzedAt || at > lastAnalyzedAt)) {
            lastAnalyzedAt = at;
          }
        }
        return {
          totalCount: count ?? items.length,
          items,
          lastAnalyzedAt,
        };
      }
      console.warn(
        "[reply_queue] blog_relations list failed, falling back to reply_queue",
        error.message,
      );
    } else if (!/schema cache|does not exist|relation/i.test(countError.message)) {
      throw new Error(`replyQueue.count(blog_relations): ${countError.message}`);
    }
  }

  // Legacy fallback: reply_queue only (no sync, no RSS).
  const { count, error: countError } = await db
    .from("reply_queue")
    .select("id", { count: "exact", head: true })
    .eq("processed", false)
    .gte("last_activity_at", sinceIso);
  if (countError) {
    throw new Error(`replyQueue.count: ${countError.message}`);
  }

  const selectWithRelation =
    "id, person_id, reason, like_count, comment_count, last_activity_at, relation_score, relation_type, is_interaction";
  const selectLegacy =
    "id, person_id, reason, like_count, comment_count, last_activity_at";

  let data: Array<Record<string, unknown>> | null = null;
  {
    const res = await db
      .from("reply_queue")
      .select(selectWithRelation)
      .eq("processed", false)
      .gte("last_activity_at", sinceIso)
      .order("relation_score", { ascending: false })
      .order("last_activity_at", { ascending: false })
      .limit(DISPLAY_LIMIT);
    if (res.error) {
      console.warn(
        "[reply_queue] list with relation columns failed, falling back",
        res.error.message,
      );
      const legacy = await db
        .from("reply_queue")
        .select(selectLegacy)
        .eq("processed", false)
        .gte("last_activity_at", sinceIso)
        .order("last_activity_at", { ascending: false })
        .limit(DISPLAY_LIMIT);
      if (legacy.error) {
        throw new Error(`replyQueue.list: ${legacy.error.message}`);
      }
      data = (legacy.data ?? []) as Array<Record<string, unknown>>;
    } else {
      data = (res.data ?? []) as Array<Record<string, unknown>>;
    }
  }

  const items = await mapRowsToItemsLegacy(data ?? []);
  items.sort((a, b) => {
    if (b.relationScore !== a.relationScore) {
      return b.relationScore - a.relationScore;
    }
    return b.lastActivityAt.localeCompare(a.lastActivityAt);
  });
  return { totalCount: count ?? items.length, items, lastAnalyzedAt: null };
}

/** Legacy reply_queue → UI items (no per-row RSS). */
async function mapRowsToItemsLegacy(
  rows: Array<Record<string, unknown>>,
): Promise<TodayReplyQueueItem[]> {
  const db = createServiceClient();
  const repos = createSupervisorRepos(db);
  const items: TodayReplyQueueItem[] = [];

  for (const row of rows) {
    const personId = String(row.person_id ?? "");
    if (!personId) continue;
    const person = await repos.person.getById(personId);
    if (!person) continue;

    const likeCount = Number(row.like_count ?? 0) || 0;
    const commentCount = Number(row.comment_count ?? 0) || 0;
    const reason = String(row.reason ?? "");
    const lastActivityAt = String(row.last_activity_at ?? "");
    const isInteractionUser =
      row.is_interaction === true || (likeCount > 0 && commentCount > 0);
    const relationScore =
      Number(row.relation_score ?? 0) ||
      (commentCount > 0 ? 3 : 0) +
        (likeCount > 0 ? 1 : 0) +
        (String(row.relation_type ?? "").toUpperCase() === "BOTH_NEIGHBOR"
          ? 2
          : 0);
    const relationType =
      typeof row.relation_type === "string" && row.relation_type.trim()
        ? row.relation_type.trim()
        : null;
    const activityClassLabel = replyReasonLabel(
      reason,
      likeCount,
      commentCount,
      isInteractionUser,
    );

    items.push({
      id: String(row.id ?? personId),
      personId,
      blogName: blogNameFromPerson(person),
      reason,
      reasonLabel: activityClassLabel,
      likeCount,
      commentCount,
      lastActivityAt,
      lastActivityLabel: formatReplyActivityRelativeKo(lastActivityAt),
      relationScore,
      relationType,
      isInteractionUser,
      activityClassLabel,
      latestPostTitle: null,
      latestPostUrl: null,
    });
  }

  return items;
}

/**
 * @deprecated Today must not sync. Use listTodayReplyQueue + nightly cron.
 * Kept as list-only alias for callers.
 */
export async function syncAndListTodayReplyQueue(): Promise<{
  totalCount: number;
  items: TodayReplyQueueItem[];
  lastAnalyzedAt: string | null;
}> {
  return listTodayReplyQueue();
}
