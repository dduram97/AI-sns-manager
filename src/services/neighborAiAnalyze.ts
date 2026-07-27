import "server-only";

/**
 * AI neighbor candidate analysis — qualitative judgment only.
 * Batch + concurrency with hard timeouts and stage logs.
 */

import OpenAI from "openai";
import type { DiscoverCandidate } from "@/adapters/naver/NaverDiscoverAdapter";
import type { NeighborCodeFilterResult } from "./neighborCodeFilter";

export type NeighborAiJudgment = {
  blogId: string;
  topicFit: boolean;
  personalFeel: boolean;
  neighborWorth: boolean;
  recommendScore: number;
  reasons: string[];
  primaryCategory: string;
  source: "llm" | "heuristic";
  activityScore?: number;
  commentPotential?: number;
};

export type NeighborAiAnalyzeResult = {
  judgments: NeighborAiJudgment[];
  analyzed: number;
  rejected: number;
  failed: number;
  llmCount: number;
  heuristicCount: number;
  /** OpenAI HTTP calls attempted */
  openaiRequests: number;
  openaiSuccess: number;
  openaiFail: number;
};

/** Slim row for server actions (avoid shipping huge objects). */
export type NeighborAiRowInput = {
  candidate: {
    blogId: string;
    blogName: string;
    postTitle?: string | null;
    snippet: string;
    lastPostAt: string | null;
    dateText: string;
    keywordRelevance: number;
  };
  filter: NeighborCodeFilterResult;
};

const AI_REUSE_DAYS = 7;
const STALE_ACTIVITY_DAYS = 30;

export const NEIGHBOR_AI_BATCH_SIZE_DEFAULT = 10;
export const NEIGHBOR_AI_CONCURRENCY_DEFAULT = 2;
export const NEIGHBOR_AI_BATCH_TIMEOUT_MS_DEFAULT = 45_000;

function logAi(...args: unknown[]) {
  console.log("[neighbor-ai]", ...args);
}

export function daysSinceIso(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return (Date.now() - t) / 86_400_000;
}

export function getNeighborAiAnalysisStatus(
  meta: Record<string, unknown>,
): "fresh" | "stale" | "none" {
  if (meta.verify === true) return "none";
  if (meta.source !== "neighbor_collect") return "none";
  if (typeof meta.recommend_score !== "number") return "none";
  const analyzed =
    meta.ai_analyzed === true ||
    typeof meta.ai_analyzed_at === "string" ||
    (Array.isArray(meta.reasons) && meta.reasons.length > 0);
  if (!analyzed) return "none";

  const at =
    typeof meta.ai_analyzed_at === "string"
      ? meta.ai_analyzed_at
      : typeof meta.collected_at === "string"
        ? meta.collected_at
        : null;
  const age = daysSinceIso(at);
  if (age == null) return "stale";
  if (age <= AI_REUSE_DAYS) return "fresh";
  return "stale";
}

function activitySignals(c: NeighborAiRowInput["candidate"]): {
  activityDays: number | null;
  recent3m: boolean;
  stale30: boolean;
  activityScore: number;
} {
  const activityDays = daysSinceIso(c.lastPostAt);
  const recent3m = activityDays != null && activityDays <= 90;
  const stale30 = activityDays != null && activityDays > STALE_ACTIVITY_DAYS;
  let activityScore = 40;
  if (activityDays == null) activityScore = 35;
  else if (activityDays <= 7) activityScore = 95;
  else if (activityDays <= 14) activityScore = 85;
  else if (activityDays <= 30) activityScore = 75;
  else if (activityDays <= 90) activityScore = 55;
  else if (activityDays <= 180) activityScore = 35;
  else activityScore = 15;
  return { activityDays, recent3m, stale30, activityScore };
}

/**
 * Speed-first classifier model.
 * Prefer NEIGHBOR_AI_MODEL — do NOT inherit COMMENT_AI_MODEL (often slower).
 */
