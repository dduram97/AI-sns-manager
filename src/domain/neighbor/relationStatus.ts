/**
 * Neighbor relation lifecycle (신청 vs 수락 완료).
 * Stored on persons.discover_meta — display-only enrichment over ActionJob executed.
 */

export type NeighborRelationStatus =
  | "requested" // 신청 완료 · 상대 승인 대기
  | "accepted" // 서로이웃 완료
  | "failed"; // 신청 실패 (optional on person; jobs also track)

export type NeighborStatusCheckMode = "daily_1" | "daily_2" | "manual";

export type NeighborRelationProbeResult =
  | "accepted"
  | "pending_request"
  | "can_request"
  | "unknown";

export function neighborRelationStatusLabel(
  status: NeighborRelationStatus | "unknown",
): { emoji: string; label: string; shortLabel: string; tone: "blue" | "green" | "red" | "yellow" } {
  switch (status) {
    case "accepted":
      return {
        emoji: "🟢",
        label: "서로이웃 완료",
        shortLabel: "서로이웃 완료",
        tone: "green",
      };
    case "requested":
      return {
        emoji: "🟡",
        label: "신청 완료",
        shortLabel: "신청 완료",
        tone: "yellow",
      };
    case "failed":
      return {
        emoji: "🔴",
        label: "신청 실패",
        shortLabel: "신청 실패",
        tone: "red",
      };
    default:
      return {
        emoji: "🟡",
        label: "상태 미확인",
        shortLabel: "미확인",
        tone: "yellow",
      };
  }
}

export function statusCheckModeLabel(mode: NeighborStatusCheckMode): string {
  switch (mode) {
    case "daily_1":
      return "하루 1회";
    case "daily_2":
      return "하루 2회";
    case "manual":
      return "수동 확인";
  }
}

/** Hours between auto checks */
export function statusCheckIntervalHours(
  mode: NeighborStatusCheckMode,
): number | null {
  switch (mode) {
    case "daily_1":
      return 24;
    case "daily_2":
      return 12;
    case "manual":
      return null;
  }
}

export function isNeighborStatusCheckDue(
  lastCheckIso: string | null | undefined,
  mode: NeighborStatusCheckMode,
): boolean {
  const hours = statusCheckIntervalHours(mode);
  if (hours == null) return false;
  if (!lastCheckIso) return true;
  const t = new Date(lastCheckIso).getTime();
  if (Number.isNaN(t)) return true;
  return Date.now() - t >= hours * 3_600_000;
}

export function parseNeighborRelationStatus(
  meta: Record<string, unknown> | null | undefined,
): NeighborRelationStatus | null {
  if (!meta) return null;
  const raw = meta.neighbor_relation_status;
  if (raw === "requested" || raw === "accepted" || raw === "failed") {
    return raw;
  }
  return null;
}
