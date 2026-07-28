/** Client-safe display helpers for neighbor discovery candidates (no server deps). */

export type NeighborCollectSource = "naver" | "cdp" | "both" | "unknown";

export type NeighborScoreBreakdownLine = {
  label: string;
  delta: number;
  /** e.g. keyword text or "NAVER 4위" for operator verification */
  detail?: string | null;
};

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseRank(meta: Record<string, unknown>): number | null {
  for (const key of ["search_rank", "naver_search_rank", "naver_rank", "rank"]) {
    const v = meta[key];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      return Math.round(v);
    }
    if (typeof v === "string" && /^\d+$/.test(v.trim())) {
      return Number(v.trim());
    }
  }
  return null;
}

export function parseNeighborCollectSource(
  meta: Record<string, unknown>,
): NeighborCollectSource {
  const via =
    typeof meta.collect_via === "string" ? meta.collect_via.trim() : "";
  const sources = asStringArray(meta.collect_sources);
  const hasNaver =
    via === "api" ||
    sources.some((s) => /^(api|naver)$/i.test(s)) ||
    meta.naver_api === true;
  const hasCdp =
    via === "cdp_fallback" ||
    via === "cdp" ||
    sources.some((s) => /^cdp/i.test(s)) ||
    meta.source === "naver_discover";
  if (hasNaver && hasCdp) return "both";
  if (hasNaver) return "naver";
  if (hasCdp) return "cdp";
  return "unknown";
}

export function primaryNeighborSearchKeyword(
  meta: Record<string, unknown>,
  policyKeywords: string[],
): string | null {
  const explicit =
    typeof meta.search_keyword === "string" ? meta.search_keyword.trim() : "";
  if (explicit) return explicit;

  const keywordCol =
    typeof meta.keyword === "string" ? meta.keyword.trim() : "";
  if (keywordCol) return keywordCol;

  const matched = asStringArray(meta.matched_keywords);

  for (const policyKw of policyKeywords) {
    const hit = matched.find(
      (m) => m.toLowerCase() === policyKw.toLowerCase(),
    );
    if (hit) return hit;
  }

  if (matched.length > 0) {
    return matched.sort((a, b) => b.length - a.length)[0] ?? null;
  }

  const reasons = asStringArray(meta.reasons);
  for (const reason of reasons) {
    const kwMatch = reason.match(/키워드\s*일치:\s*(.+)/i);
    if (kwMatch?.[1]) {
      const first = kwMatch[1].split(/[,·]/)[0]?.trim();
      if (first) return first;
    }
    const related = reason.match(/^(.+?)\s*관련\s*글/i);
    if (related?.[1]?.trim()) return related[1].trim();
  }

  const category =
    typeof meta.primary_category === "string"
      ? meta.primary_category.trim()
      : typeof meta.category_hint === "string"
        ? meta.category_hint.trim()
        : "";
  if (category && category !== "일상") {
    for (const policyKw of policyKeywords) {
      if (category.toLowerCase().includes(policyKw.toLowerCase())) {
        return policyKw;
      }
    }
    const head = category.split(/[/,·]/)[0]?.trim();
    if (head) return head;
  }

  for (const policyKw of policyKeywords) {
    const blob = [
      typeof meta.snippet === "string" ? meta.snippet : "",
      reasons.join(" "),
    ]
      .join(" ")
      .toLowerCase();
    if (blob.includes(policyKw.toLowerCase())) return policyKw;
  }

  return policyKeywords[0] ?? null;
}

export function neighborSearchRank(
  meta: Record<string, unknown>,
): number | null {
  return parseRank(meta);
}

export function formatNeighborSearchRankLabel(
  source: NeighborCollectSource,
  rank: number | null,
): string {
  if (source === "naver" || source === "both") {
    return rank != null ? `NAVER ${rank}위` : "NAVER";
  }
  if (source === "cdp") return "CDP";
  return "—";
}