function neighborAiModel(): string {
  return process.env.NEIGHBOR_AI_MODEL?.trim() || "gpt-4o-mini";
}

function neighborAiTimeoutMs(override?: number): number {
  if (typeof override === "number" && override > 0) return override;
  return (
    Number(process.env.NEIGHBOR_AI_BATCH_TIMEOUT_MS) ||
    NEIGHBOR_AI_BATCH_TIMEOUT_MS_DEFAULT
  );
}

/** Fresh client per batch: hard timeout + no retries (retries caused multi-minute hangs). */
function openAiClient(timeoutMs: number): OpenAI | null {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    logAi("OPENAI_API_KEY missing — heuristic fallback");
    return null;
  }
  return new OpenAI({
    apiKey,
    baseURL: process.env.OPENAI_BASE_URL?.trim() || undefined,
    timeout: timeoutMs,
    maxRetries: 0,
  });
}

function hasCommentTrace(c: NeighborAiRowInput["candidate"]): boolean {
  return /댓글|공감|이웃|소통|답글|리플/.test(
    `${c.snippet} ${c.postTitle ?? ""} ${c.blogName}`,
  );
}

export function toNeighborAiRowInput(row: {
  candidate: DiscoverCandidate;
  filter: NeighborCodeFilterResult;
}): NeighborAiRowInput {
  return {
    candidate: {
      blogId: row.candidate.blogId,
      blogName: row.candidate.blogName,
      postTitle: row.candidate.postTitle ?? null,
      snippet: (row.candidate.snippet ?? "").slice(0, 80),
      lastPostAt: row.candidate.lastPostAt,
      dateText: row.candidate.dateText,
      keywordRelevance: row.candidate.keywordRelevance,
    },
    filter: row.filter,
  };
}

function compactAiPayload(batch: NeighborAiRowInput[]) {
  return batch.map(({ candidate: c, filter }) => {
    const act = activitySignals(c);
    const titles = [c.postTitle, c.blogName]
      .filter((t): t is string => Boolean(t && t.trim()))
      .map((t) => t.trim().slice(0, 60));
    return {
      blog_id: c.blogId,
      blog_name: c.blogName.slice(0, 40),
      category: filter.primaryCategory,
      last_post_at: c.lastPostAt
        ? c.lastPostAt.slice(0, 10)
        : c.dateText.slice(0, 16) || null,
      posts_last_3m: act.recent3m,
      days_since_last_post:
        act.activityDays != null ? Math.round(act.activityDays) : null,
      recent_titles: [...new Set(titles)].slice(0, 3),
      comment_active: hasCommentTrace(c),
      ad_ratio: filter.adScore,
      code_score: filter.codeScore ?? 0,
      keyword_match_rate: filter.keywordMatchRate,
    };
  });
}

