/**
 * Neighbor feed — collect recent posts from mutual neighbors → comment/like Approvals.
 * Primary: public RSS (fast). CDP scrape only as capped fallback.
 * Reuses enqueueApproval / Approval Inbox. Does not change ActionJob execute.
 */

import "server-only";

import { NaverBlogAdapter } from "@/adapters/naver/NaverBlogAdapter";
import { fetchBlogRecentPostsViaRss } from "@/adapters/naver/naverBlogRss";
import type { NaverPostSnapshot } from "@/adapters/naver/posts";
import { sleep } from "@/adapters/naver/timing";
import {
  CDP_FALLBACK_MAX,
  emptyExcludes,
  FEED_REGISTER_CONCURRENCY,
  FEED_SCAN_BATCH_SIZE,
  mergeExcludes,
  RSS_CONCURRENCY,
  type NeighborFeedCandidateDto,
  type NeighborFeedCollectResult,
  type NeighborFeedExcludeCounts,
  type NeighborFeedPoolMember,
  type NeighborFeedPrepareResult,
  type NeighborFeedRegisterBatchResult,
  type NeighborFeedScanBatchResult,
} from "@/domain/neighbor/feedTypes";
import {
  getNeighborPolicy,
  neighborPolicyToWeeklyGoalsPatch,
  type NeighborPolicy,
} from "@/domain/policy/neighborPolicy";
import { parseNeighborRelationStatus } from "@/domain/neighbor/relationStatus";
import { parseNeighborSource } from "@/domain/neighbor/neighborSource";
import {
  parseNaverPostKeyFromUrl,
  postKeyFromTargetRef,
} from "@/lib/naverPostKey";
import { createServiceClient } from "@/lib/supabase";
import {
  createRepositories,
  createSupervisorRepos,
} from "@/repositories/index";
import {
  hasStoredNeighborRecords,
  reconcileAcceptedNeighborsForFeed,
} from "@/services/neighborAcceptedSync";
import { enqueueApproval } from "@/workers/approval";
import type { DecisionOutput, Workflow } from "@/workers/types";

export type {
  NeighborFeedCandidateDto,
  NeighborFeedCollectResult,
  NeighborFeedExcludeCounts,
  NeighborFeedPoolMember,
  NeighborFeedPrepareResult,
  NeighborFeedRegisterBatchResult,
  NeighborFeedScanBatchResult,
  NeighborFeedSourceStats,
} from "@/domain/neighbor/feedTypes";
export {
  CDP_FALLBACK_MAX,
  emptyExcludes,
  FEED_REGISTER_BATCH_SIZE,
  FEED_REGISTER_CONCURRENCY,
  FEED_SCAN_BATCH_SIZE,
  mergeExcludes,
  RSS_CONCURRENCY,
  sumExcludes,
} from "@/domain/neighbor/feedTypes";

function startOfKstDayIso(): string {
  const KST = 9 * 60 * 60 * 1000;
  const now = new Date();
  const kst = new Date(now.getTime() + KST);
  const y = kst.getUTCFullYear();
  const m = kst.getUTCMonth();
  const d = kst.getUTCDate();
  return new Date(Date.UTC(y, m, d) - KST).toISOString();
}

function postAgeDays(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return (Date.now() - t) / 86_400_000;
}

function isInFeedPool(
  meta: Record<string, unknown>,
  stage: string,
): boolean {
  if (meta.verify === true) return false;
  if (meta.neighbor_excluded === true) return false;

  const status = parseNeighborRelationStatus(meta);
  const source = parseNeighborSource(meta);

  // Primary: accepted neighbors (existing_sync / neighbor_request / manual / unset)
  if (status === "accepted") {
    if (
      source == null ||
      source === "existing_sync" ||
      source === "neighbor_request" ||
      source === "manual"
    ) {
      return true;
    }
  }

  // Relationship tiers: include when accepted, or legacy rows without status yet
  if (
    stage === "maintain" ||
    stage === "vip" ||
    stage === "early_relationship"
  ) {
    if (status === "accepted" || status == null) return true;
  }

  return false;
}

function activityScoreFromMeta(meta: Record<string, unknown>): number {
  let score = 40;
  if (typeof meta.recommend_score === "number") {
    score = Math.max(0, Math.min(100, Math.round(meta.recommend_score)));
  }
  if (meta.comment_active === true || meta.has_comments === true) score += 10;
  return Math.max(0, Math.min(100, score));
}

