import "server-only";

/**
 * 서로이웃 (neighbor_request) Supervisor service.
 * Reuses ActionJob / Approval / Adapter execute path — create approvals only here.
 */

import { createServiceClient } from "@/lib/supabase";
import { runWithDbTrace, traceQuery, rowCountFrom } from "@/lib/dbTrace";
import { neighborCandidateDiscoveryDisplay } from "@/lib/neighborCandidateDisplay";
import { NaverDiscoverAdapter } from "@/adapters/naver/NaverDiscoverAdapter";
import type { DiscoverCandidate } from "@/adapters/naver/NaverDiscoverAdapter";
import {
  hasNaverSearchApiCredentials,
  searchCandidatesViaNaverApi,
} from "@/adapters/naver/naverBlogSearchApi";
import { sleep } from "@/adapters/naver/timing";
import type { DiscoverPolicy } from "@/domain/policy/discoverPolicy";
import {
  getNeighborDailyLimit,
  getNeighborPolicy,
  neighborPolicyToWeeklyGoalsPatch,
  NEIGHBOR_AD_PENALTY_KEYWORDS,
  type NeighborPolicy,
} from "@/domain/policy/neighborPolicy";
import {
  isNeighborStatusCheckDue,
  parseNeighborRelationStatus,
  type NeighborRelationStatus,
} from "@/domain/neighbor/relationStatus";
import { parseNeighborSource } from "@/domain/neighbor/neighborSource";
import { NaverBlogAdapter } from "@/adapters/naver/NaverBlogAdapter";
import { createRepositories, createSupervisorRepos } from "@/repositories/index";
import {
  analyzeNeighborAiBatchOnce,
  analyzeNeighborCandidatesWithAi,
  daysSinceIso,
  getNeighborAiAnalysisStatus,
  toNeighborAiRowInput,
  type NeighborAiJudgment,
  type NeighborAiRowInput,
} from "@/services/neighborAiAnalyze";
import { codeFilterNeighborCandidate } from "@/services/neighborCodeFilter";
import type { NeighborCodeFilterResult } from "@/services/neighborCodeFilter";
import { neighborCollectTargets } from "@/services/neighborCollectQuota";
import {
  emptyPipelineFunnel,
  logNeighborPipelineFunnel,
  type NeighborPipelineFunnel,
} from "@/services/neighborPipelineFunnel";
import {
  resolveCompletedRange,
  type CompletedRangePreset,
} from "@/lib/completedRange";
import { enqueueApproval } from "@/workers/approval";
import type {
  NeighborCandidate,
  NeighborCompletedItem,
  NeighborCompletedPage,
  NeighborCompletedStatusFilter,
  NeighborExclusion,
  NeighborSettingsView,
} from "@/types/neighborScreen";
import type { DecisionOutput, Workflow } from "@/workers/types";

export type {
  NeighborCandidate,
  NeighborCompletedItem,
  NeighborCompletedPage,
  NeighborCompletedStatusFilter,
  NeighborExclusion,
  NeighborSettingsView,
} from "@/types/neighborScreen";

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string")
    .map((s) => s.trim())
    .filter(Boolean);
}

function startOfKstDayIso(): string {
  const KST = 9 * 60 * 60 * 1000;
  const now = new Date();
  const kst = new Date(now.getTime() + KST);
  const y = kst.getUTCFullYear();
  const m = kst.getUTCMonth();
  const d = kst.getUTCDate();
  return new Date(Date.UTC(y, m, d) - KST).toISOString();
}

function relativeActivityLabel(iso: string | null): string {
  if (!iso) return "활동 시점 미확인";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "활동 시점 미확인";
  const days = Math.floor((Date.now() - t) / 86_400_000);
  if (days <= 0) return "오늘";
  if (days === 1) return "1일 전";
  if (days < 30) return `${days}일 전`;
  if (days < 365) return `${Math.floor(days / 30)}개월 전`;
  return "1년 이상 전";
}

function scoreCandidate(input: {
  meta: Record<string, unknown>;
  keywords: string[];
  displayName: string;
}): { score: number; reasons: string[]; category: string; lastPostAt: string | null } {
  let score = 40;
  const reasons: string[] = [];
  const matched = asStringArray(input.meta.matched_keywords);
  const textBlob = [
    input.displayName,
    typeof input.meta.snippet === "string" ? input.meta.snippet : "",
    matched.join(" "),
    asStringArray(input.meta.reasons).join(" "),
  ]
    .join(" ")
    .toLowerCase();

  const hitKeywords = input.keywords.filter((k) =>
    textBlob.includes(k.toLowerCase()),
  );
  if (hitKeywords.length > 0) {
    score += Math.min(25, hitKeywords.length * 8);
    reasons.push(`${hitKeywords[0]} 관련 글/키워드 일치`);
  } else if (matched.length > 0) {
    score += 10;
    reasons.push(`관심 키워드: ${matched.slice(0, 2).join(", ")}`);
  }

  if (input.meta.recently_active === true) {
    score += 15;
    reasons.push("최근 활동 확인");
  }

  const lastPostAt =
    (typeof input.meta.last_post_at === "string" && input.meta.last_post_at) ||
    (typeof input.meta.last_activity_at === "string" &&
      input.meta.last_activity_at) ||
    null;
  if (lastPostAt) {
    const ageDays = (Date.now() - new Date(lastPostAt).getTime()) / 86_400_000;
    if (ageDays <= 365) {
      score += 10;
      if (ageDays <= 30) {
        score += 5;
        reasons.push("최근 1개월 내 게시");
      } else {
        reasons.push("최근 1년 이내 게시물 확인");
      }
    } else {
      score -= 20;
    }
  }

  const adHits = NEIGHBOR_AD_PENALTY_KEYWORDS.filter((k) =>
    textBlob.includes(k.toLowerCase()),
  );
  if (adHits.length > 0) {
    score -= Math.min(30, adHits.length * 10);
  } else {
    score += 8;
    reasons.push("일반 후기/일상 비율 높음");
  }

  if (input.meta.has_comments === true || input.meta.comment_active === true) {
    score += 8;
    reasons.push("댓글 활동 있음");
  }

  const baseScore =
    typeof input.meta.recommend_score === "number"
      ? input.meta.recommend_score
      : typeof input.meta.keyword_relevance === "number"
        ? input.meta.keyword_relevance
        : null;
  if (baseScore != null) {
    score = Math.round(score * 0.6 + Math.min(100, baseScore) * 0.4);
  }

  const category =
    hitKeywords.length > 0
      ? hitKeywords.slice(0, 2).join(" / ")
      : matched.length > 0
        ? matched.slice(0, 2).join(" / ")
        : "일상";

  if (reasons.length === 0) {
    reasons.push("관계 확장 후보");
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    reasons: reasons.slice(0, 4),
    category,
    lastPostAt,
  };
}

export async function countNeighborExecutedToday(): Promise<number> {
  const db = createServiceClient();
  const since = startOfKstDayIso();
  const { count, error } = await traceQuery(
    "action_jobs.neighbor_executed_today",
    () =>
      db
        .from("action_jobs")
        .select("id", { count: "exact", head: true })
        .eq("action_type", "neighbor_request")
        .eq("status", "executed")
        .gte("executed_at", since),
    (r) => rowCountFrom(null, r.count),
  );
  if (error) throw new Error(`countNeighborExecutedToday: ${error.message}`);
  return count ?? 0;
}

/** Failed neighbor_request jobs today (excluded from success/quota used). */
export async function countNeighborFailedToday(): Promise<number> {
  const db = createServiceClient();
  const since = startOfKstDayIso();
  const { count, error } = await traceQuery(
    "action_jobs.neighbor_failed_today",
    () =>
      db
        .from("action_jobs")
        .select("id", { count: "exact", head: true })
        .eq("action_type", "neighbor_request")
        .in("status", ["failed", "permanently_failed"])
        .gte("updated_at", since),
    (r) => rowCountFrom(null, r.count),
  );
  if (error) throw new Error(`countNeighborFailedToday: ${error.message}`);
  return count ?? 0;
}