function heuristicJudgment(
  c: NeighborAiRowInput["candidate"],
  filter: NeighborCodeFilterResult,
  keywords: string[],
): NeighborAiJudgment {
  const act = activitySignals(c);
  let score = 40;
  const reasons: string[] = [];

  if (filter.keywordMatchRate >= 40) {
    score += 14;
    reasons.push("맛집/일상/여행 등 주제 적합도 높음");
  } else if (filter.keywordMatchRate >= 20) {
    score += 7;
    reasons.push("관심 주제와 일부 겹침");
  }

  if (filter.adScore <= 15) {
    score += 12;
    reasons.push("개인 블로그 성향 · 광고성 낮음");
  } else if (filter.adScore <= 30) {
    score += 4;
  } else {
    score -= 8;
    reasons.push("광고성 콘텐츠 비중 주의");
  }

  score += Math.round(act.activityScore * 0.18);
  if (act.activityDays != null && act.activityDays <= 14) {
    reasons.push("최근 작성 빈도가 높음");
  } else if (act.recent3m) {
    reasons.push("최근 3개월 내 게시 활동 있음");
  }
  if (act.stale30) {
    score -= 18;
    reasons.push("최근 30일 이상 활동이 적어 점수 하향");
  }

  const commentPotential = act.stale30
    ? 25
    : Math.min(90, 40 + act.activityScore * 0.4 - filter.adScore * 0.2);
  if (hasCommentTrace(c) || commentPotential >= 60) {
    score += 8;
    reasons.push("댓글 달기 좋은 일상·후기 글 비율로 보임");
  }

  score += Math.min(8, Math.round((filter.codeScore ?? c.keywordRelevance) / 20));
  if (reasons.length < 2) {
    reasons.push(`${keywords[0] ?? "관심"} 관련 서로이웃 후보`);
  }

  const recommendScore = Math.max(0, Math.min(100, Math.round(score)));
  return {
    blogId: c.blogId,
    topicFit: filter.keywordMatchRate >= 25,
    personalFeel: filter.adScore <= 28,
    neighborWorth: recommendScore >= 50 && !act.stale30,
    recommendScore,
    reasons: reasons.slice(0, 5),
    primaryCategory: filter.primaryCategory,
    source: "heuristic",
    activityScore: act.activityScore,
    commentPotential: Math.round(commentPotential),
  };
}

type LlmItem = Record<string, unknown>;

function asReasonList(v: unknown): string[] {
  if (typeof v === "string" && v.trim()) return [v.trim()];
  if (!Array.isArray(v)) return [];
  return v
    .filter((r): r is string => typeof r === "string" && Boolean(r.trim()))
    .map((r) => r.trim())
    .slice(0, 5);
}

function parseLlmBatch(
  raw: string,
  expectedIds: string[],
): Map<string, NeighborAiJudgment> {
  const map = new Map<string, NeighborAiJudgment>();
  const expectedLower = new Map(
    expectedIds.map((id) => [id.toLowerCase(), id] as const),
  );
  try {
    const parsed = JSON.parse(raw) as { items?: LlmItem[] } | LlmItem[];
    const items = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.items)
        ? parsed.items
        : [];

    for (const item of items) {
      const rawId =
        typeof item.blog_id === "string"
          ? item.blog_id.trim()
          : typeof item.blogId === "string"
            ? item.blogId.trim()
            : "";
      const blogId = expectedLower.get(rawId.toLowerCase());
      if (!blogId) continue;

      const scoreRaw = item.score ?? item.recommend_score;
      const recommendScore =
        typeof scoreRaw === "number" && Number.isFinite(scoreRaw)
          ? Math.max(0, Math.min(100, Math.round(scoreRaw)))
          : 50;

      const isRecommended =
        item.is_recommended === true ||
        item.neighbor_worth === true ||
        (item.is_recommended !== false &&
          item.neighbor_worth !== false &&
          recommendScore >= 50);

      const reasons = asReasonList(item.reason ?? item.reasons);
      const category =
        typeof item.category === "string" && item.category.trim()
          ? item.category.trim()
          : typeof item.primary_category === "string" &&
              item.primary_category.trim()
            ? item.primary_category.trim()
            : "일상";

      map.set(blogId, {
        blogId,
        topicFit: item.topic_fit !== false,
        personalFeel: item.personal_feel !== false,
        neighborWorth: isRecommended,
        recommendScore,
        reasons:
          reasons.length > 0
            ? reasons
            : ["주제 적합도와 서로이웃 가치를 검토함"],
        primaryCategory: category,
        source: "llm",
      });
    }
  } catch (err) {
    logAi("JSON parse failed", err instanceof Error ? err.message : err);
  }
  return map;
}

/**
 * Hard timeout that returns immediately when time is up.
 * Late OpenAI results are ignored (detached) so the server action can finish.
 */
