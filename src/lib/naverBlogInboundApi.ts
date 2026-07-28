import "server-only";

export type NaverInboundFetchResult = {
  ok: boolean;
  status: number | null;
  url: string;
  method: string;
  query: Record<string, string>;
  requestHeaders: Record<string, string>;
  cookie: string;
  referer: string;
  bodyText: string;
  bodySnippet: string;
  json: unknown | null;
  jsonParseOk: boolean;
  error: string | null;
};

function snippet(text: string, max = 500): string {
  return text.slice(0, max);
}

async function fetchNaverJson(input: {
  url: string;
  query: Record<string, string>;
  cookie: string;
  referer: string;
}): Promise<NaverInboundFetchResult> {
  const requestHeaders: Record<string, string> = {
    Accept: "application/json, text/javascript, */*; q=0.01",
    "User-Agent":
      "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
    Referer: input.referer,
  };
  if (input.cookie.trim()) {
    requestHeaders.Cookie = input.cookie;
  }

  try {
    const res = await fetch(input.url, {
      method: "GET",
      headers: requestHeaders,
      cache: "no-store",
    });
    const bodyText = await res.text();
    const json = parsePossiblyJsonp(bodyText);
    const jsonParseOk = json != null;
    return {
      ok: res.ok,
      status: res.status,
      url: input.url,
      method: "GET",
      query: input.query,
      requestHeaders,
      cookie: input.cookie,
      referer: input.referer,
      bodyText,
      bodySnippet: snippet(bodyText, 500),
      json,
      jsonParseOk,
      error: null,
    };
  } catch (err) {
    return {
      ok: false,
      status: null,
      url: input.url,
      method: "GET",
      query: input.query,
      requestHeaders,
      cookie: input.cookie,
      referer: input.referer,
      bodyText: "",
      bodySnippet: "",
      json: null,
      jsonParseOk: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Parse plain JSON or JSONP (`callback({...});` / `window.__jindo_callback._N({...});`). */
export function parsePossiblyJsonp(body: string): unknown | null {
  let trimmed = body.trim();
  if (!trimmed) return null;
  // Naver often prefixes JSONP with `/**/`
  trimmed = trimmed.replace(/^\/\*\*\/\s*/, "");
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // continue
  }
  const m = /^[\w.$]+\(([\s\S]*)\)\s*;?\s*$/.exec(trimmed);
  if (!m?.[1]) return null;
  try {
    return JSON.parse(m[1]) as unknown;
  } catch {
    return null;
  }
}

export function buildNaverCommentUrl(input: {
  blogId: string;
  logNo: string;
  pageSize?: number;
  /** Numeric blogNo from comments-info (e.g. 73828734). */
  blogNo?: string | number | null;
  /** Full browser-captured commentBox URL (preferred when available). */
  urlOverride?: string | null;
}): { url: string; query: Record<string, string> } {
  if (input.urlOverride && /commentBox\/cbox\/web_naver_list|web_naver_list_json/i.test(input.urlOverride)) {
    try {
      const u = new URL(input.urlOverride);
      const query: Record<string, string> = {};
      u.searchParams.forEach((v, k) => {
        query[k] = v;
      });
      return { url: u.toString(), query };
    } catch {
      // fall through
    }
  }

  const blogNo = input.blogNo != null ? String(input.blogNo).trim() : "";
  // Real mobile commentBox uses `{blogNo}_201_{logNo}` + pool=blogid
  // Legacy `blog_{blogId}_{logNo}` + pool=cbox9 returns error_code 052.
  const objectId = blogNo
    ? `${blogNo}_201_${input.logNo}`
    : `blog_${input.blogId}_${input.logNo}`;
  const query: Record<string, string> = {
    ticket: "blog",
    templateId: "default",
    pool: blogNo ? "blogid" : "cbox9",
    lang: "ko",
    pageType: "more",
    country: "",
    objectId,
    categoryId: "",
    pageSize: String(input.pageSize ?? 100),
    indexSize: "10",
    listType: "OBJECT",
    page: "1",
    initialize: "true",
    followSize: "5",
    userType: "MANAGER",
    useAltSort: "true",
    replyPageSize: "10",
    showReply: "true",
  };
  if (blogNo) query.groupId = blogNo;
  const url = `https://apis.naver.com/commentBox/cbox/web_naver_list_json.json?${new URLSearchParams(query)}`;
  return { url, query };
}

/** Resolve numeric blogNo for commentBox objectId via mobile comments-info. */
export async function fetchNaverCommentMeta(input: {
  blogId: string;
  logNo: string;
  cookie: string;
  referer: string;
}): Promise<{
  blogNo: string | null;
  totalCount: number | null;
  result: NaverInboundFetchResult;
}> {
  const url = `https://m.blog.naver.com/api/blogs/${encodeURIComponent(input.blogId)}/posts/${encodeURIComponent(input.logNo)}/comments-info`;
  const result = await fetchNaverJson({
    url,
    query: {},
    cookie: input.cookie,
    referer: input.referer,
  });
  let blogNo: string | null = null;
  let totalCount: number | null = null;
  if (result.json && typeof result.json === "object") {
    const root = result.json as Record<string, unknown>;
    const res = (root.result ?? root) as Record<string, unknown>;
    if (res.blogNo != null) blogNo = String(res.blogNo).trim() || null;
    if (typeof res.totalCount === "number") totalCount = res.totalCount;
  }
  return { blogNo, totalCount, result };
}

/**
 * Guest/sympathy user list for a post (relation analysis).
 * Separate from like automation click path.
 */
export function buildNaverLikeGuestsUrl(input: {
  blogId: string;
  logNo: string;
  pageSize?: number;
}): { url: string; query: Record<string, string> } {
  const query: Record<string, string> = {
    pageSize: String(input.pageSize ?? 100),
    page: "1",
  };
  const url = `https://apis.naver.com/blogserver/like/v1/search/contents/blogs/${encodeURIComponent(input.blogId)}/posts/${encodeURIComponent(input.logNo)}/guests?${new URLSearchParams(query)}`;
  return { url, query };
}

export function buildNaverLikeItUsersUrl(input: {
  blogId: string;
  logNo: string;
  pageSize?: number;
}): { url: string; query: Record<string, string> } {
  const query: Record<string, string> = {
    pageSize: String(input.pageSize ?? 100),
    page: "1",
  };
  const url = `https://apis.naver.com/blogserver/like/v1/search/contents/blogs/${encodeURIComponent(input.blogId)}/posts/${encodeURIComponent(input.logNo)}/likeItUsers?${new URLSearchParams(query)}`;
  return { url, query };
}

/**
 * Mobile Naver like search (blogfe) — matches browser Network:
 * /blogfe/like/v1/search/contents?pool=blogid&q=blog[{blogId}_{logNo}_...]&callback=...&suppress_response_codes=true
 */
export function buildNaverBlogfeLikeUrl(input: {
  blogId: string;
  logNo: string;
  /** Full `q` from browser Network when available (includes optional hash suffix). */
  q?: string | null;
  callback?: string | null;
}): { url: string; query: Record<string, string> } {
  const q =
    (input.q && input.q.trim()) ||
    `blog[${input.blogId}_${input.logNo}]`;
  const callback =
    (input.callback && input.callback.trim()) ||
    `window.__jindo_callback._${Date.now() % 100_000}`;
  const query: Record<string, string> = {
    pool: "blogid",
    q,
    isDuplication: "false",
    callback,
    suppress_response_codes: "true",
  };
  const url = `https://apis.naver.com/blogfe/like/v1/search/contents?${new URLSearchParams(query)}`;
  return { url, query };
}

/** PC-style fallback also seen in browser Network. */
export function buildNaverBlogserverLikeSearchUrl(input: {
  blogId: string;
  logNo: string;
}): { url: string; query: Record<string, string> } {
  const query: Record<string, string> = {
    suppress_response_codes: "true",
    pool: "blogid",
    callback: `jQuery${Date.now()}`,
    q: `BLOG[${input.blogId}_${input.logNo}]`,
    isDuplication: "false",
    cssIds: "MULTI_PC,BLOG_PC",
    displayId: "BLOG",
    _: String(Date.now()),
  };
  const url = `https://apis.naver.com/blogserver/like/v1/search/contents?${new URLSearchParams(query)}`;
  return { url, query };
}

export async function fetchNaverBlogComments(input: {
  blogId: string;
  logNo: string;
  cookie: string;
  referer: string;
  pageSize?: number;
  urlOverride?: string | null;
  blogNo?: string | number | null;
}): Promise<NaverInboundFetchResult> {
  let blogNo = input.blogNo ?? null;
  if (!input.urlOverride && blogNo == null) {
    const meta = await fetchNaverCommentMeta({
      blogId: input.blogId,
      logNo: input.logNo,
      cookie: input.cookie,
      referer: input.referer,
    });
    blogNo = meta.blogNo;
  }
  const built = buildNaverCommentUrl({
    ...input,
    blogNo,
  });
  return fetchNaverJson({
    url: built.url,
    query: built.query,
    cookie: input.cookie,
    referer: input.referer,
  });
}

/** Fetch sympathy/guest likers for relation analysis (not like-click automation). */
export async function fetchNaverBlogLikeGuests(input: {
  blogId: string;
  logNo: string;
  cookie: string;
  referer: string;
  pageSize?: number;
}): Promise<{
  primary: NaverInboundFetchResult;
  attempts: NaverInboundFetchResult[];
}> {
  const attempts: NaverInboundFetchResult[] = [];
  for (const built of [
    buildNaverLikeGuestsUrl(input),
    buildNaverLikeItUsersUrl(input),
  ]) {
    const result = await fetchNaverJson({
      url: built.url,
      query: built.query,
      cookie: input.cookie,
      referer: input.referer,
    });
    attempts.push(result);
    if (result.ok && result.jsonParseOk) {
      const list =
        result.json && typeof result.json === "object"
          ? ((result.json as Record<string, unknown>).result as
              | Record<string, unknown>
              | undefined)?.sympathyUserViewList ??
            (result.json as Record<string, unknown>).sympathyUserViewList ??
            (result.json as Record<string, unknown>).contents ??
            (result.json as Record<string, unknown>).guests ??
            null
          : null;
      if (Array.isArray(list) && list.length > 0) {
        return { primary: result, attempts };
      }
    }
  }
  return {
    primary: attempts[0] ?? {
      ok: false,
      status: null,
      url: "",
      method: "GET",
      query: {},
      requestHeaders: {},
      cookie: input.cookie,
      referer: input.referer,
      bodyText: "",
      bodySnippet: "",
      json: null,
      jsonParseOk: false,
      error: "no guests endpoints attempted",
    },
    attempts,
  };
}

export async function fetchNaverBlogLikes(input: {
  blogId: string;
  logNo: string;
  cookie: string;
  referer: string;
  pageSize?: number;
  /** Browser-captured `q` (e.g. blog[id_logNo_hash]). */
  q?: string | null;
  callback?: string | null;
}): Promise<{
  primary: NaverInboundFetchResult;
  attempts: NaverInboundFetchResult[];
}> {
  const attempts: NaverInboundFetchResult[] = [];
  const candidates = [
    buildNaverBlogfeLikeUrl({
      blogId: input.blogId,
      logNo: input.logNo,
      q: input.q,
      callback: input.callback,
    }),
    // If browser q missing, also try bare blog[id_logNo] already covered above.
    // PC blogserver search/contents as secondary.
    buildNaverBlogserverLikeSearchUrl({
      blogId: input.blogId,
      logNo: input.logNo,
    }),
  ];

  // Deduplicate identical URLs
  const seen = new Set<string>();
  for (const built of candidates) {
    if (seen.has(built.url)) continue;
    seen.add(built.url);
    const result = await fetchNaverJson({
      url: built.url,
      query: built.query,
      cookie: input.cookie,
      referer: input.referer,
    });
    // Attach normalized likes for downstream parsers
    if (result.jsonParseOk) {
      result.json = normalizeLikeSearchPayload(result.json);
    }
    attempts.push(result);
    if (result.ok && result.jsonParseOk) {
      return { primary: result, attempts };
    }
  }

  return {
    primary: attempts[attempts.length - 1] ?? {
      ok: false,
      status: null,
      url: candidates[0]?.url ?? "",
      method: "GET",
      query: candidates[0]?.query ?? {},
      requestHeaders: {},
      cookie: input.cookie,
      referer: input.referer,
      bodyText: "",
      bodySnippet: "",
      json: null,
      jsonParseOk: false,
      error: "no like endpoints attempted",
    },
    attempts,
  };
}

export function extractCommentList(json: unknown): unknown[] {
  if (!json || typeof json !== "object") return [];
  const rec = json as Record<string, unknown>;
  const result = (rec.result ?? {}) as Record<string, unknown>;
  const list = result.commentList ?? result.comments ?? rec.commentList ?? [];
  return Array.isArray(list) ? list : [];
}

/** Surface Naver commentbox error payload when list is empty. */
export function extractCommentApiError(json: unknown): {
  errorCode: string | null;
  message: string | null;
  success: boolean | null;
} {
  if (!json || typeof json !== "object") {
    return { errorCode: null, message: null, success: null };
  }
  const rec = json as Record<string, unknown>;
  return {
    errorCode:
      rec.error_code != null
        ? String(rec.error_code)
        : rec.code != null
          ? String(rec.code)
          : null,
    message: rec.message != null ? String(rec.message) : null,
    success: typeof rec.success === "boolean" ? rec.success : null,
  };
}

/**
 * Sum `contents[].reactions[].count` where reactionType === "like"
 * (blogfe / blogserver search/contents shape).
 */
export function extractLikeCountFromReactions(json: unknown): number {
  if (!json || typeof json !== "object") return 0;
  const rec = json as Record<string, unknown>;
  if (typeof rec.likeCount === "number" && Number.isFinite(rec.likeCount)) {
    return Math.max(0, Math.floor(rec.likeCount));
  }
  const contents = Array.isArray(rec.contents)
    ? rec.contents
    : Array.isArray((rec.result as Record<string, unknown> | undefined)?.contents)
      ? ((rec.result as Record<string, unknown>).contents as unknown[])
      : [];
  let total = 0;
  for (const item of contents) {
    if (!item || typeof item !== "object") continue;
    const reactions = (item as Record<string, unknown>).reactions;
    if (!Array.isArray(reactions)) continue;
    for (const reaction of reactions) {
      if (!reaction || typeof reaction !== "object") continue;
      const r = reaction as Record<string, unknown>;
      const type = String(r.reactionType ?? r.type ?? "").toLowerCase();
      if (type !== "like") continue;
      const count = Number(r.count ?? 0);
      if (Number.isFinite(count) && count > 0) total += Math.floor(count);
    }
  }
  return total;
}

/**
 * Normalize blogfe/blogserver like search payloads.
 * - Preserves original `contents` (reaction counts live there).
 * - Flattens actor objects into `users` / `guests` when present.
 * - Adds `likeCount` from contents[].reactions[].count (reactionType=like).
 */
export function normalizeLikeSearchPayload(json: unknown): unknown {
  if (!json || typeof json !== "object") return json;
  const rec = json as Record<string, unknown>;
  const users = collectLikeActors(json);
  const likeCount = extractLikeCountFromReactions(json);
  const originalContents = Array.isArray(rec.contents) ? rec.contents : [];
  return {
    ...rec,
    likeCount,
    contents: originalContents,
    users,
    guests: users,
    __normalizedLikeUsers: true,
    __normalizedLikeUserCount: users.length,
  };
}

function collectLikeActors(json: unknown): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();

  const pushActor = (raw: Record<string, unknown>) => {
    const blogId = String(
      raw.blogId ??
        raw.blog_id ??
        raw.maskedId ??
        raw.userId ??
        raw.id ??
        raw.memberId ??
        "",
    ).trim();
    if (!blogId || seen.has(blogId.toLowerCase())) return;
    seen.add(blogId.toLowerCase());
    out.push({
      ...raw,
      blogId,
      blog_id: blogId,
      userId: String(raw.userId ?? blogId),
      nickname:
        raw.nickname ??
        raw.nickName ??
        raw.userNickName ??
        raw.userName ??
        raw.name ??
        raw.displayName ??
        null,
      userNickName:
        raw.userNickName ?? raw.nickname ?? raw.nickName ?? raw.userName ?? null,
      relationType: raw.relationType ?? raw.relation_type ?? null,
      reactionType: raw.reactionType ?? raw.reaction_type ?? null,
      createdAt:
        raw.createdAt ??
        raw.created_at ??
        raw.likeTime ??
        raw.likeTimeInMilli ??
        raw.date ??
        raw.reactionTime ??
        null,
    });
  };

  // Prefer explicit sympathy user list (relation / guest UI payload).
  const root = json as Record<string, unknown>;
  const result = (root.result ?? {}) as Record<string, unknown>;
  const sympathyList =
    result.sympathyUserViewList ?? root.sympathyUserViewList ?? null;
  if (Array.isArray(sympathyList)) {
    for (const item of sympathyList) {
      if (item && typeof item === "object") {
        pushActor(item as Record<string, unknown>);
      }
    }
  }

  const walk = (node: unknown, depth: number) => {
    if (depth > 6 || node == null) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (typeof node !== "object") return;
    const rec = node as Record<string, unknown>;
    const looksLikeActor =
      typeof rec.blogId === "string" ||
      typeof rec.blog_id === "string" ||
      typeof rec.maskedId === "string" ||
      (typeof rec.userId === "string" &&
        (rec.nickname != null ||
          rec.nickName != null ||
          rec.userNickName != null ||
          rec.relationType != null ||
          rec.reactionType != null));
    if (looksLikeActor) pushActor(rec);

    for (const key of [
      "contents",
      "users",
      "guests",
      "reactions",
      "reactionList",
      "likeItUsers",
      "sympathyUserViewList",
      "result",
      "data",
      "items",
    ]) {
      if (key in rec) walk(rec[key], depth + 1);
    }
  };

  // Only deep-walk when sympathy list was absent (count-only blogfe payloads, etc.).
  if (!Array.isArray(sympathyList) || sympathyList.length === 0) {
    walk(json, 0);
  }
  return out;
}

export function extractLikeUsers(json: unknown): unknown[] {
  if (!json || typeof json !== "object") return [];
  const rec = json as Record<string, unknown>;
  const result = (rec.result ?? {}) as Record<string, unknown>;
  // Relation payloads: prefer sympathyUserViewList (never use for comments).
  const sympathy =
    result.sympathyUserViewList ?? rec.sympathyUserViewList ?? null;
  if (Array.isArray(sympathy) && sympathy.length > 0) {
    return sympathy;
  }
  if (rec.__normalizedLikeUsers === true) {
    if (Array.isArray(rec.users) && rec.users.length > 0) return rec.users;
    if (Array.isArray(rec.guests) && rec.guests.length > 0) return rec.guests;
  }
  const normalized = normalizeLikeSearchPayload(json) as Record<string, unknown>;
  if (Array.isArray(normalized.users) && normalized.users.length > 0) {
    return normalized.users;
  }
  if (Array.isArray(normalized.guests) && normalized.guests.length > 0) {
    return normalized.guests;
  }
  const list = rec.guests ?? rec.users ?? result.guests ?? result.users ?? [];
  return Array.isArray(list) ? list : [];
}

export function extractLikeCount(json: unknown): number {
  if (!json || typeof json !== "object") return 0;
  const rec = json as Record<string, unknown>;
  if (typeof rec.likeCount === "number" && Number.isFinite(rec.likeCount)) {
    return Math.max(0, Math.floor(rec.likeCount));
  }
  return extractLikeCountFromReactions(json);
}