/** Soft-excluded neighbor_request today (button missing / already neighbor, etc.). */
export async function countNeighborExcludedToday(): Promise<number> {
  const db = createServiceClient();
  const since = startOfKstDayIso();
  const { count, error } = await traceQuery(
    "action_jobs.neighbor_excluded_today",
    () =>
      db
        .from("action_jobs")
        .select("id", { count: "exact", head: true })
        .eq("action_type", "neighbor_request")
        .in("status", ["excluded", "skipped"])
        .gte("updated_at", since),
    (r) => rowCountFrom(null, r.count),
  );
  if (error) throw new Error(`countNeighborExcludedToday: ${error.message}`);
  return count ?? 0;
}

export async function getNeighborSettings(): Promise<NeighborSettingsView> {
  const repos = createSupervisorRepos(createServiceClient());
  const policy = await repos.policy.get();
  const np = getNeighborPolicy(policy);
  const daily_request_limit = getNeighborDailyLimit(policy);
  const [today_executed, today_failed, today_excluded] = await Promise.all([
    countNeighborExecutedToday(),
    countNeighborFailedToday(),
    countNeighborExcludedToday(),
  ]);
  return {
    ...np,
    daily_request_limit,
    today_executed,
    today_failed,
    today_excluded,
    today_remaining: Math.max(0, daily_request_limit - today_executed),
  };
}

export async function updateNeighborSettings(input: {
  keywords?: string[];
  daily_candidate_quota?: number;
  ai_analyze_max?: number;
  ai_batch_size?: number;
  ai_concurrency?: number;
  message?: string;
  delay_min_sec?: number;
  delay_max_sec?: number;
  daily_request_limit?: number;
  status_check_mode?: NeighborPolicy["status_check_mode"];
  status_last_check_at?: string | null;
  feed_lookback_days?: number;
  feed_max_per_neighbor_day?: number;
  feed_max_collect_day?: number;
  feed_last_collect_at?: string | null;
  feed_collect_mode?: NeighborPolicy["feed_collect_mode"];
  feed_collect_hour?: number;
  feed_ai_auto_count?: NeighborPolicy["feed_ai_auto_count"];
}): Promise<NeighborSettingsView> {
  const repos = createSupervisorRepos(createServiceClient());
  const current = await repos.policy.get();
  const prev = getNeighborPolicy(current);
  const next: NeighborPolicy = {
    keywords: input.keywords ?? prev.keywords,
    daily_candidate_quota:
      input.daily_candidate_quota ?? prev.daily_candidate_quota,
    ai_analyze_max: input.ai_analyze_max ?? prev.ai_analyze_max,
    ai_batch_size: input.ai_batch_size ?? prev.ai_batch_size,
    ai_concurrency: input.ai_concurrency ?? prev.ai_concurrency,
    message: input.message ?? prev.message,
    delay_min_sec: input.delay_min_sec ?? prev.delay_min_sec,
    delay_max_sec: input.delay_max_sec ?? prev.delay_max_sec,
    status_check_mode: input.status_check_mode ?? prev.status_check_mode,
    status_last_check_at:
      input.status_last_check_at !== undefined
        ? input.status_last_check_at
        : prev.status_last_check_at,
    feed_lookback_days:
      input.feed_lookback_days ?? prev.feed_lookback_days,
    feed_max_per_neighbor_day:
      input.feed_max_per_neighbor_day ?? prev.feed_max_per_neighbor_day,
    feed_max_collect_day:
      input.feed_max_collect_day ?? prev.feed_max_collect_day,
    feed_last_collect_at:
      input.feed_last_collect_at !== undefined
        ? input.feed_last_collect_at
        : prev.feed_last_collect_at,
    feed_collect_mode: input.feed_collect_mode ?? prev.feed_collect_mode,
    feed_collect_hour: input.feed_collect_hour ?? prev.feed_collect_hour,
    feed_ai_auto_count: input.feed_ai_auto_count ?? prev.feed_ai_auto_count,
  };
  if (next.delay_max_sec < next.delay_min_sec) {
    next.delay_max_sec = next.delay_min_sec;
  }

  const weekly = neighborPolicyToWeeklyGoalsPatch(
    next,
    current.weekly_goals ?? {},
  );
  const limits = { ...current.daily_limits };
  if (input.daily_request_limit != null) {
    limits.neighbor_request = Math.max(
      0,
      Math.floor(input.daily_request_limit),
    );
  }

  await repos.policy.update({
    weekly_goals: weekly,
    daily_limits: limits,
    discover_keywords:
      next.keywords.length > 0 ? next.keywords : current.discover_keywords,
  });

  return getNeighborSettings();
}

async function listExecutedNeighborBlogIds(): Promise<Set<string>> {
  const db = createServiceClient();
  const { data, error } = await traceQuery(
    "action_jobs.executed_neighbor_blog_ids",
    () =>
      db
        .from("action_jobs")
        .select("id, target_ref, status")
        .eq("action_type", "neighbor_request")
        .eq("status", "executed")
        .order("executed_at", { ascending: false })
        .limit(800),
    (r) => rowCountFrom(r.data),
  );
  if (error) throw new Error(`listExecutedNeighborBlogIds: ${error.message}`);
  const set = new Set<string>();
  for (const row of data ?? []) {
    const ref = (row as { target_ref?: Record<string, unknown> }).target_ref;
    const blog =
      typeof ref?.blog_id === "string"
        ? ref.blog_id
        : typeof ref?.blogId === "string"
          ? ref.blogId
          : null;
    if (blog) set.add(blog.toLowerCase());
  }
  return set;
}

async function openNeighborApprovalPersonIds(
  repos: ReturnType<typeof createSupervisorRepos>,
): Promise<Set<string>> {
  return repos.approval.listOpenNeighborRequestPersonIds();
}

function buildNeighborCandidatesFromRows(input: {
  rows: Awaited<
    ReturnType<ReturnType<typeof createSupervisorRepos>["person"]["listCrmRows"]>
  >;
  np: NeighborPolicy;
  excludedIds: Set<string>;
  already: Set<string>;
  openPersons: Set<string>;
  limit?: number;
}): NeighborCandidate[] {
  const { rows, np, excludedIds, already, openPersons, limit } = input;
  const out: NeighborCandidate[] = [];

  for (const row of rows) {
    const meta = row.person.discover_meta ?? {};
    if (meta.verify === true) continue;
    if (meta.neighbor_excluded === true) continue;
    if (meta.supervisor_review === "dismissed") continue;
    const relation = parseNeighborRelationStatus(meta);
    if (
      relation === "requested" ||
      relation === "accepted" ||
      relation === "failed"
    ) {
      continue;
    }

    const blogId =
      typeof meta.blog_id === "string" ? meta.blog_id.trim() : "";
    if (!blogId) continue;
    if (excludedIds.has(blogId.toLowerCase())) continue;
    if (already.has(blogId.toLowerCase())) continue;

    const stage = row.relationship.stage;
    if (stage === "risk") continue;

    const scored = scoreCandidate({
      meta,
      keywords: np.keywords,
      displayName: row.person.display_name,
    });

    if (scored.score < 25) continue;

    const blogUrl =
      typeof meta.blog_url === "string"
        ? meta.blog_url
        : `https://m.blog.naver.com/${blogId}`;

    const keywordMatchRate =
      typeof meta.keyword_match_rate === "number"
        ? Math.max(0, Math.min(100, Math.round(meta.keyword_match_rate)))
        : typeof meta.keyword_relevance === "number"
          ? Math.max(0, Math.min(100, Math.round(meta.keyword_relevance)))
          : Math.min(100, scored.score);
    const adScore =
      typeof meta.ad_score === "number"
        ? Math.max(0, Math.min(100, Math.round(meta.ad_score)))
        : 0;

    const storedReasons = asStringArray(meta.reasons);
    const recommendScore =
      meta.source === "neighbor_collect" &&
      typeof meta.recommend_score === "number"
        ? Math.max(0, Math.min(100, Math.round(meta.recommend_score)))
        : scored.score;
    const recommendReasons =
      meta.source === "neighbor_collect" && storedReasons.length > 0
        ? storedReasons.slice(0, 5)
        : scored.reasons;

    const discoveryDisplay = neighborCandidateDiscoveryDisplay(meta, np.keywords, {
      keywordMatchRate,
      adScore,
      recommendScore,
      lastActivityLabel: relativeActivityLabel(scored.lastPostAt),
    });

    out.push({
      personId: row.person.id,
      blogId,
      blogName: row.person.display_name,
      nickname:
        typeof meta.nickname === "string" && meta.nickname
          ? meta.nickname
          : row.person.display_name,
      blogUrl,
      category:
        typeof meta.primary_category === "string" && meta.primary_category
          ? meta.primary_category
          : scored.category,
      lastPostAt: scored.lastPostAt,
      lastActivityLabel: relativeActivityLabel(scored.lastPostAt),
      keywordMatchRate,
      adScore,
      recommendScore,
      recommendReasons,
      hasOpenApproval: openPersons.has(row.person.id),
      alreadyRequested: already.has(blogId.toLowerCase()),
      searchKeyword: discoveryDisplay.searchKeyword,
      searchRank: discoveryDisplay.searchRank,
      collectSource: discoveryDisplay.collectSource,
      recentlyActive: discoveryDisplay.recentlyActive,
      scoreBreakdown: discoveryDisplay.scoreBreakdown,
    });
  }

  out.sort((a, b) => b.recommendScore - a.recommendScore);
  const capped = out.slice(0, np.daily_candidate_quota);
  if (limit != null && limit > 0) {
    return capped.slice(0, limit);
  }
  return capped;
}

