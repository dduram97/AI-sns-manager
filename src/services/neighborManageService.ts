import "server-only";

import {
  parseNeighborRelationStatus,
  type NeighborRelationStatus,
} from "@/domain/neighbor/relationStatus";
import { kstTodayYmd, resolveCompletedRange } from "@/lib/completedRange";
import { runWithDbTrace, traceQuery, rowCountFrom } from "@/lib/dbTrace";
import {
  blogUrlFromMeta,
  recentPostTitleFromMeta,
} from "@/services/todayDashboard/todayDashboardShared";
import {
  enrichNeighborManageItem,
  emptyNeighborWeeklyReport,
  formatDaysAgoKo,
  daysSince,
  resolveCareStatus,
  selectMostNeglectedNeighbor,
} from "@/lib/neighborManageListUtils";
import { listNeighborFeedApprovalInbox } from "@/services/approvalService";
import { createServiceClient } from "@/lib/supabase";
import { createSupervisorRepos } from "@/repositories/index";
import {
  mapPerson,
  mapRelationship,
  PERSON_CRM_COLS,
  RELATIONSHIP_COLS,
} from "@/repositories/shared";
import type {
  NeighborManageDetailView,
  NeighborManageListItem,
  NeighborManageListPayload,
  NeighborManageTodayActions,
  NeighborManageWeeklyReport,
} from "@/types/neighborManage";
import type { ActionType, Person, RelationshipState } from "@/workers/types";

const CARE_ACTION_TYPES: ActionType[] = ["visit", "like", "comment"];

function careLabelForActionType(actionType: string): string | null {
  switch (actionType) {
    case "visit":
      return "방문";
    case "like":
      return "공감";
    case "comment":
      return "댓글";
    default:
      return null;
  }
}

function careDoneOnFromMeta(meta: Record<string, unknown>): string | null {
  const raw = meta.neighbor_care_done_on;
  return typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.trim())
    ? raw.trim()
    : null;
}

function careSnoozeOnFromMeta(meta: Record<string, unknown>): string | null {
  const raw = meta.neighbor_care_snooze_on;
  return typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.trim())
    ? raw.trim()
    : null;
}

function careDoneAtFromMeta(meta: Record<string, unknown>): string | null {
  const raw = meta.neighbor_care_done_at;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const t = new Date(raw.trim()).getTime();
  return Number.isNaN(t) ? null : raw.trim();
}

function maxIso(
  a: string | null | undefined,
  b: string | null | undefined,
): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

function displayNeighborName(item: NeighborManageListItem): string {
  return item.blogName ?? item.nickname ?? item.displayName;
}

async function buildWeeklyReport(
  db: ReturnType<typeof createServiceClient>,
  personIds: string[],
  items: NeighborManageListItem[],
): Promise<NeighborManageWeeklyReport> {
  const empty = emptyNeighborWeeklyReport();
  if (personIds.length === 0) return empty;

  const { fromIso, toIso } = resolveCompletedRange({ preset: "7d" });
  const nameById = new Map(
    items.map((i) => [i.personId, displayNeighborName(i)]),
  );

  const perPerson = new Map<
    string,
    { count: number; lastAt: string | null }
  >();
  let visit = 0;
  let like = 0;
  let comment = 0;

  try {
    const { data: jobRows, error: jobError } = await traceQuery(
      "action_jobs.neighbor_care_week",
      () =>
        db
          .from("action_jobs")
          .select("person_id, action_type, executed_at")
          .in("person_id", personIds)
          .in("action_type", CARE_ACTION_TYPES)
          .eq("status", "executed")
          .gte("executed_at", fromIso)
          .lte("executed_at", toIso),
      (r) => rowCountFrom(r.data),
    );
    if (jobError) throw new Error(jobError.message);

    for (const row of jobRows ?? []) {
      const pid = String(row.person_id);
      const actionType = String(row.action_type);
      if (actionType === "visit") visit += 1;
      else if (actionType === "like") like += 1;
      else if (actionType === "comment") comment += 1;
      else continue;

      const executedAt =
        typeof row.executed_at === "string" ? row.executed_at : null;
      const cur = perPerson.get(pid) ?? { count: 0, lastAt: null };
      cur.count += 1;
      cur.lastAt = maxIso(cur.lastAt, executedAt);
      perPerson.set(pid, cur);
    }
  } catch (err) {
    console.warn(
      "[neighbor-manage] weekly action_jobs skipped",
      err instanceof Error ? err.message : err,
    );
    // Still attach neglected from relationship data.
  }

  let recentOrActive: NeighborManageWeeklyReport["recentOrActive"] = null;
  if (perPerson.size > 0) {
    let bestRecent: { id: string; lastAt: string; count: number } | null =
      null;
    let bestActive: { id: string; count: number; lastAt: string | null } | null =
      null;
    for (const [id, stats] of perPerson) {
      if (stats.lastAt) {
        if (
          !bestRecent ||
          new Date(stats.lastAt).getTime() >
            new Date(bestRecent.lastAt).getTime()
        ) {
          bestRecent = { id, lastAt: stats.lastAt, count: stats.count };
        }
      }
      if (!bestActive || stats.count > bestActive.count) {
        bestActive = { id, count: stats.count, lastAt: stats.lastAt };
      }
    }
    const pick = bestRecent ?? bestActive;
    if (pick) {
      const name = nameById.get(pick.id) ?? "이웃";
      const isActiveFocus =
        bestActive &&
        bestActive.id === pick.id &&
        bestActive.count >= 2;
      recentOrActive = {
        personId: pick.id,
        name,
        detail: isActiveFocus
          ? `이번 주 ${bestActive!.count}회 교류`
          : bestRecent
            ? `최근 관리 ${formatDaysAgoKo(daysSince(bestRecent.lastAt))}`
            : `이번 주 ${bestActive!.count}회 교류`,
      };
    }
  }

  const neglectedItem = selectMostNeglectedNeighbor(items);
  const neglected = neglectedItem
    ? {
        personId: neglectedItem.personId,
        name: displayNeighborName(neglectedItem),
        daysSinceTouch: neglectedItem.daysSinceTouch,
      }
    : null;

  return {
    neighborCount: perPerson.size,
    visit,
    like,
    comment,
    recentOrActive,
    neglected,
  };
}


