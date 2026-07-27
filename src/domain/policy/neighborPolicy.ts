import type { PolicyProfile } from "../../workers/types";

import type { NeighborStatusCheckMode } from "../neighbor/relationStatus";

/**
 * Neighbor (서로이웃) policy — stored in weekly_goals.neighbor_policy (no schema change).
 * daily_limits.neighbor_request remains the hard daily execute cap.
 */

export interface NeighborPolicy {
  /** Keywords / topics for candidate ranking */
  keywords: string[];
  /** Max candidates to show / generate target per day */
  daily_candidate_quota: number;
  /** Max candidates sent to AI after code scoring (default 50) */
  ai_analyze_max: number;
  /** Candidates per OpenAI request (10–20) */
  ai_batch_size: number;
  /** Parallel OpenAI batch workers (1–3) */
  ai_concurrency: number;
  /** Default mutual request message (not AI-generated) */
  message: string;
  /** Batch UI delay defaults (seconds) */
  delay_min_sec: number;
  delay_max_sec: number;
  /**
   * How often to re-check pending mutual-neighbor acceptance via CDP.
   */
  status_check_mode: NeighborStatusCheckMode;
  /** Last auto status-check run (ISO) */
  status_last_check_at: string | null;
  /** Neighbor feed: only posts within N days */
  feed_lookback_days: number;
  /** Max posts shown per neighbor per day (default 1) */
  feed_max_per_neighbor_day: number;
  /** Max feed posts collected per day (default 50) */
  feed_max_collect_day: number;
  /** Last neighbor-feed collect run (ISO) */
  feed_last_collect_at: string | null;
  /**
   * Auto-collect schedule (Agent Tick / Vercel cron).
   * manual | daily_1 | daily_2 | daily_4
   */
  feed_collect_mode: "manual" | "daily_1" | "daily_2" | "daily_4";
  /** KST hour 0–23 for first daily slot (default 9) */
  feed_collect_hour: number;
  /**
   * How many visible neighbor-feed cards auto-draft on page entry.
   * 5 | 10 | 20 — never the full neighbor pool / full page unless set to 20.
   */
  feed_ai_auto_count: 5 | 10 | 20;
}

export const DEFAULT_NEIGHBOR_KEYWORDS = [
  "맛집",
  "일상",
  "여행",
  "카페",
  "취미",
] as const;

export const DEFAULT_NEIGHBOR_MESSAGE =
  "안녕하세요😊 좋은 글 잘 보고 갑니다.\n앞으로 좋은 정보 함께 나누고 싶어 서로이웃 신청드립니다.";