/** Combined page load: settings + candidates in one traced scope (parallel DB). */
export async function loadNeighborPageData(opts?: {
  limit?: number;
}): Promise<{
  settings: NeighborSettingsView;
  candidates: NeighborCandidate[];
}> {
  return runWithDbTrace("neighbors", async () => {
    const repos = createSupervisorRepos(createServiceClient());

    const [policy, excluded, already, openPersons, rows, today_executed, today_failed, today_excluded] =
      await Promise.all([
        traceQuery("policy.get", () => repos.policy.get(), () => 1),
        repos.neighborExclusion.list(),
        listExecutedNeighborBlogIds(),
        openNeighborApprovalPersonIds(repos),
        repos.person.listCrmRows(),
        countNeighborExecutedToday(),
        countNeighborFailedToday(),
        countNeighborExcludedToday(),
      ]);

    const np = getNeighborPolicy(policy);
    const daily_request_limit = getNeighborDailyLimit(policy);
    const settings: NeighborSettingsView = {
      ...np,
      daily_request_limit,
      today_executed,
      today_failed,
      today_excluded,
      today_remaining: Math.max(0, daily_request_limit - today_executed),
    };

    const excludedIds = new Set(excluded.map((e) => e.blog_id.toLowerCase()));
    const candidates = buildNeighborCandidatesFromRows({
      rows,
      np,
      excludedIds,
      already,
      openPersons,
      limit: opts?.limit,
    });

    return { settings, candidates };
  });
}

export async function listNeighborCandidates(opts?: {
  limit?: number;
}): Promise<NeighborCandidate[]> {
  const { candidates } = await loadNeighborPageData(opts);
  return candidates;
}

export async function listNeighborExclusions(): Promise<NeighborExclusion[]> {
  const repos = createSupervisorRepos(createServiceClient());
  return repos.neighborExclusion.list();
}

export async function excludeNeighborBlog(input: {
  blogId: string;
  blogName?: string;
  blogUrl?: string;
  personId?: string;
}): Promise<void> {
  const repos = createSupervisorRepos(createServiceClient());
  await repos.neighborExclusion.exclude({
    blog_id: input.blogId,
    blog_name: input.blogName ?? null,
    blog_url: input.blogUrl ?? null,
    note: "supervisor_exclude",
  });
  if (input.personId) {
    await repos.person.updateDiscoverMeta(input.personId, {
      neighbor_excluded: true,
      neighbor_excluded_at: new Date().toISOString(),
    });
  }
}

export async function allowNeighborBlogAgain(blogId: string): Promise<void> {
  const repos = createSupervisorRepos(createServiceClient());
  await repos.neighborExclusion.allowAgain(blogId);
  const personId = await repos.person.findPersonIdByBlogId(blogId);
  if (personId) {
    await repos.person.updateDiscoverMeta(personId, {
      neighbor_excluded: false,
      neighbor_excluded_at: null,
    });
  }
}

export type NeighborRequestCreateResult = {
  ok: boolean;
  approvalId?: string;
  errorMessage?: string;
};

/**
 * Create pending Approval for neighbor_request (no execute).
 * Uses existing enqueueApproval → Approval Inbox / approve path.
 */
export async function createNeighborRequestApproval(
  personId: string,
): Promise<NeighborRequestCreateResult> {
  const db = createServiceClient();
  const repos = createSupervisorRepos(db);
  const workerRepos = createRepositories(db);
  const settings = await getNeighborSettings();

  if (settings.today_remaining <= 0) {
    return {
      ok: false,
      errorMessage: "오늘 서로이웃 추가 가능 수량을 모두 사용했습니다.",
    };
  }

  const person = await repos.person.getById(personId);
  if (!person) return { ok: false, errorMessage: "대상을 찾을 수 없습니다." };
  const meta = person.discover_meta ?? {};
  const blogId =
    typeof meta.blog_id === "string" ? meta.blog_id.trim() : "";
  if (!blogId) {
    return { ok: false, errorMessage: "블로그 ID가 없어 신청할 수 없습니다." };
  }
  if (await repos.neighborExclusion.isExcluded(blogId)) {
    return { ok: false, errorMessage: "제외된 블로그입니다." };
  }

  const already = await listExecutedNeighborBlogIds();
  if (already.has(blogId.toLowerCase())) {
    return {
      ok: false,
      errorMessage: "이미 서로이웃 처리한 블로그입니다.",
    };
  }

  const openPersons = await repos.approval.listOpenNeighborRequestPersonIds();
  if (openPersons.has(personId)) {
    return {
      ok: false,
      errorMessage: "이미 승인 대기 중인 서로이웃 신청이 있습니다.",
    };
  }

  let workflow = (await workerRepos.getActiveWorkflow(
    personId,
  )) as Workflow | null;
  if (!workflow) {
    workflow = (await workerRepos.createWorkflow({
      person_id: personId,
      current_stage: "warming",
      current_state: "active",
      next_action: "neighbor_request",
      last_decision_id: null,
      priority: 70,
      goal: "neighbor_request_ui",
    })) as Workflow;
    await workerRepos.setPersonActiveWorkflow(personId, workflow.id);
  }

  const blogUrl =
    typeof meta.blog_url === "string"
      ? meta.blog_url
      : `https://m.blog.naver.com/${blogId}`;
  const reasonShort = "서로이웃 후보에서 신청";
  const record = await workerRepos.insertDecision({
    person_id: personId,
    workflow_id: workflow.id,
    perception_event_id: null,
    decision_type: "create_approval",
    reason_short: reasonShort,
    reason_detail: {
      explanation: "서로이웃 관리에서 선택한 후보",
      reasons: asStringArray(meta.reasons).slice(0, 3),
      rule_ids: ["ui.neighbor_request"],
    },
    inputs: { source: "neighbor_ui" },
  });

  const output: Extract<DecisionOutput, { kind: "create_approval" }> = {
    kind: "create_approval",
    reason_short: reasonShort,
    explanation: "서로이웃 관리에서 선택한 후보",
    reasons: [
      "관심 키워드와 맞는 블로그",
      "최근 활동이 있는 블로그",
      "일반 후기/일상 중심",
    ],
    rule_ids: ["ui.neighbor_request"],
    workflow_patch: {
      next_action: "none",
      blocked_reason: null,
    },
    draft: {
      action_type: "neighbor_request",
      channel: "blog",
      body: settings.message,
      alternatives: [],
      target_ref: {
        blog_id: blogId,
        blog_url: blogUrl,
        title: person.display_name,
      },
    },
  };

  const { approval } = await enqueueApproval(
    workerRepos,
    workflow,
    output,
    record,
  );

  return { ok: true, approvalId: approval.id };
}

