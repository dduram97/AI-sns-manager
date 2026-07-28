/**
 * Naver blog inbound relation analysis (parse / merge / score only).
 * Does not touch like/comment automation or outbound adapters.
 *
 * Comment authors → comment object `profileUserId`
 * Like users → `result.sympathyUserViewList[].userId`
 * Never derive comment authors from sympathyUserViewList.
 */

export type NaverSympathyUser = {
  userId: string;
  userNickName: string | null;
  userBlogName: string | null;
  relationType: string | null;
  reactionType: string | null;
  raw: Record<string, unknown>;
};

export type NaverCommentAuthor = {
  userId: string;
  userName: string | null;
  commentCount: number;
  commentNos: string[];
};

/** Activity bucket for UI / logs (mutually exclusive). */
export type BlogRelationActivityClass =
  | "interaction" // hasComment && hasLike → 교류 사용자
  | "comment_only"
  | "like_only";

export type BlogRelationTypeKey =
  | "BOTH_NEIGHBOR"
  | "NEIGHBOR"
  | "LOGIN_USER"
  | "OTHER"
  | "UNKNOWN";

export type BlogRelationUser = {
  userId: string;
  hasComment: boolean;
  hasLike: boolean;
  relationType: string | null;
  commentCount: number;
  likeCount: number;
  relationScore: number;
  userNickName: string | null;
  userBlogName: string | null;
  /** hasComment && hasLike */
  isInteractionUser: boolean;
  activityClass: BlogRelationActivityClass;
  activityClassLabel: string;
  /** ISO timestamp of latest in-window comment/like. Required for persist. */
  lastInteractionAt: string | null;
};

export type BlogRelationSummary = {
  total: number;
  commentOnly: number;
  likeOnly: number;
  interaction: number;
  byRelationType: Record<BlogRelationTypeKey, number>;
  sorted: BlogRelationUser[];
};

export const RELATION_SCORE = {
  comment: 3,
  like: 1,
  bothNeighbor: 2,
} as const;