function runWithHardTimeout<T>(
  factory: (signal: AbortSignal) => Promise<T>,
  ms: number,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  const abort = new AbortController();
  let settled = false;

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        abort.abort();
      } catch {
        // ignore
      }
      logAi("timeout forced", `${ms}ms`);
      resolve({ ok: false, error: `openai timeout after ${ms}ms` });
    }, ms);

    factory(abort.signal)
      .then((value) => {
        if (settled) {
          logAi("late response ignored (already timed out)");
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve({ ok: true, value });
      })
      .catch((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  });
}

async function analyzeBatchViaLlm(
  batch: NeighborAiRowInput[],
  keywords: string[],
  timeoutMs: number,
  meta?: { batchIndex?: number; batchTotal?: number },
): Promise<{
  map: Map<string, NeighborAiJudgment>;
  failed: boolean;
  openaiRequest: boolean;
  openaiSuccess: boolean;
}> {
  const client = openAiClient(timeoutMs);
  if (!client) {
    return {
      map: new Map(),
      failed: true,
      openaiRequest: false,
      openaiSuccess: false,
    };
  }

  const model = neighborAiModel();
  const payload = compactAiPayload(batch);
  const expectedIds = batch.map((b) => b.candidate.blogId);
  const userContent = `keywords:${keywords.slice(0, 8).join(",")}\ncandidates:${JSON.stringify(payload)}`;
  const estimatedChars = userContent.length;

  logAi("payload", {
    batch: meta?.batchIndex ?? 1,
    batchTotal: meta?.batchTotal ?? 1,
    candidates: batch.length,
    estimated_chars: estimatedChars,
    model,
    timeoutMs,
  });

  logAi("request openai start", {
    model,
    size: batch.length,
    timeoutMs,
    maxRetries: 0,
  });

  const startedAt = Date.now();
  const raced = await runWithHardTimeout(async (signal) => {
    return client.chat.completions.create(
      {
        model,
        temperature: 0,
        max_completion_tokens: Math.min(1200, 60 + batch.length * 55),
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: [
              "네이버 블로그 서로이웃 추천 심사. 빠른 분류/점수만.",
              "장문 금지. reason은 한국어 짧은 1문장.",
              "30일+ 미활동이면 score 하향.",
              'JSON만: {"items":[{"blog_id":"id","score":85,"is_recommended":true,"reason":"짧은 이유","category":"맛집"}]}',
              `items 길이=${batch.length}`,
            ].join(" "),
          },
          { role: "user", content: userContent },
        ],
      },
      {
        signal,
        timeout: timeoutMs,
        maxRetries: 0,
      },
    );
  }, timeoutMs);

  if (!raced.ok) {
    logAi("request openai fail", raced.error, `elapsedMs=${Date.now() - startedAt}`);
    return {
      map: new Map(),
      failed: true,
      openaiRequest: true,
      openaiSuccess: false,
    };
  }

  const raw = raced.value.choices[0]?.message?.content ?? "";
  logAi(
    "response received",
    `chars=${raw.length}`,
    `elapsedMs=${Date.now() - startedAt}`,
  );

  logAi("parse start");
  const map = parseLlmBatch(raw, expectedIds);
  logAi("parse done", `${map.size}/${batch.length}`);

  if (map.size === 0) {
    logAi("parse empty — treating as fail");
    return {
      map,
      failed: true,
      openaiRequest: true,
      openaiSuccess: false,
    };
  }
  return {
    map,
    failed: false,
    openaiRequest: true,
    openaiSuccess: true,
  };
}