export async function listNeighborFeedPool(opts?: {
  /**
   * When true (default for collect), run light accepted reconcile first.
   * Status/UI polls should pass false to avoid heavy work on every load.
   */
  reconcile?: boolean;
}): Promise<NeighborFeedPoolMember[]> {
  const shouldReconcile = opts?.reconcile === true;
  if (shouldReconcile) {
    try {
      await reconcileAcceptedNeighborsForFeed();
    } catch (err) {
      console.error("[neighbor-sync-error]", {
        where: "listNeighborFeedPool.reconcile",
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    }
  }

  try {
    const repos = createSupervisorRepos(createServiceClient());
    const excluded = await repos.neighborExclusion.list();
    const excludedIds = new Set(excluded.map((e) => e.blog_id.toLowerCase()));
    const rows = await repos.person.listCrmRows();
    const out: NeighborFeedPoolMember[] = [];

    for (const row of rows) {
      const meta = row.person.discover_meta ?? {};
      if (!isInFeedPool(meta, row.relationship.stage)) continue;
      const blogId =
        typeof meta.blog_id === "string" ? meta.blog_id.trim() : "";
      if (!blogId) continue;
      if (excludedIds.has(blogId.toLowerCase())) continue;

      out.push({
        personId: row.person.id,
        blogId,
        blogName: row.person.display_name,
        blogUrl:
          typeof meta.blog_url === "string"
            ? meta.blog_url
            : `https://m.blog.naver.com/${blogId}`,
        acceptedAt:
          typeof meta.neighbor_accepted_at === "string"
            ? meta.neighbor_accepted_at
            : typeof meta.neighbor_requested_at === "string"
              ? meta.neighbor_requested_at
              : null,
        activityScore: activityScoreFromMeta(meta),
      });
    }

    return out;
  } catch (err) {
    console.error("[neighbor-sync-error]", {
      where: "listNeighborFeedPool",
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    throw new Error(
      "이웃 정보를 불러오는 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.",
    );
  }
}

async function loadHandledPostKeys(): Promise<Set<string>> {
  const repos = createSupervisorRepos(createServiceClient());
  const keys = new Set<string>();

  const executed = await repos.approval.listRecentExecutedCommentLike(1200);
  for (const job of executed) {
    const k = postKeyFromTargetRef(job.target_ref);
    if (k) keys.add(k);
  }

  const open = await repos.approval.listOpenInbox();
  for (const item of open) {
    if (
      item.job.action_type === "comment" ||
      item.job.action_type === "like"
    ) {
      const k = postKeyFromTargetRef(item.job.target_ref);
      if (k) keys.add(k);
    }
  }

  return keys;
}

async function loadTodayFeedBlogCounts(): Promise<Map<string, number>> {
  const db = createServiceClient();
  const since = startOfKstDayIso();
  const { data, error } = await db
    .from("action_jobs")
    .select("target_ref")
    .eq("action_type", "comment")
    .gte("created_at", since)
    .limit(500);
  if (error) throw new Error(`loadTodayFeedBlogCounts: ${error.message}`);

  const map = new Map<string, number>();
  for (const row of data ?? []) {
    const ref = (row as { target_ref?: Record<string, unknown> }).target_ref;
    if (!ref || ref.source !== "neighbor_feed") continue;
    const blog =
      typeof ref.blog_id === "string" ? ref.blog_id.toLowerCase() : null;
    if (!blog) continue;
    map.set(blog, (map.get(blog) ?? 0) + 1);
  }
  return map;
}

type FeedCandidate = {
  member: NeighborFeedPoolMember;
  post: NaverPostSnapshot;
  postKey: string;
  publishedAt: string;
};

async function fetchPostsForBlog(
  blogId: string,
  allowCdp: boolean,
): Promise<{
  posts: NaverPostSnapshot[];
  source: "rss" | "cdp" | "fail";
}> {
  try {
    const rss = await fetchBlogRecentPostsViaRss(blogId, 5);
    if (rss.length > 0) return { posts: rss, source: "rss" };
  } catch {
    // fall through
  }

  if (!allowCdp) return { posts: [], source: "fail" };

  try {
    const adapter = new NaverBlogAdapter();
    const posts = await adapter.fetchLatestPosts(blogId, 5);
    if (posts.length > 0) return { posts, source: "cdp" };
    return { posts: [], source: "fail" };
  } catch {
    return { posts: [], source: "fail" };
  }
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, Math.max(1, items.length)) },
    async () => {
      for (;;) {
        const i = next;
        next += 1;
        if (i >= items.length) break;
        results[i] = await worker(items[i]!, i);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

function ingestPostsForMember(
  member: NeighborFeedPoolMember,
  posts: NaverPostSnapshot[],
  lookback: number,
  handled: Set<string>,
  perBlogLatest: Map<string, FeedCandidate>,
  excluded: NeighborFeedExcludeCounts,
): number {
  let postsSeen = 0;
  if (posts.length === 0) {
    excluded.scrape_empty += 1;
    return 0;
  }
  for (const post of posts) {
    postsSeen += 1;
    const age = postAgeDays(post.publishedAt);
    if (age == null || age > lookback) {
      excluded.too_old += 1;
      continue;
    }
    const postKey =
      postKeyFromTargetRef({
        blog_id: post.blogId,
        log_no: post.logNo,
        post_url: post.postUrl,
      }) ?? parseNaverPostKeyFromUrl(post.postUrl);
    if (!postKey) {
      excluded.scrape_error += 1;
      continue;
    }
    if (handled.has(postKey)) {
      excluded.already_handled += 1;
      continue;
    }

    const blogKey = member.blogId.toLowerCase();
    const prev = perBlogLatest.get(blogKey);
    const publishedAt = post.publishedAt ?? new Date(0).toISOString();
    if (
      !prev ||
      new Date(publishedAt).getTime() > new Date(prev.publishedAt).getTime()
    ) {
      if (prev) excluded.duplicate_blog += 1;
      perBlogLatest.set(blogKey, {
        member,
        post,
        postKey,
        publishedAt,
      });
    } else {
      excluded.duplicate_blog += 1;
    }
  }
  return postsSeen;
}

async function createFeedCommentApproval(
  candidate: FeedCandidate,
): Promise<{ ok: boolean; approvalId?: string }> {
  const db = createServiceClient();
  const workerRepos = createRepositories(db);
  const { member, post } = candidate;

  let workflow = (await workerRepos.getActiveWorkflow(
    member.personId,
  )) as Workflow | null;
  if (!workflow) {
    workflow = (await workerRepos.createWorkflow({
      person_id: member.personId,
      current_stage: "early_relationship",
      current_state: "active",
      next_action: "comment",
      last_decision_id: null,
      priority: 80,
      goal: "neighbor_feed",
    })) as Workflow;
    await workerRepos.setPersonActiveWorkflow(member.personId, workflow.id);
  } else if (
    workflow.current_stage === "discover" ||
    workflow.current_stage === "warming"
  ) {
    await workerRepos.updateWorkflow(workflow.id, {
      current_stage: "early_relationship",
      next_action: "comment",
      blocked_reason: null,
    });
    workflow = {
      ...workflow,
      current_stage: "early_relationship",
      next_action: "comment",
    };
  }

  const reasonShort = "이웃 새글 · 댓글/공감 후보";
  const record = await workerRepos.insertDecision({
    person_id: member.personId,
    workflow_id: workflow.id,
    perception_event_id: null,
    decision_type: "create_approval",
    reason_short: reasonShort,
    reason_detail: {
      explanation: "서로이웃 새글 수집",
      reasons: ["최근 3일 이내 새글", "최신 글 1개"],
      rule_ids: ["ui.neighbor_feed"],
    },
    inputs: { source: "neighbor_feed" },
  });

  const output: Extract<DecisionOutput, { kind: "create_approval" }> = {
    kind: "create_approval",
    reason_short: reasonShort,
    explanation: "서로이웃 새글 수집에서 생성된 댓글/공감 후보",
    reasons: ["최근 게시글", "서로이웃 대상"],
    rule_ids: ["ui.neighbor_feed"],
    workflow_patch: {
      next_action: "none",
      blocked_reason: null,
    },
    draft: {
      action_type: "comment",
      channel: "blog",
      body: "포스팅 잘 보고 갑니다.",
      alternatives: [],
      target_ref: {
        blog_id: post.blogId,
        log_no: post.logNo,
        post_id: post.logNo,
        post_url: post.postUrl,
        title: post.title,
        content_summary: post.contentSummary,
        content_excerpt: (post.contentRaw || post.contentSummary).slice(0, 500),
        published_at: post.publishedAt,
        source: "neighbor_feed",
        neighbor_feed: true,
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

export async function scanNeighborFeedBatch(input: {
  members: NeighborFeedPoolMember[];
  cdpBudget: number;
  handledKeys?: string[];
}): Promise<NeighborFeedScanBatchResult> {
  const repos = createSupervisorRepos(createServiceClient());
  const np = getNeighborPolicy(await repos.policy.get());
  const lookback = np.feed_lookback_days;
  const perNeighbor = np.feed_max_per_neighbor_day;
  const excluded = emptyExcludes();
  const handled = new Set(
    input.handledKeys?.length
      ? input.handledKeys
      : [...(await loadHandledPostKeys())],
  );
  const todayBlogCounts = await loadTodayFeedBlogCounts();
  const perBlogLatest = new Map<string, FeedCandidate>();
  const sourceStats = { rss: 0, cdp: 0, fail: 0 };
  let postsSeen = 0;
  let cdpLeft = Math.max(0, input.cdpBudget);

  const members = input.members;
  const eligible: NeighborFeedPoolMember[] = [];
  for (const member of members) {
    const alreadyToday = todayBlogCounts.get(member.blogId.toLowerCase()) ?? 0;
    if (alreadyToday >= perNeighbor) {
      excluded.per_neighbor_cap += 1;
      continue;
    }
    eligible.push(member);
  }

  const rssResults = await mapPool(
    eligible,
    RSS_CONCURRENCY,
    async (member) => {
      const { posts, source } = await fetchPostsForBlog(member.blogId, false);
      return { member, posts, source };
    },
  );

  const needCdp: NeighborFeedPoolMember[] = [];
  for (const row of rssResults) {
    if (row.source === "rss" && row.posts.length > 0) {
      sourceStats.rss += 1;
      postsSeen += ingestPostsForMember(
        row.member,
        row.posts,
        lookback,
        handled,
        perBlogLatest,
        excluded,
      );
    } else {
      needCdp.push(row.member);
    }
  }

  for (const member of needCdp) {
    if (cdpLeft <= 0) {
      sourceStats.fail += 1;
      excluded.scrape_empty += 1;
      continue;
    }
    cdpLeft -= 1;
    const { posts, source } = await fetchPostsForBlog(member.blogId, true);
    if (source === "cdp" && posts.length > 0) {
      sourceStats.cdp += 1;
      postsSeen += ingestPostsForMember(
        member,
        posts,
        lookback,
        handled,
        perBlogLatest,
        excluded,
      );
      await sleep(400);
    } else {
      sourceStats.fail += 1;
      excluded.scrape_empty += 1;
    }
  }

  const candidates = [...perBlogLatest.values()].map((c) => ({
    personId: c.member.personId,
    blogId: c.member.blogId,
    blogName: c.member.blogName,
    acceptedAt: c.member.acceptedAt,
    activityScore: c.member.activityScore,
    post: c.post,
    postKey: c.postKey,
    publishedAt: c.publishedAt,
  }));

  return {
    checked: members.length,
    postsSeen,
    recentFound: candidates.length,
    excluded,
    sourceStats,
    candidates,
  };
}

export async function prepareNeighborFeedCollect(input: {
  candidates: NeighborFeedScanBatchResult["candidates"];
  poolSize: number;
  postsSeen: number;
  excluded: NeighborFeedExcludeCounts;
  sourceStats: { rss: number; cdp: number; fail: number };
}): Promise<NeighborFeedPrepareResult> {
  const repos = createSupervisorRepos(createServiceClient());
  const np = getNeighborPolicy(await repos.policy.get());
  const maxDay = np.feed_max_collect_day;
  const excluded = { ...input.excluded };
  const handled = await loadHandledPostKeys();

  let duplicateExcluded = 0;
  let candidates = input.candidates.filter((c) => {
    if (handled.has(c.postKey)) {
      excluded.already_handled += 1;
      duplicateExcluded += 1;
      return false;
    }
    return true;
  });

  const byBlog = new Map<string, NeighborFeedCandidateDto>();
  for (const c of candidates) {
    const key = c.blogId.toLowerCase();
    const prev = byBlog.get(key);
    if (
      !prev ||
      new Date(c.publishedAt).getTime() > new Date(prev.publishedAt).getTime()
    ) {
      if (prev) {
        excluded.duplicate_blog += 1;
        duplicateExcluded += 1;
      }
      byBlog.set(key, c);
    } else {
      excluded.duplicate_blog += 1;
      duplicateExcluded += 1;
    }
  }
  candidates = [...byBlog.values()];
  candidates.sort((a, b) => {
    const ta = new Date(a.publishedAt).getTime();
    const tb = new Date(b.publishedAt).getTime();
    if (tb !== ta) return tb - ta;
    const aa = a.acceptedAt ? new Date(a.acceptedAt).getTime() : 0;
    const ba = b.acceptedAt ? new Date(b.acceptedAt).getTime() : 0;
    if (ba !== aa) return ba - aa;
    return b.activityScore - a.activityScore;
  });

  const recentFound = candidates.length;
  if (candidates.length > maxDay) {
    excluded.daily_cap += candidates.length - maxDay;
    candidates = candidates.slice(0, maxDay);
  }

  return {
    toCreate: candidates,
    excluded,
    recentFound,
    poolSize: input.poolSize,
    postsSeen: input.postsSeen,
    sourceStats: input.sourceStats,
    duplicateExcluded,
  };
}

export async function registerNeighborFeedApprovalsBatch(input: {
  candidates: NeighborFeedCandidateDto[];
}): Promise<NeighborFeedRegisterBatchResult> {
  const handled = await loadHandledPostKeys();
  const out: NeighborFeedRegisterBatchResult = {
    processed: 0,
    created: 0,
    failed: 0,
    skippedDuplicate: 0,
    lastBlogName: null,
    lastTitle: null,
  };

  const toRun: FeedCandidate[] = [];
  for (const c of input.candidates) {
    if (handled.has(c.postKey)) {
      out.skippedDuplicate += 1;
      out.processed += 1;
      continue;
    }
    toRun.push({
      member: {
        personId: c.personId,
        blogId: c.blogId,
        blogName: c.blogName,
        blogUrl: `https://m.blog.naver.com/${c.blogId}`,
        acceptedAt: c.acceptedAt,
        activityScore: c.activityScore,
      },
      post: c.post,
      postKey: c.postKey,
      publishedAt: c.publishedAt,
    });
  }

  const results = await mapPool(
    toRun,
    FEED_REGISTER_CONCURRENCY,
    async (c) => {
      try {
        const created = await createFeedCommentApproval(c);
        return {
          ok: created.ok,
          blogName: c.member.blogName,
          title: c.post.title,
          postKey: c.postKey,
        };
      } catch {
        return {
          ok: false,
          blogName: c.member.blogName,
          title: c.post.title,
          postKey: c.postKey,
        };
      }
    },
  );

  for (const r of results) {
    out.processed += 1;
    out.lastBlogName = r.blogName;
    out.lastTitle = r.title;
    if (r.ok) {
      out.created += 1;
      handled.add(r.postKey);
    } else {
      out.failed += 1;
    }
  }

  return out;
}

/** Confirm neighbor_feed rows land in the shared Approval Inbox. */
export async function logNeighborFeedApprovalsCreated(
  created: number,
): Promise<{ openTotal: number; neighborFeedOpen: number }> {
  console.info(`neighbor_feed approvals created: ${created}`);
  const repos = createSupervisorRepos(createServiceClient());
  const items = await repos.approval.listOpenInbox();
  const neighborFeedOpen = items.filter((i) => i.source === "neighbor_feed")
    .length;
  console.info("neighbor_feed Inbox (neighbors tab): included: true");
  console.info(`표시 개수: ${neighborFeedOpen}`);
  return { openTotal: items.length, neighborFeedOpen };
}

export async function stampNeighborFeedCollectAt(): Promise<string> {
  const repos = createSupervisorRepos(createServiceClient());
  const policy = await repos.policy.get();
  const lastCollectAt = new Date().toISOString();
  const weekly = neighborPolicyToWeeklyGoalsPatch(
    { feed_last_collect_at: lastCollectAt } satisfies Partial<NeighborPolicy>,
    policy.weekly_goals ?? {},
  );
  await repos.policy.update({ weekly_goals: weekly });
  return lastCollectAt;
}

export async function finalizeNeighborFeedCollect(input: {
  candidates: NeighborFeedScanBatchResult["candidates"];
  poolSize: number;
  postsSeen: number;
  excluded: NeighborFeedExcludeCounts;
  sourceStats: { rss: number; cdp: number; fail: number };
}): Promise<NeighborFeedCollectResult> {
  const prepared = await prepareNeighborFeedCollect(input);
  let created = 0;
  let failed = 0;
  let skippedDup = 0;

  for (
    let i = 0;
    i < prepared.toCreate.length;
    i += FEED_REGISTER_CONCURRENCY * 2
  ) {
    const chunk = prepared.toCreate.slice(
      i,
      i + FEED_REGISTER_CONCURRENCY * 2,
    );
    const batch = await registerNeighborFeedApprovalsBatch({
      candidates: chunk,
    });
    created += batch.created;
    failed += batch.failed;
    skippedDup += batch.skippedDuplicate;
  }

  const lastCollectAt = await stampNeighborFeedCollectAt();
  const excluded = { ...prepared.excluded };
  excluded.create_failed += failed;
  excluded.already_handled += skippedDup;

  await logNeighborFeedApprovalsCreated(created);

  return {
    ok: true,
    message:
      created > 0
        ? `이웃 새글 ${created}건을 이웃 새글 목록에 추가했습니다.`
        : "조건에 맞는 새글이 없습니다.",
    lastCollectAt,
    poolSize: prepared.poolSize,
    postsSeen: prepared.postsSeen,
    recentFound: prepared.recentFound,
    excluded,
    finalCount: created,
    approvalsCreated: created,
    duplicateExcluded: prepared.duplicateExcluded + skippedDup,
    createFailed: failed,
    sourceStats: prepared.sourceStats,
  };
}

export async function collectNeighborFeed(): Promise<NeighborFeedCollectResult> {
  const pool = await listNeighborFeedPool({ reconcile: true });
  const handled = await loadHandledPostKeys();
  let postsSeen = 0;
  let excluded = emptyExcludes();
  const sourceStats = { rss: 0, cdp: 0, fail: 0 };
  const allCandidates: NeighborFeedScanBatchResult["candidates"] = [];
  let cdpBudget = CDP_FALLBACK_MAX;

  for (let i = 0; i < pool.length; i += FEED_SCAN_BATCH_SIZE) {
    const chunk = pool.slice(i, i + FEED_SCAN_BATCH_SIZE);
    const scan = await scanNeighborFeedBatch({
      members: chunk,
      cdpBudget,
      handledKeys: [...handled],
    });
    cdpBudget = Math.max(0, cdpBudget - scan.sourceStats.cdp);
    postsSeen += scan.postsSeen;
    excluded = mergeExcludes(excluded, scan.excluded);
    sourceStats.rss += scan.sourceStats.rss;
    sourceStats.cdp += scan.sourceStats.cdp;
    sourceStats.fail += scan.sourceStats.fail;
    allCandidates.push(...scan.candidates);
    for (const c of scan.candidates) handled.add(c.postKey);
  }

  return finalizeNeighborFeedCollect({
    candidates: allCandidates,
    poolSize: pool.length,
    postsSeen,
    excluded,
    sourceStats,
  });
}

export async function getNeighborFeedStatus(): Promise<{
  poolSize: number;
  lastCollectAt: string | null;
  lookbackDays: number;
  maxPerNeighborDay: number;
  maxCollectDay: number;
  collectMode: NeighborPolicy["feed_collect_mode"];
  collectHour: number;
  /** False when DB has no neighbor-like records (first-time user). */
  hasNeighborRecords: boolean;
  feedAiAutoCount: NeighborPolicy["feed_ai_auto_count"];
}> {
  try {
    const repos = createSupervisorRepos(createServiceClient());
    const np = getNeighborPolicy(await repos.policy.get());
    // Status poll: no reconcile (collect path reconciles explicitly)
    const [pool, hasNeighborRecords] = await Promise.all([
      listNeighborFeedPool({ reconcile: false }),
      hasStoredNeighborRecords(),
    ]);
    return {
      poolSize: pool.length,
      lastCollectAt: np.feed_last_collect_at,
      lookbackDays: np.feed_lookback_days,
      maxPerNeighborDay: np.feed_max_per_neighbor_day,
      maxCollectDay: np.feed_max_collect_day,
      collectMode: np.feed_collect_mode,
      collectHour: np.feed_collect_hour,
      hasNeighborRecords,
      feedAiAutoCount: np.feed_ai_auto_count,
    };
  } catch (err) {
    console.error("[neighbor-sync-error]", {
      where: "getNeighborFeedStatus",
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    throw new Error(
      "이웃 정보를 불러오는 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.",
    );
  }
}