function blogNameFromMeta(meta: Record<string, unknown>): string | null {
  const raw = meta.blog_name ?? meta.blogName;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function nicknameFromMeta(meta: Record<string, unknown>): string | null {
  const raw = meta.nickname;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function lastPostAtFromMeta(meta: Record<string, unknown>): string | null {
  const raw = meta.last_post_at;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function latestInteraction(
  rel: RelationshipState,
): { label: string; at: string | null } {
  const candidates = [
    { label: "댓글", at: rel.last_comment_at },
    { label: "공감", at: rel.last_like_at },
    { label: "방문", at: rel.last_visit_at },
    { label: "교류", at: rel.last_touch_at },
  ].filter((c) => c.at);

  if (candidates.length === 0) {
    return { label: "—", at: null };
  }

  candidates.sort(
    (a, b) => new Date(b.at!).getTime() - new Date(a.at!).getTime(),
  );
  return candidates[0]!;
}

function toListItem(
  person: Person,
  relationship: RelationshipState,
  relationStatus: NeighborRelationStatus,
): NeighborManageListItem {
  const meta = person.discover_meta ?? {};
  const recent = latestInteraction(relationship);

  return enrichNeighborManageItem({
    personId: person.id,
    displayName: person.display_name,
    blogName: blogNameFromMeta(meta),
    nickname: nicknameFromMeta(meta),
    blogUrl: blogUrlFromMeta(meta),
    relationStatus,
    stage: relationship.stage,
    temperature: relationship.temperature,
    score: relationship.score,
    lastVisitAt: relationship.last_visit_at,
    lastLikeAt: relationship.last_like_at,
    lastCommentAt: relationship.last_comment_at,
    lastTouchAt: relationship.last_touch_at,
    lastPostAt: lastPostAtFromMeta(meta),
    lastPostTitle: recentPostTitleFromMeta(meta),
    recentActivityLabel: recent.label,
    recentActivityAt: recent.at,
  });
}

export async function listAcceptedNeighborManageItems(): Promise<
  NeighborManageListPayload
> {
  return runWithDbTrace("neighbor_manage", async () => {
    const emptyActions: NeighborManageTodayActions = {
      visit: 0,
      like: 0,
      comment: 0,
    };
    const db = createServiceClient();
    const { data, error } = await db
      .from("persons")
      .select(PERSON_CRM_COLS)
      .filter("discover_meta->>neighbor_relation_status", "eq", "accepted")
      .order("updated_at", { ascending: false });

    if (error) {
      throw new Error(
        `listAcceptedNeighborManageItems: ${error.message}`,
      );
    }

    const persons = (data ?? []).map((r) =>
      mapPerson(r as Record<string, unknown>),
    );
    if (persons.length === 0) {
      return {
        items: [],
        todayActions: emptyActions,
        weeklyReport: emptyNeighborWeeklyReport(),
      };
    }

    const personIds = persons.map((p) => p.id);
    const { data: relRows, error: relError } = await db
      .from("relationship_states")
      .select(RELATIONSHIP_COLS)
      .in("person_id", personIds);

    if (relError) {
      throw new Error(
        `listAcceptedNeighborManageItems relationships: ${relError.message}`,
      );
    }

    const relByPerson = new Map<string, RelationshipState>();
    for (const row of relRows ?? []) {
      relByPerson.set(
        String(row.person_id),
        mapRelationship(row as Record<string, unknown>),
      );
    }

    const items: NeighborManageListItem[] = [];
    for (const person of persons) {
      const relationship = relByPerson.get(person.id);
      if (!relationship) continue;
      const status = parseNeighborRelationStatus(person.discover_meta);
      if (status !== "accepted") continue;
      items.push(toListItem(person, relationship, status));
    }

    // Join open neighbor_feed Approvals (existing like/comment path) — read-only.
    const feedByPerson = new Map<
      string,
      { approvalId: string; postTitle: string | null }
    >();
    try {
      const feedOpen = await listNeighborFeedApprovalInbox();
      for (const row of feedOpen) {
        const pid = row.person.id;
        if (feedByPerson.has(pid)) continue;
        feedByPerson.set(pid, {
          approvalId: row.approval.id,
          postTitle: row.postTitle,
        });
      }
      for (const item of items) {
        const hit = feedByPerson.get(item.personId);
        if (!hit) continue;
        item.openFeedApprovalId = hit.approvalId;
        item.openFeedPostTitle = hit.postTitle;
      }
    } catch (err) {
      console.warn(
        "[neighbor-manage] feed approval join skipped",
        err instanceof Error ? err.message : err,
      );
    }

    // Today's executed visit/like/comment jobs → care progress (no schema change).
    const todayYmd = kstTodayYmd();
    const { fromIso, toIso } = resolveCompletedRange({ preset: "today" });
    const todayLabelsByPerson = new Map<string, string[]>();
    const todayDoneAtByPerson = new Map<string, string>();
    const todayActions: NeighborManageTodayActions = { ...emptyActions };
    try {
      const { data: jobRows, error: jobError } = await traceQuery(
        "action_jobs.neighbor_care_today",
        () =>
          db
            .from("action_jobs")
            .select("person_id, action_type, executed_at")
            .in("person_id", personIds)
            .in("action_type", CARE_ACTION_TYPES)
            .eq("status", "executed")
            .gte("executed_at", fromIso)
            .lte("executed_at", toIso),
        (r) => rowCountFrom(r.data),
      );
      if (jobError) {
        throw new Error(jobError.message);
      }
      for (const row of jobRows ?? []) {
        const pid = String(row.person_id);
        const actionType = String(row.action_type);
        if (actionType === "visit") todayActions.visit += 1;
        else if (actionType === "like") todayActions.like += 1;
        else if (actionType === "comment") todayActions.comment += 1;

        const label = careLabelForActionType(actionType);
        if (!label) continue;
        const list = todayLabelsByPerson.get(pid) ?? [];
        if (!list.includes(label)) list.push(label);
        todayLabelsByPerson.set(pid, list);
        const executedAt =
          typeof row.executed_at === "string" ? row.executed_at : null;
        if (executedAt) {
          todayDoneAtByPerson.set(
            pid,
            maxIso(todayDoneAtByPerson.get(pid) ?? null, executedAt)!,
          );
        }
      }
    } catch (err) {
      console.warn(
        "[neighbor-manage] today action_jobs join skipped",
        err instanceof Error ? err.message : err,
      );
    }

    const personById = new Map(persons.map((p) => [p.id, p]));
    for (const item of items) {
      const person = personById.get(item.personId);
      const meta = person?.discover_meta ?? {};
      const careDoneOn = careDoneOnFromMeta(meta);
      const careSnoozeOn = careSnoozeOnFromMeta(meta);
      const manualDoneAt = careDoneAtFromMeta(meta);
      const labels = [...(todayLabelsByPerson.get(item.personId) ?? [])];

      // Relationship timestamps already updated for today's actions.
      let careDoneAt = todayDoneAtByPerson.get(item.personId) ?? null;
      if (item.daysSinceVisit === 0 && !labels.includes("방문")) {
        labels.push("방문");
        careDoneAt = maxIso(careDoneAt, item.lastVisitAt);
      }
      if (item.daysSinceLike === 0 && !labels.includes("공감")) {
        labels.push("공감");
        careDoneAt = maxIso(careDoneAt, item.lastLikeAt);
      }
      if (item.daysSinceComment === 0 && !labels.includes("댓글")) {
        labels.push("댓글");
        careDoneAt = maxIso(careDoneAt, item.lastCommentAt);
      }
      if (careDoneOn === todayYmd && !labels.includes("수동 완료")) {
        labels.push("수동 완료");
        careDoneAt = maxIso(careDoneAt, manualDoneAt);
      }

      item.careDoneOn = careDoneOn;
      item.careSnoozeOn = careSnoozeOn;
      item.careDoneLabels = labels;
      item.careDoneAt = careDoneAt;
      item.careStatus = resolveCareStatus({
        careDoneOn,
        careSnoozeOn,
        todayYmd,
        careDoneLabels: labels.filter((l) => l !== "수동 완료"),
        hasOpenFeedApproval: Boolean(item.openFeedApprovalId),
      });
      // Manual complete always wins even if labels empty aside from marker.
      if (careDoneOn === todayYmd) {
        item.careStatus = "done_today";
      } else if (careSnoozeOn === todayYmd) {
        item.careStatus = "snoozed_today";
      }
    }

    const weeklyReport = await buildWeeklyReport(db, personIds, items);

    return { items, todayActions, weeklyReport };
  });
}

/** Mark neighbor as cared-for today via discover_meta (no migration). */
export async function markNeighborCareDoneToday(
  personId: string,
): Promise<{ ok: true; careDoneOn: string }> {
  const repos = createSupervisorRepos(createServiceClient());
  const person = await repos.person.getById(personId);
  if (!person) {
    throw new Error("이웃을 찾을 수 없습니다.");
  }
  const status = parseNeighborRelationStatus(person.discover_meta);
  if (status !== "accepted") {
    throw new Error("서로이웃 완료 상태만 오늘 완료 처리할 수 있습니다.");
  }
  const careDoneOn = kstTodayYmd();
  const careDoneAt = new Date().toISOString();
  await repos.person.updateDiscoverMeta(personId, {
    neighbor_care_done_on: careDoneOn,
    neighbor_care_done_at: careDoneAt,
  });
  return { ok: true, careDoneOn };
}

/** Snooze neighbor for the rest of today (discover_meta, no migration). */
export async function snoozeNeighborCareToday(
  personId: string,
): Promise<{ ok: true; careSnoozeOn: string }> {
  const repos = createSupervisorRepos(createServiceClient());
  const person = await repos.person.getById(personId);
  if (!person) {
    throw new Error("이웃을 찾을 수 없습니다.");
  }
  const status = parseNeighborRelationStatus(person.discover_meta);
  if (status !== "accepted") {
    throw new Error("서로이웃 완료 상태만 나중에 보기로 넘길 수 있습니다.");
  }
  const careSnoozeOn = kstTodayYmd();
  await repos.person.updateDiscoverMeta(personId, {
    neighbor_care_snooze_on: careSnoozeOn,
  });
  return { ok: true, careSnoozeOn };
}

export async function getNeighborManageDetail(
  personId: string,
): Promise<NeighborManageDetailView | null> {
  const repos = createSupervisorRepos(createServiceClient());
  const person = await repos.person.getById(personId);
  if (!person) return null;

  const relationStatus = parseNeighborRelationStatus(person.discover_meta);
  if (relationStatus !== "accepted") return null;

  const db = createServiceClient();
  const [relationship, activeWorkflow, openApprovalCount, careJobsRes, stageChanges] =
    await Promise.all([
      repos.person.getRelationship(personId),
      repos.person.getActiveWorkflow(personId),
      repos.approval.countOpenByPerson(personId),
      traceQuery(
        "action_jobs.neighbor_care_history",
        () =>
          db
            .from("action_jobs")
            .select("id, action_type, executed_at")
            .eq("person_id", personId)
            .in("action_type", CARE_ACTION_TYPES)
            .eq("status", "executed")
            .order("executed_at", { ascending: false })
            .limit(20),
        (r) => rowCountFrom(r.data),
      ),
      repos.activity.listStageChangesByPerson(personId, 10),
    ]);

  if (!relationship) return null;

  const meta = person.discover_meta ?? {};
  const recentCareActions = (careJobsRes.data ?? [])
    .map((row) => {
      const actionType = String(row.action_type);
      const label = careLabelForActionType(actionType);
      if (
        !label ||
        (actionType !== "visit" &&
          actionType !== "like" &&
          actionType !== "comment")
      ) {
        return null;
      }
      return {
        id: String(row.id),
        actionType: actionType as "visit" | "like" | "comment",
        label,
        executedAt:
          typeof row.executed_at === "string" ? row.executed_at : null,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row != null);

  return {
    person,
    relationship,
    activeWorkflow,
    openApprovalCount,
    blogName: blogNameFromMeta(meta),
    nickname: nicknameFromMeta(meta),
    blogUrl: blogUrlFromMeta(meta),
    relationStatus,
    lastPostAt: lastPostAtFromMeta(meta),
    lastPostTitle: recentPostTitleFromMeta(meta),
    recentCareActions,
    relationChanges: stageChanges.map((a) => ({
      id: a.id,
      summary: a.summary,
      createdAt: a.created_at,
    })),
  };
}