function finalizeRow(
  row: NeighborAiRowInput,
  fromLlm: NeighborAiJudgment | undefined,
  keywords: string[],
): {
  judgment: NeighborAiJudgment | null;
  rejected: boolean;
  llm: boolean;
  heuristic: boolean;
} {
  const act = activitySignals(row.candidate);
  if (fromLlm) {
    let judgment = fromLlm;
    if (act.stale30 && judgment.recommendScore > 55) {
      judgment = {
        ...judgment,
        recommendScore: Math.min(judgment.recommendScore, 55),
        reasons: [
          ...judgment.reasons.slice(0, 4),
          "최근 30일 이상 활동 부족으로 점수 조정",
        ].slice(0, 5),
      };
    }
    if (
      judgment.neighborWorth === false ||
      judgment.recommendScore < 50 ||
      (act.stale30 && judgment.recommendScore < 55)
    ) {
      return { judgment: null, rejected: true, llm: true, heuristic: false };
    }
    return {
      judgment: {
        ...judgment,
        primaryCategory:
          judgment.primaryCategory || row.filter.primaryCategory,
      },
      rejected: false,
      llm: true,
      heuristic: false,
    };
  }

  const h = heuristicJudgment(row.candidate, row.filter, keywords);
  if (h.neighborWorth && h.recommendScore >= 50) {
    return { judgment: h, rejected: false, llm: false, heuristic: true };
  }
  return { judgment: null, rejected: true, llm: false, heuristic: true };
}

/**
 * One OpenAI batch (default ≤10). Always returns (timeout → heuristic).
 */
export async function analyzeNeighborAiBatchOnce(
  rows: NeighborAiRowInput[],
  keywords: string[],
  opts?: { timeoutMs?: number; batchIndex?: number; batchTotal?: number },
): Promise<NeighborAiAnalyzeResult> {
  const batchIndex = opts?.batchIndex ?? 1;
  const batchTotal = opts?.batchTotal ?? 1;
  const timeoutMs = neighborAiTimeoutMs(opts?.timeoutMs);

  logAi(
    `batch start ${batchIndex}/${batchTotal} size=${rows.length} timeoutMs=${timeoutMs} model=${neighborAiModel()}`,
  );

  if (rows.length === 0) {
    return {
      judgments: [],
      analyzed: 0,
      rejected: 0,
      failed: 0,
      llmCount: 0,
      heuristicCount: 0,
      openaiRequests: 0,
      openaiSuccess: 0,
      openaiFail: 0,
    };
  }

  const { map, failed, openaiRequest, openaiSuccess } = await analyzeBatchViaLlm(
    rows,
    keywords,
    timeoutMs,
    { batchIndex, batchTotal },
  );

  logAi("save start");
  const judgments: NeighborAiJudgment[] = [];
  let rejected = 0;
  let llmCount = 0;
  let heuristicCount = 0;
  let failedCount = 0;

  for (const row of rows) {
    const fromLlm = map.get(row.candidate.blogId);
    if (!fromLlm) failedCount += 1;
    // Missing LLM row → finalizeRow falls back to heuristic (keeps pipeline moving)
    const fin = finalizeRow(row, fromLlm, keywords);
    if (fin.rejected) rejected += 1;
    if (fin.judgment) judgments.push(fin.judgment);
    if (fin.llm && fin.judgment) llmCount += 1;
    if (fin.heuristic) heuristicCount += 1;
  }

  judgments.sort((a, b) => b.recommendScore - a.recommendScore);
  logAi(
    `saved ${judgments.length} (rejected=${rejected} failedRows=${failedCount} heuristic=${heuristicCount})`,
  );

  return {
    judgments,
    analyzed: rows.length,
    rejected,
    failed: failed ? rows.length : failedCount,
    llmCount,
    heuristicCount,
    openaiRequests: openaiRequest ? 1 : 0,
    openaiSuccess: openaiSuccess ? 1 : 0,
    openaiFail: openaiRequest && !openaiSuccess ? 1 : 0,
  };
}

async function mapPoolSettled<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;

  const runners = Array.from(
    { length: Math.min(Math.max(1, concurrency), Math.max(1, items.length)) },
    async () => {
      for (;;) {
        const i = next;
        next += 1;
        if (i >= items.length) break;
        try {
          const value = await worker(items[i]!, i);
          results[i] = { status: "fulfilled", value };
        } catch (reason) {
          results[i] = { status: "rejected", reason };
        }
      }
    },
  );
  await Promise.all(runners);
  return results;
}

