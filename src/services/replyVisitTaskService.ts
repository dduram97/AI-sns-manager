/**
 * Reply-visit workflow tasks — status separate from blog_relations snapshot.
 * completed is never reset to pending on sync.
 */

import "server-only";

import { createServiceClient } from "@/lib/supabase";
import { createSupervisorRepos } from "@/repositories/index";
import { blogNameFromPerson } from "@/services/todayDashboard/todayDashboardShared";

export type ReplyVisitTaskStatus = "pending" | "completed" | "snoozed";

export type ReplyVisitCommentDraftUiStatus = "none" | "draft" | "executed";

export type ReplyVisitTaskItem = {
  id: string;
  relationId: string | null;
  personId: string;
  blogId: string;
  blogName: string;
  profileUrl: string;
  status: ReplyVisitTaskStatus;
  hasComment: boolean;
  hasLike: boolean;
  commentCount: number;
  likeCount: number;
  relationScore: number;
  activityClassLabel: string;
  lastActivityAt: string;
  lastActivityLabel: string;
  latestPostTitle: string | null;
  latestPostUrl: string | null;
  snoozedUntil: string | null;
  completedAt: string | null;
  /**
   * Comment assist status from reply_comment_drafts:
   * none | draft (검수 대기) | executed (등록 완료)
   */
  commentDraftStatus: ReplyVisitCommentDraftUiStatus;
  /** @deprecated use commentDraftStatus === "draft" */
  hasCommentDraft: boolean;
};

export type ReplyVisitSummary = {
  completed: number;
  total: number;
  pending: number;
  lastAnalyzedAt: string | null;
};

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const REPLY_WINDOW_DAYS = 3;

function replyWindowStartIso(now = Date.now()): string {
  const kst = new Date(now + KST_OFFSET_MS);
  const startOfTodayKstUtc =
    Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate()) -
    KST_OFFSET_MS;
  return new Date(
    startOfTodayKstUtc - REPLY_WINDOW_DAYS * 86_400_000,
  ).toISOString();
}

/** Next calendar day 00:00 KST as UTC ISO. */
export function nextKstMidnightIso(now = Date.now()): string {
  const kst = new Date(now + KST_OFFSET_MS);
  const nextDayStartUtc =
    Date.UTC(
      kst.getUTCFullYear(),
      kst.getUTCMonth(),
      kst.getUTCDate() + 1,
    ) - KST_OFFSET_MS;
  return new Date(nextDayStartUtc).toISOString();
}

