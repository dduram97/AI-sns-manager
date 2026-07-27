/**
 * Code-only pre-filter for neighbor candidates (before AI).
 * Handles: activity window, corporate, ad spam, keyword relevance.
 */

import type { DiscoverCandidate } from "@/adapters/naver/NaverDiscoverAdapter";
import { NEIGHBOR_AD_PENALTY_KEYWORDS } from "@/domain/policy/neighborPolicy";

const CORPORATE_HINTS = [
  "공식",
  "스토어",
  "주식회사",
  "(주)",
  "쇼핑몰",
  "본사",
  "고객센터",
  "브랜드",
  "온라인몰",
  "공식몰",
] as const;

const TOPIC_HINTS = [
  "맛집",
  "카페",
  "여행",
  "일상",
  "전국맛집",
  "포항맛집",
  "맛집탐방",
  "브런치",
  "캠핑",
  "핫플",
] as const;

export type NeighborCodeFilterResult = {
  pass: boolean;
  rejectReason?:
    | "inactive"
    | "ad_heavy"
    | "corporate"
    | "topic_mismatch";
  adScore: number;
  keywordMatchRate: number;
  primaryCategory: string;
  lastPostAt: string | null;
  /** Pre-AI ranking score (0–100). Only meaningful when pass=true. */
  codeScore: number;
};

function ageDaysFromIso(iso: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return (Date.now() - t) / 86_400_000;
}

/**
 * Code-only ranking score used to pick top-N for AI.
 * Higher = more worth spending an AI call on.
 */
export function computeNeighborCodeScore(
  c: DiscoverCandidate,
  filter: Omit<NeighborCodeFilterResult, "codeScore" | "pass" | "rejectReason">,
  keywords: string[],
): number {
  let score = 35;
  const haystack = `${c.blogName} ${c.snippet} ${c.matchedKeywords.join(" ")}`;
  const lower = haystack.toLowerCase();
  const ageDays = ageDaysFromIso(filter.lastPostAt ?? c.lastPostAt);

  // + 최근 3개월 게시
  if (ageDays != null && ageDays <= 90) score += 16;
  // + 최근 작성 빈도
  if (ageDays != null && ageDays <= 7) score += 14;
  else if (ageDays != null && ageDays <= 14) score += 10;
  else if (ageDays != null && ageDays <= 30) score += 6;

  // + 맛집/일상/여행 키워드 일치
  const topicBoost = ["맛집", "카페", "여행", "일상", "전국맛집", "포항맛집"];
  const topicHits = topicBoost.filter((k) => lower.includes(k));
  const kwHits = keywords.filter((k) => lower.includes(k.toLowerCase()));
  score += Math.min(18, topicHits.length * 5 + kwHits.length * 3);
  score += Math.min(12, Math.round(filter.keywordMatchRate / 10));

  // + 개인 블로그 가능성
  if (filter.adScore <= 10) score += 12;
  else if (filter.adScore <= 25) score += 6;

  // + 댓글/소통 흔적 (snippet heuristic)
  if (/댓글|공감|이웃|소통|답글|리플/.test(haystack)) score += 8;

  // − 광고/협찬
  score -= Math.min(25, Math.round(filter.adScore * 0.35));

  // − 장기간 미작성
  if (ageDays != null && ageDays > 180) score -= 18;
  else if (ageDays != null && ageDays > 90) score -= 8;
  else if (ageDays != null && ageDays > 30) score -= 4;

  // − 키워드 불일치
  if (filter.keywordMatchRate < 20) score -= 10;
  else if (filter.keywordMatchRate < 40) score -= 4;

  score += Math.min(8, Math.round(c.keywordRelevance / 20));

  return Math.max(0, Math.min(100, Math.round(score)));
}

export function codeFilterNeighborCandidate(
  c: DiscoverCandidate,
  keywords: string[],
): NeighborCodeFilterResult {
  const haystack = `${c.blogName} ${c.snippet} ${c.matchedKeywords.join(" ")}`;
  const lower = haystack.toLowerCase();

  const fail = (
    rejectReason: NeighborCodeFilterResult["rejectReason"],
    partial?: Partial<NeighborCodeFilterResult>,
  ): NeighborCodeFilterResult => ({
    pass: false,
    rejectReason,
    adScore: 0,
    keywordMatchRate: 0,
    primaryCategory: "일상",
    lastPostAt: c.lastPostAt,
    codeScore: 0,
    ...partial,
  });

  if (!c.recentlyActive) {
    return fail("inactive");
  }

  if (c.lastPostAt) {
    const ageDays = ageDaysFromIso(c.lastPostAt);
    if (ageDays != null && (ageDays > 365 || ageDays < 0)) {
      return fail("inactive", { lastPostAt: c.lastPostAt });
    }
  }

  const adHits = NEIGHBOR_AD_PENALTY_KEYWORDS.filter((k) =>
    lower.includes(k.toLowerCase()),
  );
  const adScore = Math.min(100, adHits.length * 28);
  if (adHits.length >= 2 || adScore >= 56) {
    return fail("ad_heavy", { adScore, lastPostAt: c.lastPostAt });
  }

  const corporate = CORPORATE_HINTS.some((k) => lower.includes(k.toLowerCase()));
  if (corporate) {
    return fail("corporate", {
      adScore: Math.max(adScore, 60),
      lastPostAt: c.lastPostAt,
    });
  }

  const hitKeywords = keywords.filter((k) =>
    lower.includes(k.toLowerCase()),
  );
  const topicHits = TOPIC_HINTS.filter((k) => lower.includes(k.toLowerCase()));
  const keywordMatchRate =
    keywords.length === 0
      ? 0
      : Math.round(
          (Math.max(hitKeywords.length, c.matchedKeywords.length > 0 ? 1 : 0) /
            Math.max(1, Math.min(keywords.length, 6))) *
            100,
        );

  if (
    hitKeywords.length === 0 &&
    c.matchedKeywords.length === 0 &&
    topicHits.length === 0
  ) {
    return fail("topic_mismatch", {
      adScore,
      keywordMatchRate,
      lastPostAt: c.lastPostAt,
    });
  }

  const primaryCategory =
    hitKeywords.slice(0, 2).join(" / ") ||
    topicHits.slice(0, 2).join(" / ") ||
    c.categoryHint ||
    "일상";

  const base = {
    adScore,
    keywordMatchRate: Math.max(
      keywordMatchRate,
      Math.min(100, c.keywordRelevance),
    ),
    primaryCategory,
    lastPostAt: c.lastPostAt,
  };

  return {
    pass: true,
    ...base,
    codeScore: computeNeighborCodeScore(c, base, keywords),
  };
}