/**
 * Full list via chunk queue + limited concurrency (Promise workers, not one big Promise.all).
 */
export async function analyzeNeighborCandidatesWithAi(
  rows: NeighborAiRowInput[],
  keywords: string[],
  opts?: {
    batchSize?: number;
    concurrency?: number;
    timeoutMs?: number;
    onBatchDone?: (info: {
      done: number;
      total: number;
      batchIndex: number;
      batchTotal: number;
    }) => void;
  },
): Promise<NeighborAiAnalyzeResult> {
  const batchSize = opts?.batchSize ?? NEIGHBOR_AI_BATCH_SIZE_DEFAULT;
  const concurrency = opts?.concurrency ?? NEIGHBOR_AI_CONCURRENCY_DEFAULT;
  const timeoutMs = opts?.timeoutMs ?? NEIGHBOR_AI_BATCH_TIMEOUT_MS_DEFAULT;

  logAi(`candidates=${rows.length}`);

  const chunks: NeighborAiRowInput[][] = [];
  for (let i = 0; i < rows.length; i += batchSize) {
    chunks.push(rows.slice(i, i + batchSize));
  }
  const batchTotal = chunks.length;
  logAi(`batches=${batchTotal} size=${batchSize} concurrency=${concurrency}`);

  let done = 0;
  const settled = await mapPoolSettled(chunks, concurrency, async (chunk, idx) => {
    const result = await analyzeNeighborAiBatchOnce(chunk, keywords, {
      timeoutMs,
      batchIndex: idx + 1,
      batchTotal,
    });
    done += chunk.length;
    opts?.onBatchDone?.({
      done,
      total: rows.length,
      batchIndex: idx + 1,
      batchTotal,
    });
    return result;
  });

  const judgments: NeighborAiJudgment[] = [];
  let rejected = 0;
  let failed = 0;
  let llmCount = 0;
  let heuristicCount = 0;
  let openaiRequests = 0;
  let openaiSuccess = 0;
  let openaiFail = 0;
  let analyzed = 0;

  for (let i = 0; i < settled.length; i++) {
    const s = settled[i]!;
    const chunk = chunks[i]!;
    if (s.status === "fulfilled") {
      const r = s.value;
      judgments.push(...r.judgments);
      rejected += r.rejected;
      failed += r.failed;
      llmCount += r.llmCount;
      heuristicCount += r.heuristicCount;
      openaiRequests += r.openaiRequests;
      openaiSuccess += r.openaiSuccess;
      openaiFail += r.openaiFail;
      analyzed += r.analyzed;
    } else {
      logAi("batch worker rejected", s.reason);
      failed += chunk.length;
      analyzed += chunk.length;
      openaiRequests += 1;
      openaiFail += 1;
      for (const row of chunk) {
        const h = heuristicJudgment(row.candidate, row.filter, keywords);
        if (h.neighborWorth && h.recommendScore >= 50) {
          judgments.push(h);
          heuristicCount += 1;
        } else {
          rejected += 1;
        }
      }
    }
  }

  judgments.sort((a, b) => b.recommendScore - a.recommendScore);
  logAi("all batches done", {
    openaiRequests,
    openaiSuccess,
    openaiFail,
    judgments: judgments.length,
  });

  return {
    judgments,
    analyzed,
    rejected,
    failed,
    llmCount,
    heuristicCount,
    openaiRequests,
    openaiSuccess,
    openaiFail,
  };
}

export function neighborRecommendGrade(score: number): {
  emoji: string;
  label: string;
  tier: "hot" | "good" | "review" | "low";
} {
  if (score >= 90) return { emoji: "🔥", label: "적극 추천", tier: "hot" };
  if (score >= 70) return { emoji: "👍", label: "추천", tier: "good" };
  if (score >= 50) return { emoji: "👀", label: "검토 필요", tier: "review" };
  return { emoji: "", label: "", tier: "low" };
}