function formatActivityRelativeKo(iso: string): string {
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

function activityClassLabel(
  hasComment: boolean,
  hasLike: boolean,
  likeCount: number,
  commentCount: number,
): string {
  if (hasComment && hasLike) return "교류 사용자";
  if (hasComment || commentCount > 0) return "댓글";
  if (hasLike || likeCount > 0) return "공감";
  return "활동";
}

type RelationRow = {
  id: string;
  person_id: string | null;
  user_id: string;
  blog_id: string;
  nickname: string | null;
  has_comment: boolean;
  comment_count: number;
  has_like: boolean;
  like_count: number;
  relation_score: number;
  activity_class: string;
  last_interaction_at: string | null;
  analyzed_at: string;
  latest_post_title: string | null;
  latest_post_url: string | null;
};

type TaskRow = {
  id: string;
  relation_id: string | null;
  person_id: string | null;
  user_id: string;
  blog_id: string;
  status: string;
  completed_at: string | null;
  snoozed_until: string | null;
  updated_at: string;
};

function normalizeBlogId(raw: string): string {
  return raw.trim().toLowerCase();
}

function effectiveStatus(
  task: TaskRow | undefined,
  nowMs = Date.now(),
): ReplyVisitTaskStatus {
  if (!task) return "pending";
  if (task.status === "completed") return "completed";
  if (task.status === "snoozed") {
    const until = task.snoozed_until
      ? Date.parse(task.snoozed_until)
      : Number.NaN;
    if (Number.isFinite(until) && until > nowMs) return "snoozed";
    return "pending";
  }
  return "pending";
}

async function loadActiveRelations(): Promise<RelationRow[]> {
  const db = createServiceClient();
  const sinceIso = replyWindowStartIso();
  const { data, error } = await db
    .from("blog_relations")
    .select(
      "id, person_id, user_id, blog_id, nickname, has_comment, comment_count, has_like, like_count, relation_score, activity_class, last_interaction_at, analyzed_at, latest_post_title, latest_post_url",
    )
    .gte("last_interaction_at", sinceIso)
    .order("relation_score", { ascending: false })
    .order("last_interaction_at", { ascending: false });

  if (error) {
    if (/schema cache|does not exist|relation/i.test(error.message)) {
      return [];
    }
    throw new Error(`replyVisitTasks.relations: ${error.message}`);
  }
  return (data ?? []) as RelationRow[];
}

async function loadTasksByBlogIds(
  blogIds: string[],
): Promise<Map<string, TaskRow>> {
  const map = new Map<string, TaskRow>();
  if (blogIds.length === 0) return map;
  const db = createServiceClient();
  const { data, error } = await db
    .from("reply_visit_tasks")
    .select(
      "id, relation_id, person_id, user_id, blog_id, status, completed_at, snoozed_until, updated_at",
    )
    .in("blog_id", blogIds);

  if (error) {
    if (/schema cache|does not exist|relation/i.test(error.message)) {
      console.warn(
        "[reply_visit_tasks] table missing — run migration 014_reply_visit_tasks.sql",
        error.message,
      );
      return map;
    }
    throw new Error(`replyVisitTasks.load: ${error.message}`);
  }

  for (const row of (data ?? []) as TaskRow[]) {
    map.set(normalizeBlogId(row.blog_id), row);
  }
  return map;
}

/**
 * Upsert pending tasks for new blog_relations only.
 * Never resets completed (or active snoozed) back to pending.
 */
export async function ensureReplyVisitTasksFromRelations(
  relations?: RelationRow[],
): Promise<{ inserted: number; skipped: number; total: number }> {
  const db = createServiceClient();
  const rels = relations ?? (await loadActiveRelations());
  if (rels.length === 0) {
    return { inserted: 0, skipped: 0, total: 0 };
  }

  const blogIds = rels.map((r) => normalizeBlogId(r.blog_id || r.user_id));
  const existing = await loadTasksByBlogIds(blogIds);

  let inserted = 0;
  let skipped = 0;
  const nowIso = new Date().toISOString();

  for (const rel of rels) {
    const blogId = normalizeBlogId(rel.blog_id || rel.user_id);
    if (!blogId) {
      skipped += 1;
      continue;
    }

    const prev = existing.get(blogId);
    if (prev) {
      // Keep completed forever; refresh relation_id / person_id only.
      const patch: Record<string, unknown> = {
        relation_id: rel.id,
        updated_at: nowIso,
      };
      if (rel.person_id) patch.person_id = rel.person_id;
      if (prev.user_id !== (rel.user_id || blogId)) {
        patch.user_id = rel.user_id || blogId;
      }
      // Do NOT touch status / completed_at / snoozed_until.
      const { error } = await db
        .from("reply_visit_tasks")
        .update(patch)
        .eq("id", prev.id);
      if (error) {
        console.warn("[reply_visit_tasks] link update failed", {
          blogId,
          error: error.message,
        });
      }
      skipped += 1;
      continue;
    }

    const row = {
      relation_id: rel.id,
      person_id: rel.person_id,
      user_id: rel.user_id || blogId,
      blog_id: blogId,
      status: "pending" as const,
      completed_at: null,
      snoozed_until: null,
      created_at: nowIso,
      updated_at: nowIso,
    };

    const { error } = await db.from("reply_visit_tasks").insert(row);
    if (error) {
      // Race: another writer inserted — leave existing status alone.
      if (/duplicate|unique/i.test(error.message)) {
        skipped += 1;
        continue;
      }
      console.warn("[reply_visit_tasks] insert failed", {
        blogId,
        error: error.message,
      });
      skipped += 1;
      continue;
    }
    inserted += 1;
  }

  console.info("[reply_visit_tasks] ensure", {
    total: rels.length,
    inserted,
    skipped,
  });
  return { inserted, skipped, total: rels.length };
}

export async function getReplyVisitSummary(): Promise<ReplyVisitSummary> {
  const relations = await loadActiveRelations();
  await ensureReplyVisitTasksFromRelations(relations);

  const blogIds = relations.map((r) =>
    normalizeBlogId(r.blog_id || r.user_id),
  );
  const tasks = await loadTasksByBlogIds(blogIds);
  const nowMs = Date.now();

  let completed = 0;
  let pending = 0;
  for (const blogId of blogIds) {
    const status = effectiveStatus(tasks.get(blogId), nowMs);
    if (status === "completed") completed += 1;
    else if (status === "pending") pending += 1;
    // snoozed counts toward total but not completed/pending active
  }

  let lastAnalyzedAt: string | null = null;
  for (const rel of relations) {
    if (!lastAnalyzedAt || rel.analyzed_at > lastAnalyzedAt) {
      lastAnalyzedAt = rel.analyzed_at;
    }
  }

  return {
    completed,
    total: relations.length,
    pending,
    lastAnalyzedAt,
  };
}

export async function listReplyVisitTasks(options?: {
  includeCompleted?: boolean;
  includeSnoozed?: boolean;
}): Promise<{
  items: ReplyVisitTaskItem[];
  summary: ReplyVisitSummary;
}> {
  const includeCompleted = options?.includeCompleted === true;
  const includeSnoozed = options?.includeSnoozed === true;

  const relations = await loadActiveRelations();
  await ensureReplyVisitTasksFromRelations(relations);

  const blogIds = relations.map((r) =>
    normalizeBlogId(r.blog_id || r.user_id),
  );
  const tasks = await loadTasksByBlogIds(blogIds);
  const nowMs = Date.now();

  const db = createServiceClient();
  const repos = createSupervisorRepos(db);

  let completed = 0;
  let pending = 0;
  let lastAnalyzedAt: string | null = null;
  const items: ReplyVisitTaskItem[] = [];

  for (const rel of relations) {
    if (!lastAnalyzedAt || rel.analyzed_at > lastAnalyzedAt) {
      lastAnalyzedAt = rel.analyzed_at;
    }

    const blogId = normalizeBlogId(rel.blog_id || rel.user_id);
    const task = tasks.get(blogId);
    const status = effectiveStatus(task, nowMs);

    if (status === "completed") completed += 1;
    else if (status === "pending") pending += 1;

    if (status === "completed" && !includeCompleted) continue;
    if (status === "snoozed" && !includeSnoozed) continue;

    const personId = rel.person_id ? String(rel.person_id) : "";
    let blogName =
      (typeof rel.nickname === "string" && rel.nickname.trim()) || blogId;
    if (personId) {
      const person = await repos.person.getById(personId);
      if (person) blogName = blogNameFromPerson(person);
    }

    const likeCount = Number(rel.like_count ?? 0) || 0;
    const commentCount = Number(rel.comment_count ?? 0) || 0;
    const hasComment = rel.has_comment === true || commentCount > 0;
    const hasLike = rel.has_like === true || likeCount > 0;
    const lastActivityAt = String(
      rel.last_interaction_at ?? rel.analyzed_at ?? "",
    );

    items.push({
      id: task?.id ?? rel.id,
      relationId: rel.id,
      personId,
      blogId,
      blogName,
      profileUrl: `https://blog.naver.com/${encodeURIComponent(blogId)}`,
      status,
      hasComment,
      hasLike,
      commentCount,
      likeCount,
      relationScore: Number(rel.relation_score ?? 0) || 0,
      activityClassLabel: activityClassLabel(
        hasComment,
        hasLike,
        likeCount,
        commentCount,
      ),
      lastActivityAt,
      lastActivityLabel: formatActivityRelativeKo(lastActivityAt),
      latestPostTitle: rel.latest_post_title,
      latestPostUrl: rel.latest_post_url,
      snoozedUntil: task?.snoozed_until ?? null,
      completedAt: task?.completed_at ?? null,
      commentDraftStatus: "none",
      hasCommentDraft: false,
    });
  }

  // Attach comment draft statuses (best-effort; table may be missing pre-migration).
  try {
    const { listCommentDraftStatusesByTaskIds } = await import(
      "@/services/replyVisitCommentDraftService"
    );
    const statusMap = await listCommentDraftStatusesByTaskIds(
      items.map((i) => i.id).filter(Boolean),
    );
    for (const item of items) {
      const st = statusMap.get(item.id) ?? "none";
      item.commentDraftStatus = st;
      item.hasCommentDraft = st === "draft";
    }
  } catch {
    // ignore
  }

  return {
    items,
    summary: {
      completed,
      total: relations.length,
      pending,
      lastAnalyzedAt,
    },
  };
}

export async function completeReplyVisitTask(
  taskId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const db = createServiceClient();
  const nowIso = new Date().toISOString();
  const { data, error } = await db
    .from("reply_visit_tasks")
    .update({
      status: "completed",
      completed_at: nowIso,
      snoozed_until: null,
      updated_at: nowIso,
    })
    .eq("id", taskId)
    .select("id")
    .maybeSingle();

  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "task_not_found" };
  return { ok: true };
}

export async function snoozeReplyVisitTask(
  taskId: string,
): Promise<{ ok: true; snoozedUntil: string } | { ok: false; error: string }> {
  const db = createServiceClient();
  const nowIso = new Date().toISOString();
  const snoozedUntil = nextKstMidnightIso();
  const { data, error } = await db
    .from("reply_visit_tasks")
    .update({
      status: "snoozed",
      snoozed_until: snoozedUntil,
      updated_at: nowIso,
    })
    .eq("id", taskId)
    .select("id")
    .maybeSingle();

  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "task_not_found" };
  return { ok: true, snoozedUntil };
}