export const ACTIVITY_CLASS_LABEL: Record<BlogRelationActivityClass, string> = {
  interaction: "교류 사용자",
  comment_only: "댓글",
  like_only: "공감",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeUserId(value: unknown): string {
  return String(value ?? "").trim();
}

/** Score: comment +3, like +1, BOTH_NEIGHBOR +2 (e.g. all three → 6). */
export function computeRelationScore(input: {
  hasComment: boolean;
  hasLike: boolean;
  relationType?: string | null;
}): number {
  let score = 0;
  if (input.hasComment) score += RELATION_SCORE.comment;
  if (input.hasLike) score += RELATION_SCORE.like;
  if (String(input.relationType ?? "").toUpperCase() === "BOTH_NEIGHBOR") {
    score += RELATION_SCORE.bothNeighbor;
  }
  return score;
}

export function classifyRelationActivity(input: {
  hasComment: boolean;
  hasLike: boolean;
}): {
  isInteractionUser: boolean;
  activityClass: BlogRelationActivityClass;
  activityClassLabel: string;
} {
  if (input.hasComment && input.hasLike) {
    return {
      isInteractionUser: true,
      activityClass: "interaction",
      activityClassLabel: ACTIVITY_CLASS_LABEL.interaction,
    };
  }
  if (input.hasComment) {
    return {
      isInteractionUser: false,
      activityClass: "comment_only",
      activityClassLabel: ACTIVITY_CLASS_LABEL.comment_only,
    };
  }
  return {
    isInteractionUser: false,
    activityClass: "like_only",
    activityClassLabel: ACTIVITY_CLASS_LABEL.like_only,
  };
}

export function normalizeRelationTypeKey(
  relationType: string | null | undefined,
): BlogRelationTypeKey {
  const key = String(relationType ?? "").trim().toUpperCase();
  if (key === "BOTH_NEIGHBOR") return "BOTH_NEIGHBOR";
  if (key === "NEIGHBOR") return "NEIGHBOR";
  if (key === "LOGIN_USER") return "LOGIN_USER";
  if (!key) return "UNKNOWN";
  return "OTHER";
}

function decorateRelationUser(
  row: Omit<
    BlogRelationUser,
    | "isInteractionUser"
    | "activityClass"
    | "activityClassLabel"
    | "relationScore"
  > & { relationScore?: number },
): BlogRelationUser {
  const cls = classifyRelationActivity(row);
  return {
    ...row,
    lastInteractionAt: row.lastInteractionAt ?? null,
    relationScore:
      row.relationScore ??
      computeRelationScore({
        hasComment: row.hasComment,
        hasLike: row.hasLike,
        relationType: row.relationType,
      }),
    ...cls,
  };
}

/** Sort by relationScore desc (stable by userId). */
export function sortRelationsByScore(
  users: BlogRelationUser[],
): BlogRelationUser[] {
  return [...users].sort((a, b) => {
    if (b.relationScore !== a.relationScore) {
      return b.relationScore - a.relationScore;
    }
    return a.userId.localeCompare(b.userId);
  });
}

/** Aggregate activity + relationType buckets; returns score-sorted list. */
export function summarizeBlogRelations(
  users: BlogRelationUser[],
): BlogRelationSummary {
  const sorted = sortRelationsByScore(users);
  const byRelationType: Record<BlogRelationTypeKey, number> = {
    BOTH_NEIGHBOR: 0,
    NEIGHBOR: 0,
    LOGIN_USER: 0,
    OTHER: 0,
    UNKNOWN: 0,
  };
  let commentOnly = 0;
  let likeOnly = 0;
  let interaction = 0;
  for (const u of sorted) {
    byRelationType[normalizeRelationTypeKey(u.relationType)] += 1;
    if (u.activityClass === "interaction") interaction += 1;
    else if (u.activityClass === "comment_only") commentOnly += 1;
    else likeOnly += 1;
  }
  return {
    total: sorted.length,
    commentOnly,
    likeOnly,
    interaction,
    byRelationType,
    sorted,
  };
}

/** Merge the same user across posts (sum counts, keep best relationType/score). */
export function mergeRelationUsersAcrossPosts(
  batches: BlogRelationUser[][],
): BlogRelationUser[] {
  const byId = new Map<string, BlogRelationUser>();
  for (const batch of batches) {
    for (const u of batch) {
      if (!u.lastInteractionAt) continue;
      const key = u.userId.toLowerCase();
      const prev = byId.get(key);
      if (!prev) {
        byId.set(key, decorateRelationUser({ ...u }));
        continue;
      }
      const lastInteractionAt =
        !prev.lastInteractionAt ||
        u.lastInteractionAt > prev.lastInteractionAt
          ? u.lastInteractionAt
          : prev.lastInteractionAt;
      const merged = decorateRelationUser({
        userId: prev.userId,
        hasComment: prev.hasComment || u.hasComment,
        hasLike: prev.hasLike || u.hasLike,
        relationType: preferRelationType(prev.relationType, u.relationType),
        commentCount: prev.commentCount + u.commentCount,
        likeCount: prev.likeCount + u.likeCount,
        userNickName: prev.userNickName ?? u.userNickName,
        userBlogName: prev.userBlogName ?? u.userBlogName,
        lastInteractionAt,
      });
      byId.set(key, merged);
    }
  }
  return sortRelationsByScore(
    [...byId.values()].filter((r) => Boolean(r.lastInteractionAt)),
  );
}

function preferRelationType(
  a: string | null,
  b: string | null,
): string | null {
  const rank = (t: string | null) => {
    const k = normalizeRelationTypeKey(t);
    if (k === "BOTH_NEIGHBOR") return 3;
    if (k === "NEIGHBOR") return 2;
    if (k === "LOGIN_USER") return 1;
    if (k === "OTHER") return 0;
    return -1;
  };
  return rank(b) > rank(a) ? b : a;
}

/**
 * Extract comment authors from commentbox-style list.
 * Prefer `profileUserId` — do not use sympathyUserViewList.
 */
export function extractCommentAuthorsFromComments(
  comments: unknown[],
): NaverCommentAuthor[] {
  const byId = new Map<string, NaverCommentAuthor>();

  for (const item of comments) {
    const c = asRecord(item);
    if (!c) continue;
    const userId = normalizeUserId(
      c.profileUserId ?? c.profile_user_id ?? c.userId ?? c.user_id,
    );
    if (!userId) continue;
    const key = userId.toLowerCase();
    const commentNo = String(c.commentNo ?? c.comment_no ?? "").trim();
    const userName =
      String(c.userName ?? c.user_name ?? c.nickname ?? "").trim() || null;

    const prev = byId.get(key);
    if (prev) {
      prev.commentCount += 1;
      if (commentNo && !prev.commentNos.includes(commentNo)) {
        prev.commentNos.push(commentNo);
      }
      if (!prev.userName && userName) prev.userName = userName;
      continue;
    }
    byId.set(key, {
      userId,
      userName,
      commentCount: 1,
      commentNos: commentNo ? [commentNo] : [],
    });
  }

  return [...byId.values()];
}

/** Pull `result.sympathyUserViewList` (or top-level) from a like/sympathy JSON payload. */
export function extractSympathyUserViewList(json: unknown): unknown[] {
  const root = asRecord(json);
  if (!root) return [];
  const result = asRecord(root.result) ?? {};
  const list =
    result.sympathyUserViewList ??
    root.sympathyUserViewList ??
    result.sympathyUsers ??
    [];
  return Array.isArray(list) ? list : [];
}

/** Extract like/sympathy users from sympathyUserViewList. */
export function extractSympathyUsers(
  json: unknown,
): NaverSympathyUser[] {
  const out: NaverSympathyUser[] = [];
  const seen = new Set<string>();

  for (const item of extractSympathyUserViewList(json)) {
    const raw = asRecord(item);
    if (!raw) continue;
    const userId = normalizeUserId(raw.userId ?? raw.user_id ?? raw.blogId);
    if (!userId) continue;
    const key = userId.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      userId,
      userNickName:
        String(raw.userNickName ?? raw.userNickname ?? raw.nickname ?? "").trim() ||
        null,
      userBlogName:
        String(raw.userBlogName ?? raw.blogName ?? "").trim() || null,
      relationType:
        String(raw.relationType ?? raw.relation_type ?? "").trim() || null,
      reactionType:
        String(raw.reactionType ?? raw.reaction_type ?? "").trim() || null,
      raw,
    });
  }

  return out;
}