export async function listNeighborCompleted(opts?: {
  page?: number;
  pageSize?: number;
  preset?: CompletedRangePreset;
  fromDate?: string;
  toDate?: string;
  statusFilter?: NeighborCompletedStatusFilter;
  /** @deprecated use pageSize */
  limit?: number;
}): Promise<NeighborCompletedPage> {
  const pageSize = Math.min(
    Math.max(opts?.pageSize ?? opts?.limit ?? 15, 1),
    50,
  );
  const page = Math.max(opts?.page ?? 1, 1);
  const statusFilter =
    opts?.statusFilter === "accepted" ||
    opts?.statusFilter === "requested" ||
    opts?.statusFilter === "failed"
      ? opts.statusFilter
      : null;
  const range = resolveCompletedRange({
    preset: opts?.preset ?? "7d",
    fromDate: opts?.fromDate,
    toDate: opts?.toDate,
  });
  const todayRange = resolveCompletedRange({ preset: "today" });

  const db = createServiceClient();

  async function loadJobsInRange(fromIso: string, toIso: string) {
    const { data, error } = await db
      .from("action_jobs")
      .select(
        "id, status, draft_body, target_ref, person_id, updated_at, executed_at, error",
      )
      .eq("action_type", "neighbor_request")
      .in("status", ["executed", "failed", "rejected", "permanently_failed"])
      .gte("updated_at", fromIso)
      .lte("updated_at", toIso)
      .order("updated_at", { ascending: false })
      .limit(800);
    if (error) throw new Error(`listNeighborCompleted: ${error.message}`);
    return data ?? [];
  }

  async function relationForPerson(
    personId: string,
    jobStatus: string,
  ): Promise<{
    status: NeighborRelationStatus;
    checkedAt: string | null;
    displayName: string;
    blogUrl: string | null;
    failReason: string | null;
  }> {
    const { data: person } = await db
      .from("persons")
      .select("display_name, discover_meta")
      .eq("id", personId)
      .maybeSingle();
    const meta =
      ((person as { discover_meta?: Record<string, unknown> } | null)
        ?.discover_meta ?? {}) as Record<string, unknown>;
    const stored = parseNeighborRelationStatus(meta);
    let status: NeighborRelationStatus;
    if (jobStatus !== "executed") {
      status = "failed";
    } else if (stored === "accepted") {
      status = "accepted";
    } else {
      status = "requested";
    }
    return {
      status,
      checkedAt:
        typeof meta.neighbor_status_checked_at === "string"
          ? meta.neighbor_status_checked_at
          : null,
      displayName:
        (person as { display_name?: string } | null)?.display_name ?? "블로거",
      blogUrl: typeof meta.blog_url === "string" ? meta.blog_url : null,
      failReason:
        typeof meta.neighbor_fail_reason === "string"
          ? meta.neighbor_fail_reason
          : null,
    };
  }

  type Enriched = {
    job: Record<string, unknown>;
    rel: Awaited<ReturnType<typeof relationForPerson>>;
  };

  async function enrichJobs(
    jobs: Awaited<ReturnType<typeof loadJobsInRange>>,
  ): Promise<Enriched[]> {
    const out: Enriched[] = [];
    for (const job of jobs) {
      const j = job as Record<string, unknown>;
      const rel = await relationForPerson(String(j.person_id), String(j.status));
      out.push({ job: j, rel });
    }
    return out;
  }

  function tally(rows: Enriched[]) {
    let accepted = 0;
    let requested = 0;
    let failed = 0;
    for (const row of rows) {
      if (row.rel.status === "accepted") accepted += 1;
      else if (row.rel.status === "requested") requested += 1;
      else failed += 1;
    }
    return { accepted, requested, failed };
  }

  const [rangeJobs, todayJobs] = await Promise.all([
    loadJobsInRange(range.fromIso, range.toIso),
    loadJobsInRange(todayRange.fromIso, todayRange.toIso),
  ]);

  const [rangeEnriched, todayEnriched] = await Promise.all([
    enrichJobs(rangeJobs),
    enrichJobs(todayJobs),
  ]);

  const rangeTally = tally(rangeEnriched);
  const todayTally = tally(todayEnriched);

  const filtered = statusFilter
    ? rangeEnriched.filter((r) => r.rel.status === statusFilter)
    : rangeEnriched;

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const from = (safePage - 1) * pageSize;
  const pageRows = filtered.slice(from, from + pageSize);

  const items: NeighborCompletedItem[] = [];
  for (const { job: j, rel } of pageRows) {
    const personId = String(j.person_id);
    const { data: approval } = await db
      .from("approval_items")
      .select("id, resolved_at")
      .eq("action_job_id", j.id)
      .maybeSingle();
    const ref = (j.target_ref ?? {}) as Record<string, unknown>;
    const blogId =
      typeof ref.blog_id === "string"
        ? ref.blog_id
        : typeof ref.blogId === "string"
          ? ref.blogId
          : null;
    const jobError =
      typeof j.error === "string" && j.error.trim() ? j.error.trim() : null;
    items.push({
      approvalId: (approval as { id?: string } | null)?.id ?? String(j.id),
      personId,
      personName: rel.displayName,
      blogId,
      blogUrl:
        typeof ref.blog_url === "string" ? ref.blog_url : rel.blogUrl,
      resolvedAt: String(
        (approval as { resolved_at?: string } | null)?.resolved_at ??
          j.executed_at ??
          j.updated_at,
      ),
      success: j.status === "executed",
      draftBody: typeof j.draft_body === "string" ? j.draft_body : "",
      relationStatus: rel.status,
      statusCheckedAt: rel.checkedAt,
      errorMessage: jobError ?? rel.failReason,
    });
  }

  return {
    items,
    total,
    page: safePage,
    pageSize,
    totalPages,
    successCount: rangeTally.accepted + rangeTally.requested,
    todaySuccessCount: todayTally.accepted + todayTally.requested,
    todayAcceptedCount: todayTally.accepted,
    todayRequestedCount: todayTally.requested,
    todayFailedCount: todayTally.failed,
    rangeAcceptedCount: rangeTally.accepted,
    rangeRequestedCount: rangeTally.requested,
    rangeFailedCount: rangeTally.failed,
    rangeLabel: range.label,
    statusFilter,
  };
}

/** After ActionJob execute success — upsert as accepted neighbor for feed pool. */
export async function markNeighborRequested(
  personId: string,
): Promise<{ ok: boolean }> {
  const { upsertAcceptedNeighborAfterRequest } = await import(
    "@/services/neighborAcceptedSync"
  );
  return upsertAcceptedNeighborAfterRequest(personId);
}

/** Mark 신청 실패 on person meta (removed from candidates → 처리완료). */
export async function markNeighborRequestFailed(
  personId: string,
  reason?: string,
): Promise<{ ok: boolean }> {
  const repos = createSupervisorRepos(createServiceClient());
  await repos.person.updateDiscoverMeta(personId, {
    neighbor_relation_status: "failed",
    neighbor_failed_at: new Date().toISOString(),
    neighbor_fail_reason:
      typeof reason === "string" ? reason.slice(0, 200) : null,
  });
  return { ok: true };
}

export type NeighborStatusCheckSummary = {
  checked: number;
  accepted: number;
  stillPending: number;
  unknown: number;
  errors: number;
};

/**
 * CDP probe for pending (신청 완료) blogs. Does not change Approval/ActionJob execute.
 */
