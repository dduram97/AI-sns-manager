import type { PolicyProfile } from "../../workers/types";

/**
 * Discover Policy — data structure only (no Discover UI).
 * Stored: discover_keywords column + weekly_goals.discover_* jsonb fields.
 */
export interface DiscoverPolicy {
  /** 검색 키워드 */
  search_keywords: string[];
  /** 제외 키워드 */
  exclude_keywords: string[];
  /** 목표 카테고리 */
  target_categories: string[];
  /** Max new candidates per tick */
  max_candidates_per_tick: number;
  /** Supervisor: Discover pipeline active */
  active: boolean;
  /** Optional goal label from weekly_goals */
  goal_label: string | null;
}

const DEFAULT_DISCOVER: DiscoverPolicy = {
  search_keywords: [],
  exclude_keywords: [],
  target_categories: [],
  max_candidates_per_tick: 5,
  active: true,
  goal_label: null,
};

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Read DiscoverPolicy from PolicyProfile without schema migration. */
export function getDiscoverPolicy(policy: PolicyProfile): DiscoverPolicy {
  const goals = policy.weekly_goals ?? {};
  const nested =
    goals.discover_policy && typeof goals.discover_policy === "object"
      ? (goals.discover_policy as Record<string, unknown>)
      : {};

  const search =
    asStringArray(nested.search_keywords).length > 0
      ? asStringArray(nested.search_keywords)
      : asStringArray(policy.discover_keywords);

  const exclude =
    asStringArray(nested.exclude_keywords).length > 0
      ? asStringArray(nested.exclude_keywords)
      : asStringArray(goals.discover_exclude_keywords);

  const categories =
    asStringArray(nested.target_categories).length > 0
      ? asStringArray(nested.target_categories)
      : asStringArray(goals.discover_categories);

  const maxRaw = nested.max_candidates_per_tick ?? goals.discover_max_per_tick;
  const max_candidates_per_tick =
    typeof maxRaw === "number" && maxRaw > 0
      ? Math.floor(maxRaw)
      : DEFAULT_DISCOVER.max_candidates_per_tick;

  const active =
    typeof nested.active === "boolean"
      ? nested.active
      : typeof goals.discover_active === "boolean"
        ? goals.discover_active
        : DEFAULT_DISCOVER.active;

  const goal_label =
    typeof nested.goal_label === "string" && nested.goal_label.trim()
      ? nested.goal_label.trim()
      : typeof goals.discover_goal === "string" && goals.discover_goal.trim()
        ? String(goals.discover_goal).trim()
        : categories.length > 0
          ? `카테고리: ${categories.join(", ")}`
          : search.length > 0
            ? "키워드 기반 관계 후보 확보"
            : null;

  return {
    search_keywords: search,
    exclude_keywords: exclude,
    target_categories: categories,
    max_candidates_per_tick,
    active,
    goal_label,
  };
}

/** Serialize DiscoverPolicy into weekly_goals patch (for future Policy settings). */
export function discoverPolicyToWeeklyGoalsPatch(
  discover: Partial<DiscoverPolicy>,
  currentWeekly: Record<string, unknown> = {},
): Record<string, unknown> {
  const prev =
    currentWeekly.discover_policy &&
    typeof currentWeekly.discover_policy === "object"
      ? (currentWeekly.discover_policy as Record<string, unknown>)
      : {};
  return {
    ...currentWeekly,
    discover_policy: {
      ...prev,
      ...discover,
    },
    discover_exclude_keywords:
      discover.exclude_keywords ?? prev.exclude_keywords,
    discover_categories: discover.target_categories ?? prev.target_categories,
  };
}

export function matchesExclude(
  text: string,
  exclude_keywords: string[],
): boolean {
  const lower = text.toLowerCase();
  return exclude_keywords.some((k) => lower.includes(k.toLowerCase()));
}

export function keywordRelevanceScore(
  text: string,
  keywords: string[],
): number {
  if (keywords.length === 0) return 0;
  const lower = text.toLowerCase();
  let hits = 0;
  for (const k of keywords) {
    if (lower.includes(k.toLowerCase())) hits += 1;
  }
  return Math.round((hits / keywords.length) * 100);
}