export function neighborCollectSourceBadges(
  source: NeighborCollectSource,
): Array<"NAVER" | "CDP" | "BOTH"> {
  if (source === "both") return ["BOTH"];
  if (source === "naver") return ["NAVER"];
  if (source === "cdp") return ["CDP"];
  return [];
}

export function neighborCollectSourceModalLabel(
  source: NeighborCollectSource,
): string {
  if (source === "both") return "CDP + NAVER API";
  if (source === "naver") return "NAVER API";
  if (source === "cdp") return "CDP";
  return "—";
}

export function naverKeywordSearchUrl(keyword: string): string {
  return `https://search.naver.com/search.naver?query=${encodeURIComponent(
    keyword,
  )}`;
}

export function neighborAdPassLabel(adScore: number): string {
  return adScore >= 56 ? "FAIL" : "PASS";
}

export function neighborDormantLabel(
  recentlyActive: boolean,
  lastActivityLabel: string,
): string {
  if (!recentlyActive) return "휴면";
  if (lastActivityLabel.includes("1년")) return "휴면";
  return "활동중";
}

export function buildNeighborScoreBreakdown(input: {
  recentlyActive: boolean;
  keywordMatchRate: number;
  collectSource: NeighborCollectSource;
  searchRank: number | null;
  searchKeyword: string | null;
  adScore: number;
  recommendScore: number;
}): NeighborScoreBreakdownLine[] {
  const lines: NeighborScoreBreakdownLine[] = [];
  const rankDetail = formatNeighborSearchRankLabel(
    input.collectSource,
    input.searchRank,
  );

  if (input.recentlyActive) {
    lines.push({ label: "최근활동", delta: 20 });
  }

  if (input.keywordMatchRate >= 60) {
    lines.push({
      label: "키워드",
      delta: 15,
      detail: input.searchKeyword,
    });
  } else if (input.keywordMatchRate >= 30) {
    lines.push({
      label: "키워드",
      delta: 10,
      detail: input.searchKeyword,
    });
  } else if (input.keywordMatchRate > 0) {
    lines.push({
      label: "키워드",
      delta: 5,
      detail: input.searchKeyword,
    });
  }

  if (input.collectSource === "naver" || input.collectSource === "both") {
    if (input.searchRank != null && input.searchRank <= 10) {
      lines.push({ label: "검색순위", delta: 10, detail: rankDetail });
    } else {
      lines.push({ label: "검색순위", delta: 5, detail: rankDetail });
    }
  }

  const adPenalty =
    input.adScore >= 56 ? -20 : input.adScore >= 28 ? -10 : 0;
  lines.push({ label: "광고", delta: adPenalty });

  return lines;
}

export type NeighborCandidateDiscoveryDisplay = {
  searchKeyword: string | null;
  searchRank: number | null;
  collectSource: NeighborCollectSource;
  recentlyActive: boolean;
  scoreBreakdown: NeighborScoreBreakdownLine[];
};

export function neighborCandidateDiscoveryDisplay(
  meta: Record<string, unknown>,
  policyKeywords: string[],
  input: {
    keywordMatchRate: number;
    adScore: number;
    recommendScore: number;
    lastActivityLabel: string;
  },
): NeighborCandidateDiscoveryDisplay {
  const collectSource = parseNeighborCollectSource(meta);
  const searchKeyword = primaryNeighborSearchKeyword(meta, policyKeywords);
  const searchRank = neighborSearchRank(meta);
  const recentlyActive = meta.recently_active === true;

  return {
    searchKeyword,
    searchRank,
    collectSource,
    recentlyActive,
    scoreBreakdown: buildNeighborScoreBreakdown({
      recentlyActive,
      keywordMatchRate: input.keywordMatchRate,
      collectSource,
      searchRank,
      searchKeyword,
      adScore: input.adScore,
      recommendScore: input.recommendScore,
    }),
  };
}