export async function checkPendingNeighborStatuses(opts?: {
  /** Force check even if auto interval not due */
  force?: boolean;
  /** Max blogs to probe this run */
  limit?: number;
  personIds?: string[];
}): Promise<NeighborStatusCheckSummary> {
  const repos = createSupervisorRepos(createServiceClient());
  const policy = await repos.policy.get();
  const np = getNeighborPolicy(policy);
  const force = opts?.force === true;
  const limit = Math.min(Math.max(opts?.limit ?? 15, 1), 30);

  if (
    !force &&
    !isNeighborStatusCheckDue(np.status_last_check_at, np.status_check_mode)
  ) {
    return {
      checked: 0,
      accepted: 0,
      stillPending: 0,
      unknown: 0,
      errors: 0,
    };
  }

  const db = createServiceClient();
  const { data: jobs, error } = await db
    .from("action_jobs")
    .select("id, person_id, target_ref, status")
    .eq("action_type", "neighbor_request")
    .eq("status", "executed")
    .order("executed_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(`checkPendingNeighborStatuses: ${error.message}`);

  const adapter = new NaverBlogAdapter();
  const summary: NeighborStatusCheckSummary = {
    checked: 0,
    accepted: 0,
    stillPending: 0,
    unknown: 0,
    errors: 0,
  };

  const filterIds =
    opts?.personIds && opts.personIds.length > 0
      ? new Set(opts.personIds)
      : null;

  for (const job of jobs ?? []) {
    if (summary.checked >= limit) break;
    const j = job as {
      person_id: string;
      target_ref?: Record<string, unknown>;
    };
    if (filterIds && !filterIds.has(j.person_id)) continue;

    const person = await repos.person.getById(j.person_id);
    if (!person) continue;
    const meta = person.discover_meta ?? {};
    const status = parseNeighborRelationStatus(meta);
    if (status === "accepted") continue;

    const blogId =
      typeof j.target_ref?.blog_id === "string"
        ? j.target_ref.blog_id
        : typeof meta.blog_id === "string"
          ? meta.blog_id
          : null;
    const blogUrl =
      typeof j.target_ref?.blog_url === "string"
        ? j.target_ref.blog_url
        : typeof meta.blog_url === "string"
          ? meta.blog_url
          : null;
    if (!blogId && !blogUrl) continue;

    // Skip recently checked unless forced
    const last =
      typeof meta.neighbor_status_checked_at === "string"
        ? meta.neighbor_status_checked_at
        : null;
    if (
      !force &&
      last &&
      !isNeighborStatusCheckDue(last, np.status_check_mode)
    ) {
      continue;
    }

    summary.checked += 1;
    const probe = await adapter.checkNeighborRelation({ blogId, blogUrl });
    const now = new Date().toISOString();

    if (!probe.ok) {
      summary.errors += 1;
      await repos.person.updateDiscoverMeta(j.person_id, {
        neighbor_status_checked_at: now,
        neighbor_relation_status: status ?? "requested",
      });
      continue;
    }

    if (probe.result === "accepted") {
      summary.accepted += 1;
      const prevSource = parseNeighborSource(meta);
      await repos.person.updateDiscoverMeta(j.person_id, {
        neighbor_relation_status: "accepted",
        neighbor_accepted_at: now,
        neighbor_status_checked_at: now,
        neighbor_synced_at: now,
        ...(prevSource
          ? {}
          : {
              neighbor_source: "neighbor_request",
              source: "neighbor_request",
            }),
      });
    } else if (
      probe.result === "pending_request" ||
      probe.result === "can_request"
    ) {
      // can_request after we already executed is unusual — keep as 신청 완료
      summary.stillPending += 1;
      await repos.person.updateDiscoverMeta(j.person_id, {
        neighbor_relation_status: "requested",
        neighbor_status_checked_at: now,
      });
    } else {
      summary.unknown += 1;
      await repos.person.updateDiscoverMeta(j.person_id, {
        neighbor_relation_status: status ?? "requested",
        neighbor_status_checked_at: now,
      });
    }
  }

  await updateNeighborSettings({
    status_last_check_at: new Date().toISOString(),
  });

  return summary;
}

export type NeighborDuplicateHit = {
  personId: string;
  blogId: string;
  blogName: string;
  lastExecutedAt: string | null;
};

export async function checkNeighborDuplicates(
  personIds: string[],
): Promise<{ duplicates: NeighborDuplicateHit[]; uniquePersonIds: string[] }> {
  const repos = createSupervisorRepos(createServiceClient());
  const already = await listExecutedNeighborBlogIds();
  const duplicates: NeighborDuplicateHit[] = [];
  const uniquePersonIds: string[] = [];

  // map blog -> last executed at
  const db = createServiceClient();
  const { data: executed } = await db
    .from("action_jobs")
    .select("executed_at, target_ref")
    .eq("action_type", "neighbor_request")
    .eq("status", "executed")
    .order("executed_at", { ascending: false })
    .limit(800);
  const lastAt = new Map<string, string>();
  for (const row of executed ?? []) {
    const ref = (row as { target_ref?: Record<string, unknown>; executed_at?: string })
      .target_ref;
    const blog =
      typeof ref?.blog_id === "string" ? ref.blog_id.toLowerCase() : null;
    const at = (row as { executed_at?: string }).executed_at;
    if (blog && at && !lastAt.has(blog)) lastAt.set(blog, at);
  }

  for (const personId of personIds) {
    const person = await repos.person.getById(personId);
    if (!person) continue;
    const meta = person.discover_meta ?? {};
    const blogId =
      typeof meta.blog_id === "string" ? meta.blog_id.trim() : "";
    if (!blogId) {
      uniquePersonIds.push(personId);
      continue;
    }
    if (already.has(blogId.toLowerCase())) {
      duplicates.push({
        personId,
        blogId,
        blogName: person.display_name,
        lastExecutedAt: lastAt.get(blogId.toLowerCase()) ?? null,
      });
    } else {
      uniquePersonIds.push(personId);
    }
  }

  return { duplicates, uniquePersonIds };
}

function randomBetweenMs(minSec: number, maxSec: number): number {
  const min = Math.max(0, minSec) * 1000;
  const max = Math.max(min, maxSec * 1000);
  if (max <= min) return min;
  return Math.floor(min + Math.random() * (max - min + 1));
}

function isAlreadyAiAnalyzed(meta: Record<string, unknown>): boolean {
  return getNeighborAiAnalysisStatus(meta) !== "none";
}

function shouldReuseAiAnalysis(meta: Record<string, unknown>): boolean {
  if (getNeighborAiAnalysisStatus(meta) !== "fresh") return false;
  // 30일+ 미활동이면 재사용하지 않고 재분석/제외 경로로
  const lastPost =
    typeof meta.last_post_at === "string" ? meta.last_post_at : null;
  const age = daysSinceIso(lastPost);
  if (age != null && age > 30) return false;
  return true;
}

function judgmentFromStoredMeta(
  c: DiscoverCandidate,
  meta: Record<string, unknown>,
): NeighborAiJudgment {
  const reasons = Array.isArray(meta.reasons)
    ? meta.reasons.filter((x): x is string => typeof x === "string").slice(0, 4)
    : ["기존 분석 결과 재사용"];
  return {
    blogId: c.blogId,
    topicFit: meta.topic_fit !== false,
    personalFeel: meta.personal_feel !== false,
    neighborWorth: meta.neighbor_worth !== false,
    recommendScore:
      typeof meta.recommend_score === "number"
        ? Math.max(0, Math.min(100, Math.round(meta.recommend_score)))
        : 50,
    reasons: reasons.length > 0 ? reasons : ["기존 분석 결과 재사용"],
    primaryCategory:
      typeof meta.primary_category === "string" && meta.primary_category
        ? meta.primary_category
        : "일상",
    source: "heuristic",
  };
}

async function countNeighborCollectedToday(): Promise<number> {
  const db = createServiceClient();
  const since = startOfKstDayIso();
  const { data, error } = await db
    .from("persons")
    .select("id, discover_meta, created_at")
    .gte("created_at", since)
    .limit(200);
  if (error) throw new Error(`countNeighborCollectedToday: ${error.message}`);
  let n = 0;
  for (const row of data ?? []) {
    const meta = (row as { discover_meta?: Record<string, unknown> })
      .discover_meta;
    if (meta?.source === "neighbor_collect") n += 1;
  }
  return n;
}

export type NeighborCollectResult = {
  ok: boolean;
  added: number;
  updated: number;
  skippedExcluded: number;
  skippedFiltered: number;
  skippedExisting: number;
  skippedAlreadyAnalyzed: number;
  candidatesSeen: number;
  filteredCount: number;
  aiAnalyzedCount: number;
  todayCollected: number;
  dailyQuota: number;
  remainingQuota: number;
  keywords: string[];
  errors: string[];
  message: string;
  searchSource: "api" | "cdp_fallback" | "none";
  funnel: NeighborPipelineFunnel;
};

export type NeighborSearchHitsResult = {
  ok: boolean;
  keywords: string[];
  hits: DiscoverCandidate[];
  searchSource: "api" | "cdp_fallback" | "none";
  remainingQuota: number;
  dailyQuota: number;
  searchMax: number;
  filterMax: number;
  errors: string[];
  message: string;
  funnel: NeighborPipelineFunnel;
};

export type NeighborFilterHitsResult = {
  ok: boolean;
  keywords: string[];
  searchSource: NeighborCollectResult["searchSource"];
  remainingQuota: number;
  dailyQuota: number;
  filterMax: number;
  aiAnalyzeMax?: number;
  /** Need AI analysis (already top-N by code score) */
  toAnalyze: Array<{
    candidate: DiscoverCandidate;
    filter: NeighborCodeFilterResult;
  }>;
  /** Already AI-analyzed — reuse stored judgment */
  reused: Array<{
    candidate: DiscoverCandidate;
    filter: NeighborCodeFilterResult;
    judgment: NeighborAiJudgment;
  }>;
  stats: {
    input: number;
    excluded: number;
    alreadyRequested: number;
    alreadyAnalyzed: number;
    codeRejected: number;
    passed: number;
  };
  errors: string[];
  message: string;
  funnel: NeighborPipelineFunnel;
};

async function searchNeighborHitsViaCdpFallback(input: {
  keywords: string[];
  searchMax: number;
  delayMinSec: number;
  delayMaxSec: number;
}): Promise<{
  hits: DiscoverCandidate[];
  errors: string[];
  rawItemCount: number;
  duplicatesRemoved: number;
}> {
  const adapter = new NaverDiscoverAdapter();
  const hits: DiscoverCandidate[] = [];
  const seen = new Set<string>();
  const errors: string[] = [];
  let rawItemCount = 0;
  let duplicatesRemoved = 0;
  const perKeyword = Math.max(
    10,
    Math.ceil(input.searchMax / Math.max(1, input.keywords.length)),
  );

  for (const keyword of input.keywords) {
    if (hits.length >= input.searchMax) break;
    try {
      const delayMs = randomBetweenMs(input.delayMinSec, input.delayMaxSec);
      await sleep(delayMs);

      const discoverPolicy: DiscoverPolicy = {
        search_keywords: [keyword],
        exclude_keywords: [],
        target_categories: input.keywords.slice(0, 8),
        max_candidates_per_tick: Math.min(
          perKeyword,
          input.searchMax - hits.length,
        ),
        active: true,
        goal_label: "neighbor_collect",
      };

      const batch = await adapter.searchCandidates(discoverPolicy);
      rawItemCount += batch.length;
      for (const c of batch) {
        const key = c.blogId.toLowerCase();
        if (seen.has(key)) {
          duplicatesRemoved += 1;
          continue;
        }
        seen.add(key);
        hits.push(c);
        if (hits.length >= input.searchMax) break;
      }
    } catch (err) {
      errors.push(
        `${keyword}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    hits,
    errors,
    rawItemCount,
    duplicatesRemoved: Math.max(0, rawItemCount - hits.length),
  };
}

/**
 * Phase 1 — keyword search (API primary, CDP scrape fallback).
 * Dedupes by blog_id only. Does not write DB.
 */
export async function searchNeighborCandidateHits(): Promise<NeighborSearchHitsResult> {
  const repos = createSupervisorRepos(createServiceClient());
  const policy = await repos.policy.get();
  const np = getNeighborPolicy(policy);
  const keywords = np.keywords;
  const todayCollected = await countNeighborCollectedToday();
  const remainingQuota = Math.max(0, np.daily_candidate_quota - todayCollected);
  const targets = neighborCollectTargets(
    remainingQuota > 0 ? remainingQuota : np.daily_candidate_quota,
    np.ai_analyze_max,
  );

  const baseFunnel = emptyPipelineFunnel({ keywords });

  const empty: NeighborSearchHitsResult = {
    ok: true,
    keywords,
    hits: [],
    searchSource: "none",
    remainingQuota,
    dailyQuota: np.daily_candidate_quota,
    searchMax: targets.searchMax,
    filterMax: targets.filterMax,
    errors: [],
    message: "",
    funnel: baseFunnel,
  };

  if (keywords.length === 0) {
    return {
      ...empty,
      ok: false,
      message: "설정에서 검색 키워드를 먼저 입력해 주세요.",
    };
  }

  if (remainingQuota <= 0) {
    return {
      ...empty,
      message: `오늘 후보 생성량(${np.daily_candidate_quota}명)을 모두 채웠습니다.`,
    };
  }

  if (
    JSON.stringify(policy.discover_keywords ?? []) !== JSON.stringify(keywords)
  ) {
    await repos.policy.update({ discover_keywords: keywords });
  }

  const perKeyword = Math.max(
    20,
    Math.ceil(targets.searchMax / Math.max(1, keywords.length)),
  );

  if (hasNaverSearchApiCredentials()) {
    try {
      const api = await searchCandidatesViaNaverApi({
        keywords,
        maxPerKeyword: Math.min(targets.searchMax, perKeyword),
        maxTotal: targets.searchMax,
      });

      if (api.errors.length === 0 || api.candidates.length > 0) {
        const funnel = emptyPipelineFunnel({
          searchSource: "api",
          keywords,
          apiRawCount: api.rawItemCount,
          afterDedupe: api.candidates.length,
          duplicatesRemoved: api.duplicatesRemoved,
        });
        logNeighborPipelineFunnel(funnel);
        return {
          ok: true,
          keywords,
          hits: api.candidates,
          searchSource: "api",
          remainingQuota,
          dailyQuota: np.daily_candidate_quota,
          searchMax: targets.searchMax,
          filterMax: targets.filterMax,
          errors: api.errors,
          message:
            api.candidates.length > 0
              ? `검색 완료 (원본 ${api.rawItemCount} → 중복제거 ${api.candidates.length})`
              : "검색 결과가 없습니다.",
          funnel,
        };
      }

      console.warn(
        "[neighborCollect] API keyword errors, falling back to CDP:",
        api.errors,
      );
    } catch (err) {
      console.warn(
        "[neighborCollect] API failed, falling back to CDP:",
        err instanceof Error ? err.message : err,
      );
    }
  } else {
    console.warn(
      "[neighborCollect] NAVER_CLIENT_ID/SECRET missing — CDP fallback",
    );
  }

  const cdp = await searchNeighborHitsViaCdpFallback({
    keywords,
    searchMax: targets.searchMax,
    delayMinSec: np.delay_min_sec,
    delayMaxSec: np.delay_max_sec,
  });

  const funnel = emptyPipelineFunnel({
    searchSource: "cdp_fallback",
    keywords,
    apiRawCount: cdp.rawItemCount,
    afterDedupe: cdp.hits.length,
    duplicatesRemoved: cdp.duplicatesRemoved,
  });
  logNeighborPipelineFunnel(funnel);

  return {
    ok: cdp.errors.length === 0 || cdp.hits.length > 0,
    keywords,
    hits: cdp.hits,
    searchSource: "cdp_fallback",
    remainingQuota,
    dailyQuota: np.daily_candidate_quota,
    searchMax: targets.searchMax,
    filterMax: targets.filterMax,
    errors: cdp.errors,
    message:
      cdp.hits.length > 0
        ? `검색 완료 (CDP · 원본 ${cdp.rawItemCount} → 중복제거 ${cdp.hits.length})`
        : "검색 결과가 없습니다.",
    funnel,
  };
}

/**
 * Phase 2 — hard filter + code score all passers, then keep top aiMax for AI.
 */
export async function filterNeighborCandidateHits(
  hits: DiscoverCandidate[],
  opts?: {
    remainingQuota?: number;
    searchSource?: NeighborCollectResult["searchSource"];
    filterMax?: number;
    aiAnalyzeMax?: number;
    /** Funnel from search phase */
    funnel?: NeighborPipelineFunnel;
  },
): Promise<NeighborFilterHitsResult> {
  const repos = createSupervisorRepos(createServiceClient());
  const workerRepos = createRepositories(createServiceClient());
  const policy = await repos.policy.get();
  const np = getNeighborPolicy(policy);
  const keywords = np.keywords;
  const todayCollected = await countNeighborCollectedToday();
  const remainingQuota =
    opts?.remainingQuota ??
    Math.max(0, np.daily_candidate_quota - todayCollected);
  const targets = neighborCollectTargets(
    remainingQuota > 0 ? remainingQuota : np.daily_candidate_quota,
    opts?.aiAnalyzeMax ?? np.ai_analyze_max,
  );
  const aiMax = opts?.aiAnalyzeMax ?? targets.aiMax;
  const filterMax = opts?.filterMax ?? aiMax;
  const searchSource = opts?.searchSource ?? "none";

  const excluded = await repos.neighborExclusion.list();
  const excludedIds = new Set(excluded.map((e) => e.blog_id.toLowerCase()));
  const already = await listExecutedNeighborBlogIds();

  const scoredPool: NeighborFilterHitsResult["toAnalyze"] = [];
  const reused: NeighborFilterHitsResult["reused"] = [];
  const seen = new Set<string>();
  const stats = {
    input: hits.length,
    excluded: 0,
    alreadyRequested: 0,
    alreadyAnalyzed: 0,
    codeRejected: 0,
    passed: 0,
  };

  const funnel = emptyPipelineFunnel({
    ...(opts?.funnel ?? {}),
    searchSource,
    keywords,
    afterDedupe: opts?.funnel?.afterDedupe ?? hits.length,
    filterInput: hits.length,
  });

  for (const c of hits) {
    const key = c.blogId.toLowerCase();
    if (seen.has(key)) {
      funnel.rejects.duplicate_blog_id += 1;
      continue;
    }
    seen.add(key);

    if (excludedIds.has(key)) {
      stats.excluded += 1;
      funnel.rejects.excluded += 1;
      continue;
    }
    if (already.has(key)) {
      stats.alreadyRequested += 1;
      funnel.rejects.already_requested += 1;
      continue;
    }

    const code = codeFilterNeighborCandidate(c, keywords);
    if (!code.pass) {
      stats.codeRejected += 1;
      const reason = code.rejectReason ?? "topic_mismatch";
      if (reason === "inactive") funnel.rejects.inactive += 1;
      else if (reason === "ad_heavy") funnel.rejects.ad_heavy += 1;
      else if (reason === "corporate") funnel.rejects.corporate += 1;
      else funnel.rejects.topic_mismatch += 1;
      continue;
    }

    stats.passed += 1;

    const existingId = await workerRepos.findPersonIdByBlogId(c.blogId);
    if (existingId) {
      const person = await repos.person.getById(existingId);
      const meta = person?.discover_meta ?? {};
      if (shouldReuseAiAnalysis(meta)) {
        stats.alreadyAnalyzed += 1;
        funnel.rejects.already_analyzed += 1;
        reused.push({
          candidate: c,
          filter: code,
          judgment: judgmentFromStoredMeta(c, meta),
        });
        continue;
      }
      if (isAlreadyAiAnalyzed(meta)) {
        stats.alreadyAnalyzed += 1;
      }
    }

    scoredPool.push({ candidate: c, filter: code });
  }

  // Code-score rank → only top aiMax go to AI
  scoredPool.sort(
    (a, b) =>
      (b.filter.codeScore ?? 0) - (a.filter.codeScore ?? 0) ||
      b.candidate.keywordRelevance - a.candidate.keywordRelevance,
  );
  const toAnalyze = scoredPool.slice(0, aiMax);
  const skippedByCap = Math.max(0, scoredPool.length - toAnalyze.length);
  funnel.rejects.filter_cap_skipped += skippedByCap;

  // Cap reused merge into final ranking later (prefer high stored scores)
  reused.sort(
    (a, b) => b.judgment.recommendScore - a.judgment.recommendScore,
  );
  const reusedCapped = reused.slice(0, Math.max(aiMax, filterMax));

  funnel.filterPassed = stats.passed;
  funnel.aiTarget = toAnalyze.length;
  funnel.aiReused = reusedCapped.length;
  logNeighborPipelineFunnel(funnel);

  return {
    ok: true,
    keywords,
    searchSource,
    remainingQuota,
    dailyQuota: np.daily_candidate_quota,
    filterMax: aiMax,
    toAnalyze,
    reused: reusedCapped,
    stats,
    errors: [],
    message: `1차 필터 ${stats.passed}명 → 코드점수 상위 AI ${toAnalyze.length}명 (재사용 ${reusedCapped.length})`,
    funnel,
    aiAnalyzeMax: aiMax,
  };
}

async function persistJudgedCandidates(input: {
  judged: Array<{
    candidate: DiscoverCandidate;
    filter: NeighborCodeFilterResult;
    judgment: NeighborAiJudgment;
  }>;
  remainingQuota: number;
  searchSource: NeighborCollectResult["searchSource"];
  keywords: string[];
  candidatesSeen: number;
  filteredCount: number;
  skippedExcluded: number;
  skippedFiltered: number;
  skippedExisting: number;
  skippedAlreadyAnalyzed: number;
  funnel: NeighborPipelineFunnel;
}): Promise<NeighborCollectResult> {
  const db = createServiceClient();
  const repos = createSupervisorRepos(db);
  const workerRepos = createRepositories(db);
  const todayCollected = await countNeighborCollectedToday();
  const remainingQuota = input.remainingQuota;
  const funnel = input.funnel;

  const result: NeighborCollectResult = {
    ok: true,
    added: 0,
    updated: 0,
    skippedExcluded: input.skippedExcluded,
    skippedFiltered: input.skippedFiltered,
    skippedExisting: input.skippedExisting,
    skippedAlreadyAnalyzed: input.skippedAlreadyAnalyzed,
    candidatesSeen: input.candidatesSeen,
    filteredCount: input.filteredCount,
    aiAnalyzedCount: funnel.aiAnalyzed,
    todayCollected,
    dailyQuota: (await getNeighborSettings()).daily_candidate_quota,
    remainingQuota,
    keywords: input.keywords,
    errors: [],
    message: "",
    searchSource: input.searchSource,
    funnel,
  };

  if (remainingQuota <= 0) {
    result.message = `오늘 후보 생성량(${result.dailyQuota}명)을 모두 채웠습니다.`;
    result.funnel = funnel;
    logNeighborPipelineFunnel(funnel);
    return result;
  }

  const ranked = [...input.judged].sort(
    (a, b) => b.judgment.recommendScore - a.judgment.recommendScore,
  );

  type Queued = (typeof ranked)[number] & { existingId: string | null };
  const queued: Queued[] = [];
  for (const item of ranked) {
    const existingId = await workerRepos.findPersonIdByBlogId(
      item.candidate.blogId,
    );
    queued.push({ ...item, existingId });
  }
  queued.sort((a, b) => {
    if (!!a.existingId !== !!b.existingId) return a.existingId ? 1 : -1;
    return b.judgment.recommendScore - a.judgment.recommendScore;
  });

  for (const { candidate: c, filter, judgment, existingId } of queued) {
    try {
      const meta = {
        blog_id: c.blogId,
        blog_url: c.url,
        nickname: c.blogName.slice(0, 80) || c.blogId,
        source: "neighbor_collect",
        collect_via: input.searchSource,
        collected_at: new Date().toISOString(),
        ai_analyzed: true,
        ai_analyzed_at: new Date().toISOString(),
        ai_source: judgment.source,
        topic_fit: judgment.topicFit,
        personal_feel: judgment.personalFeel,
        neighbor_worth: judgment.neighborWorth,
        keyword_relevance: c.keywordRelevance,
        keyword_match_rate: filter.keywordMatchRate,
        matched_keywords: c.matchedKeywords,
        recently_active: true,
        last_post_at: filter.lastPostAt ?? c.lastPostAt,
        date_text: c.dateText,
        primary_category: judgment.primaryCategory || filter.primaryCategory,
        category_hint: c.categoryHint,
        snippet: c.snippet,
        ad_score: filter.adScore,
        activity_score: judgment.activityScore ?? null,
        comment_potential: judgment.commentPotential ?? null,
        recommend_score: judgment.recommendScore,
        reasons: judgment.reasons,
        neighbor_excluded: false,
      };

      if (existingId) {
        const person = await repos.person.getById(existingId);
        if (person?.discover_meta?.verify === true) {
          result.skippedFiltered += 1;
          funnel.rejects.verify_skipped += 1;
          continue;
        }
        if (result.updated >= 20) {
          funnel.rejects.save_quota_skipped += 1;
          continue;
        }
        await repos.person.updateDiscoverMeta(existingId, meta);
        await workerRepos.updateRelationship(existingId, {
          score: judgment.recommendScore,
          temperature: 30,
        });
        result.updated += 1;
        funnel.rejects.updated_existing += 1;
        continue;
      }

      if (result.added >= remainingQuota) {
        funnel.rejects.save_quota_skipped += 1;
        continue;
      }

      const person = await workerRepos.createPerson({
        display_name: c.blogName.slice(0, 80) || c.blogId,
        discover_meta: meta,
      });
      await workerRepos.upsertBlogIdentity({
        person_id: person.id,
        blog_id: c.blogId,
        profile_snapshot: {
          url: c.url,
          name: c.blogName,
          snippet: c.snippet,
        },
      });
      await workerRepos.updateRelationship(person.id, {
        stage: "discover",
        score: judgment.recommendScore,
        temperature: 30,
      });
      const workflow = await workerRepos.createWorkflow({
        person_id: person.id,
        current_stage: "discover",
        current_state: "active",
        next_action: "visit",
        last_decision_id: null,
        priority: 35 + Math.min(40, Math.floor(judgment.recommendScore / 2)),
        goal: "neighbor_collect",
      });
      await workerRepos.setPersonActiveWorkflow(person.id, workflow.id);
      result.added += 1;
    } catch (err) {
      funnel.rejects.persist_error += 1;
      result.errors.push(
        `${c.blogId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  funnel.finalAdded = result.added;
  funnel.finalUpdated = result.updated;
  result.funnel = funnel;
  result.todayCollected = todayCollected + result.added;
  result.remainingQuota = Math.max(0, result.dailyQuota - result.todayCollected);
  logNeighborPipelineFunnel(funnel);

  if (result.added > 0) {
    result.message = `추천 후보 ${result.added}명이 추가되었습니다`;
  } else if (result.updated > 0) {
    result.message = `기존 후보 ${result.updated}명의 분석을 갱신했습니다. 새 추가는 없었습니다.`;
  } else if (result.errors.length > 0) {
    result.ok = false;
    result.message =
      input.searchSource === "api"
        ? "후보 저장 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요."
        : "후보를 찾는 중 오류가 발생했습니다. 네이버 로그인·CDP 연결을 확인해 주세요.";
  } else {
    result.message = "조건에 맞는 후보가 부족합니다.";
  }

  return result;
}

/**
 * Phase 3 — AI analyze filtered hits + save top by score (daily quota).
 */
export async function analyzeAndSaveNeighborCandidates(
  filterResult: NeighborFilterHitsResult,
): Promise<NeighborCollectResult> {
  const repos = createSupervisorRepos(createServiceClient());
  const np = getNeighborPolicy(await repos.policy.get());
  const aiRows = filterResult.toAnalyze.map(toNeighborAiRowInput);
  const ai = await analyzeNeighborCandidatesWithAi(
    aiRows,
    filterResult.keywords,
    {
      batchSize: np.ai_batch_size,
      concurrency: np.ai_concurrency,
    },
  );
  return finalizeNeighborCollectWithJudgments(filterResult, ai);
}

/** Analyze one AI batch for UI progress (slim payload). */
export async function analyzeNeighborAiBatch(input: {
  rows: NeighborAiRowInput[];
  keywords: string[];
  batchIndex?: number;
  batchTotal?: number;
  timeoutMs?: number;
}): Promise<{
  judgments: NeighborAiJudgment[];
  analyzed: number;
  rejected: number;
  failed: number;
  llmCount: number;
  heuristicCount: number;
  openaiRequests: number;
  openaiSuccess: number;
  openaiFail: number;
}> {
  console.log(
    "[neighbor-ai] action received",
    `batch=${input.batchIndex ?? "?"}/${input.batchTotal ?? "?"} size=${input.rows.length}`,
  );
  return analyzeNeighborAiBatchOnce(input.rows, input.keywords, {
    batchIndex: input.batchIndex,
    batchTotal: input.batchTotal,
    timeoutMs: input.timeoutMs,
  });
}

/** Persist after client-driven batched AI. */
export async function finalizeNeighborCollectWithJudgments(
  filterResult: NeighborFilterHitsResult,
  ai: {
    judgments: NeighborAiJudgment[];
    analyzed: number;
    rejected: number;
    failed?: number;
    openaiRequests?: number;
    openaiSuccess?: number;
    openaiFail?: number;
  },
): Promise<NeighborCollectResult> {
  const byId = new Map(ai.judgments.map((j) => [j.blogId.toLowerCase(), j]));

  const judged: Array<{
    candidate: DiscoverCandidate;
    filter: NeighborCodeFilterResult;
    judgment: NeighborAiJudgment;
  }> = [];

  for (const row of filterResult.toAnalyze) {
    const j = byId.get(row.candidate.blogId.toLowerCase());
    if (!j) continue;
    judged.push({ candidate: row.candidate, filter: row.filter, judgment: j });
  }
  for (const row of filterResult.reused) {
    judged.push({
      candidate: row.candidate,
      filter: row.filter,
      judgment: row.judgment,
    });
  }

  const funnel = emptyPipelineFunnel({
    ...filterResult.funnel,
    aiTarget: filterResult.toAnalyze.length,
    aiReused: filterResult.reused.length,
    aiAnalyzed: ai.analyzed,
    aiRejected: ai.rejected,
    aiOpenaiRequests: ai.openaiRequests ?? 0,
    aiOpenaiSuccess: ai.openaiSuccess ?? 0,
    aiOpenaiFail: ai.openaiFail ?? 0,
    rejects: {
      ...filterResult.funnel.rejects,
      ai_rejected: ai.rejected,
      ai_failed: ai.failed ?? 0,
    },
  });

  const result = await persistJudgedCandidates({
    judged,
    remainingQuota: filterResult.remainingQuota,
    searchSource: filterResult.searchSource,
    keywords: filterResult.keywords,
    candidatesSeen: filterResult.stats.input,
    filteredCount: filterResult.stats.passed,
    skippedExcluded: filterResult.stats.excluded,
    skippedFiltered: filterResult.stats.codeRejected,
    skippedExisting: filterResult.stats.alreadyRequested,
    skippedAlreadyAnalyzed: filterResult.stats.alreadyAnalyzed,
    funnel,
  });

  const success = Math.max(0, ai.analyzed - (ai.failed ?? 0));
  const failN = ai.failed ?? 0;
  const openaiReq = ai.openaiRequests ?? 0;
  const openaiOk = ai.openaiSuccess ?? 0;
  const openaiFail = ai.openaiFail ?? 0;
  const summaryBits = [
    `AI 분석 실행 ${ai.analyzed}명`,
    `AI 탈락 ${ai.rejected}명`,
    `OpenAI 요청 ${openaiReq}회(성공 ${openaiOk}/실패 ${openaiFail})`,
    `최종 추천 ${result.added}명`,
    `기존 갱신 ${result.updated}명`,
  ];
  if (failN > 0) {
    summaryBits.push(`배치 실패 보정 ${failN}명`);
  }
  if (result.added > 0 || result.updated > 0) {
    result.message = `${result.message} (${summaryBits.join(" · ")})`;
  } else if (ai.analyzed > 0) {
    result.message = `조건에 맞는 후보가 부족합니다. (성공 ${success} · 실패 ${failN} · 탈락 ${ai.rejected} · OpenAI ${openaiReq}회)`;
  }
  return result;
}

/**
 * Full pipeline: search → code filter → AI → save.
 */
export async function collectNeighborCandidates(): Promise<NeighborCollectResult> {
  const search = await searchNeighborCandidateHits();
  if (search.hits.length === 0) {
    const funnel = search.funnel;
    logNeighborPipelineFunnel(funnel);
    return {
      ok: search.ok,
      added: 0,
      updated: 0,
      skippedExcluded: 0,
      skippedFiltered: 0,
      skippedExisting: 0,
      skippedAlreadyAnalyzed: 0,
      candidatesSeen: 0,
      filteredCount: 0,
      aiAnalyzedCount: 0,
      todayCollected: await countNeighborCollectedToday(),
      dailyQuota: search.dailyQuota,
      remainingQuota: search.remainingQuota,
      keywords: search.keywords,
      errors: search.errors,
      message: search.message || "검색 결과가 없습니다.",
      searchSource: search.searchSource,
      funnel,
    };
  }

  const filtered = await filterNeighborCandidateHits(search.hits, {
    remainingQuota: search.remainingQuota,
    searchSource: search.searchSource,
    filterMax: search.filterMax,
    funnel: search.funnel,
  });

  const saved = await analyzeAndSaveNeighborCandidates(filtered);
  if (search.errors.length > 0) {
    saved.errors = [...search.errors, ...saved.errors];
  }
  return saved;
}