/** Parse comment/like activity time to epoch ms. */
export function parseRelationActivityMs(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw > 1e12 ? raw : raw * 1000;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (/^\d+$/.test(trimmed)) {
      const n = Number(trimmed);
      if (!Number.isFinite(n)) return null;
      return n > 1e12 ? n : n * 1000;
    }
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

function commentActivityMs(item: Record<string, unknown>): number | null {
  return parseRelationActivityMs(
    item.modTime ??
      item.modTimeInMilli ??
      item.regTime ??
      item.regTimeInMilli ??
      item.createdAt ??
      item.created_at ??
      item.date,
  );
}

function likeActivityMs(item: Record<string, unknown>): number | null {
  return parseRelationActivityMs(
    item.createdAt ??
      item.created_at ??
      item.likeTime ??
      item.likeTimeInMilli ??
      item.reactionTime ??
      item.date ??
      item.modTime ??
      item.regTime,
  );
}

export type RelationWindowFilterStats = {
  commentsRaw: number;
  commentsInWindow: number;
  commentsFilteredOut: number;
  likesRaw: number;
  likesInWindow: number;
  likesFilteredOut: number;
};

/**
 * Merge comment authors + sympathy users by userId into relation rows with scores.
 * When `sinceMs` is set, only interactions at/after that time are included.
 * Rows without a parseable activity timestamp are excluded.
 */
export function mergeBlogRelations(input: {
  comments: unknown[];
  /** Full like/sympathy JSON (or already a sympathyUserViewList array). */
  likeJson: unknown;
  /** Inclusive lower bound (epoch ms). Omit to keep legacy unfiltered merge. */
  sinceMs?: number;
}): BlogRelationUser[] {
  const sinceMs = input.sinceMs;
  const byId = new Map<
    string,
    BlogRelationUser & { _lastMs: number }
  >();

  const ensure = (userId: string) => {
    const key = userId.toLowerCase();
    const existing = byId.get(key);
    if (existing) return existing;
    const row = {
      ...decorateRelationUser({
        userId,
        hasComment: false,
        hasLike: false,
        relationType: null,
        commentCount: 0,
        likeCount: 0,
        userNickName: null,
        userBlogName: null,
        lastInteractionAt: null,
      }),
      _lastMs: 0,
    };
    byId.set(key, row);
    return row;
  };

  const touch = (row: { _lastMs: number; lastInteractionAt: string | null }, ms: number) => {
    if (ms > row._lastMs) {
      row._lastMs = ms;
      row.lastInteractionAt = new Date(ms).toISOString();
    }
  };

  for (const item of input.comments) {
    const c = asRecord(item);
    if (!c) continue;
    const userId = normalizeUserId(
      c.profileUserId ?? c.profile_user_id ?? c.userId ?? c.user_id,
    );
    if (!userId) continue;
    const ms = commentActivityMs(c);
    if (ms == null) continue;
    if (sinceMs != null && ms < sinceMs) continue;
    const row = ensure(userId);
    row.hasComment = true;
    row.commentCount += 1;
    const name =
      String(c.userName ?? c.user_name ?? c.nickname ?? "").trim() || null;
    if (!row.userNickName && name) row.userNickName = name;
    touch(row, ms);
  }

  const sympathyUsers = Array.isArray(input.likeJson)
    ? extractSympathyUsers({ sympathyUserViewList: input.likeJson })
    : extractSympathyUsers(input.likeJson);

  for (const liker of sympathyUsers) {
    const ms = likeActivityMs(liker.raw);
    if (ms == null) continue;
    if (sinceMs != null && ms < sinceMs) continue;
    const row = ensure(liker.userId);
    row.hasLike = true;
    row.likeCount += 1;
    if (liker.relationType) row.relationType = liker.relationType;
    if (!row.userNickName && liker.userNickName) {
      row.userNickName = liker.userNickName;
    }
    if (!row.userBlogName && liker.userBlogName) {
      row.userBlogName = liker.userBlogName;
    }
    touch(row, ms);
  }

  const decorated = [...byId.values()]
    .filter((row) => row.lastInteractionAt != null && row._lastMs > 0)
    .map((row) => {
      const { _lastMs: _, ...rest } = row;
      return decorateRelationUser(rest);
    });

  return sortRelationsByScore(decorated);
}

/** Count raw vs in-window interactions for debug logs. */
export function countRelationWindowFilter(input: {
  comments: unknown[];
  likeJson: unknown;
  likeList?: unknown[];
  sinceMs: number;
}): RelationWindowFilterStats {
  let commentsRaw = 0;
  let commentsInWindow = 0;
  for (const item of input.comments) {
    const c = asRecord(item);
    if (!c) continue;
    const userId = normalizeUserId(
      c.profileUserId ?? c.profile_user_id ?? c.userId ?? c.user_id,
    );
    if (!userId) continue;
    commentsRaw += 1;
    const ms = commentActivityMs(c);
    if (ms != null && ms >= input.sinceMs) commentsInWindow += 1;
  }

  const likeSource = Array.isArray(input.likeJson)
    ? input.likeJson
    : extractSympathyUserViewList(input.likeJson).length > 0
      ? extractSympathyUserViewList(input.likeJson)
      : input.likeList ?? [];
  let likesRaw = 0;
  let likesInWindow = 0;
  for (const item of likeSource) {
    const raw = asRecord(item);
    if (!raw) continue;
    const userId = normalizeUserId(raw.userId ?? raw.user_id ?? raw.blogId);
    if (!userId) continue;
    likesRaw += 1;
    const ms = likeActivityMs(raw);
    if (ms != null && ms >= input.sinceMs) likesInWindow += 1;
  }

  return {
    commentsRaw,
    commentsInWindow,
    commentsFilteredOut: Math.max(0, commentsRaw - commentsInWindow),
    likesRaw,
    likesInWindow,
    likesFilteredOut: Math.max(0, likesRaw - likesInWindow),
  };
}

/** Convenience: comments JSON + likes JSON → relation rows. */
export function analyzeBlogRelationsFromInbound(input: {
  commentJson: unknown;
  likeJson: unknown;
  commentList?: unknown[];
  /** Fallback actor list when sympathyUserViewList is absent. */
  likeList?: unknown[];
  /** Inclusive lower bound (epoch ms) for interaction time filter. */
  sinceMs?: number;
}): BlogRelationUser[] {
  const comments =
    input.commentList ??
    (() => {
      const root = asRecord(input.commentJson);
      if (!root) return [];
      const result = asRecord(root.result) ?? {};
      const list = result.commentList ?? result.comments ?? root.commentList;
      return Array.isArray(list) ? list : [];
    })();

  const fromSympathy = extractSympathyUsers(input.likeJson);
  if (fromSympathy.length > 0) {
    return mergeBlogRelations({
      comments,
      likeJson: input.likeJson,
      sinceMs: input.sinceMs,
    });
  }

  const likeList =
    input.likeList ??
    (() => {
      const root = asRecord(input.likeJson);
      if (!root) return [];
      if (Array.isArray(root.users) && root.users.length > 0) return root.users;
      if (Array.isArray(root.guests) && root.guests.length > 0) return root.guests;
      return [];
    })();

  if (likeList.length === 0) {
    return mergeBlogRelations({
      comments,
      likeJson: input.likeJson,
      sinceMs: input.sinceMs,
    });
  }

  return mergeBlogRelations({
    comments,
    likeJson: { sympathyUserViewList: likeList },
    sinceMs: input.sinceMs,
  });
}