const DEFAULTS: NeighborPolicy = {
  keywords: [...DEFAULT_NEIGHBOR_KEYWORDS],
  daily_candidate_quota: 30,
  ai_analyze_max: 60,
  ai_batch_size: 10,
  ai_concurrency: 2,
  message: DEFAULT_NEIGHBOR_MESSAGE,
  delay_min_sec: 5,
  delay_max_sec: 10,
  status_check_mode: "daily_1",
  status_last_check_at: null,
  feed_lookback_days: 3,
  feed_max_per_neighbor_day: 1,
  feed_max_collect_day: 50,
  feed_last_collect_at: null,
  feed_collect_mode: "daily_1",
  feed_collect_hour: 9,
  feed_ai_auto_count: 5,
};

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function getNeighborPolicy(policy: PolicyProfile): NeighborPolicy {
  const goals = policy.weekly_goals ?? {};
  const nested =
    goals.neighbor_policy && typeof goals.neighbor_policy === "object"
      ? (goals.neighbor_policy as Record<string, unknown>)
      : {};

  const keywords = asStringArray(nested.keywords);
  const quotaRaw = nested.daily_candidate_quota;
  const aiMaxRaw = nested.ai_analyze_max;
  const batchSizeRaw = nested.ai_batch_size;
  const concurrencyRaw = nested.ai_concurrency;
  const delayMin = nested.delay_min_sec;
  const delayMax = nested.delay_max_sec;
  const message =
    typeof nested.message === "string" && nested.message.trim()
      ? nested.message.trim()
      : DEFAULTS.message;

  const daily_candidate_quota =
    typeof quotaRaw === "number" && quotaRaw > 0
      ? Math.min(100, Math.floor(quotaRaw))
      : DEFAULTS.daily_candidate_quota;

  const ai_analyze_max =
    typeof aiMaxRaw === "number" && aiMaxRaw > 0
      ? Math.min(100, Math.max(5, Math.floor(aiMaxRaw)))
      : Math.min(100, Math.max(10, daily_candidate_quota * 2));

  const ai_batch_size =
    typeof batchSizeRaw === "number" && batchSizeRaw > 0
      ? Math.min(20, Math.max(5, Math.floor(batchSizeRaw)))
      : DEFAULTS.ai_batch_size;

  const ai_concurrency =
    typeof concurrencyRaw === "number" && concurrencyRaw > 0
      ? Math.min(3, Math.max(1, Math.floor(concurrencyRaw)))
      : DEFAULTS.ai_concurrency;

  const delay_min_sec =
    typeof delayMin === "number" && delayMin >= 0
      ? Math.floor(delayMin)
      : DEFAULTS.delay_min_sec;
  const delay_max_sec =
    typeof delayMax === "number" && delayMax >= delay_min_sec
      ? Math.floor(delayMax)
      : Math.max(delay_min_sec, DEFAULTS.delay_max_sec);

  const checkModeRaw = nested.status_check_mode;
  const status_check_mode: NeighborStatusCheckMode =
    checkModeRaw === "daily_1" ||
    checkModeRaw === "daily_2" ||
    checkModeRaw === "manual"
      ? checkModeRaw
      : DEFAULTS.status_check_mode;

  const status_last_check_at =
    typeof nested.status_last_check_at === "string" &&
    nested.status_last_check_at.trim()
      ? nested.status_last_check_at.trim()
      : null;

  const lookbackRaw = nested.feed_lookback_days;
  const feed_lookback_days =
    typeof lookbackRaw === "number" && lookbackRaw > 0
      ? Math.min(14, Math.max(1, Math.floor(lookbackRaw)))
      : DEFAULTS.feed_lookback_days;

  const perNeighborRaw = nested.feed_max_per_neighbor_day;
  const feed_max_per_neighbor_day =
    typeof perNeighborRaw === "number" && perNeighborRaw > 0
      ? Math.min(5, Math.max(1, Math.floor(perNeighborRaw)))
      : DEFAULTS.feed_max_per_neighbor_day;

  const maxCollectRaw = nested.feed_max_collect_day;
  const feed_max_collect_day =
    typeof maxCollectRaw === "number" && maxCollectRaw > 0
      ? Math.min(200, Math.max(5, Math.floor(maxCollectRaw)))
      : DEFAULTS.feed_max_collect_day;

  const feed_last_collect_at =
    typeof nested.feed_last_collect_at === "string" &&
    nested.feed_last_collect_at.trim()
      ? nested.feed_last_collect_at.trim()
      : null;

  const feed_collect_mode =
    nested.feed_collect_mode === "daily_1" ||
    nested.feed_collect_mode === "daily_2" ||
    nested.feed_collect_mode === "daily_4" ||
    nested.feed_collect_mode === "manual"
      ? nested.feed_collect_mode
      : DEFAULTS.feed_collect_mode;

  const hourRaw = nested.feed_collect_hour;
  const feed_collect_hour =
    typeof hourRaw === "number" && hourRaw >= 0 && hourRaw <= 23
      ? Math.floor(hourRaw)
      : DEFAULTS.feed_collect_hour;

  // Prefer feed_ai_auto_count; migrate legacy feed_ai_page_size (10|20|30|50).
  const autoRaw = nested.feed_ai_auto_count ?? nested.feed_ai_page_size;
  const feed_ai_auto_count: NeighborPolicy["feed_ai_auto_count"] =
    autoRaw === 5 || autoRaw === 10 || autoRaw === 20
      ? autoRaw
      : autoRaw === 30 || autoRaw === 50
        ? 20
        : DEFAULTS.feed_ai_auto_count;

  return {
    keywords: keywords.length > 0 ? keywords : [...DEFAULTS.keywords],
    daily_candidate_quota,
    ai_analyze_max,
    ai_batch_size,
    ai_concurrency,
    message,
    delay_min_sec,
    delay_max_sec,
    status_check_mode,
    status_last_check_at,
    feed_lookback_days,
    feed_max_per_neighbor_day,
    feed_max_collect_day,
    feed_last_collect_at,
    feed_collect_mode,
    feed_collect_hour,
    feed_ai_auto_count,
  };
}

export function neighborPolicyToWeeklyGoalsPatch(
  patch: Partial<NeighborPolicy>,
  currentWeekly: Record<string, unknown> = {},
): Record<string, unknown> {
  const prev =
    currentWeekly.neighbor_policy &&
    typeof currentWeekly.neighbor_policy === "object"
      ? (currentWeekly.neighbor_policy as Record<string, unknown>)
      : {};
  return {
    ...currentWeekly,
    neighbor_policy: {
      ...prev,
      ...patch,
    },
  };
}

export function getNeighborDailyLimit(policy: PolicyProfile): number {
  const n = policy.daily_limits?.neighbor_request;
  if (typeof n === "number" && n >= 0) return Math.floor(n);
  return 30;
}

/** Ad / promo heuristic keywords for scoring penalties. */
export const NEIGHBOR_AD_PENALTY_KEYWORDS = [
  "협찬",
  "체험단",
  "광고",
  "공구",
  "판매",
  "할인코드",
  "제휴",
  "원고료",
  "제공받아",
] as const;
