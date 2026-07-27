/**
 * How a neighbor entered the local pool.
 * Stored on persons.discover_meta.neighbor_source
 */

export type NeighborSource =
  | "existing_sync" // scraped from Naver buddy list
  | "neighbor_request" // created via mutual-request flow
  | "manual"; // explicitly added in app

export function parseNeighborSource(
  meta: Record<string, unknown> | null | undefined,
): NeighborSource | null {
  if (!meta) return null;
  const raw = meta.neighbor_source;
  if (
    raw === "existing_sync" ||
    raw === "neighbor_request" ||
    raw === "manual"
  ) {
    return raw;
  }
  return null;
}

export function neighborSourceLabel(source: NeighborSource | null): string {
  switch (source) {
    case "existing_sync":
      return "기존 이웃 동기화";
    case "neighbor_request":
      return "서로이웃 신청";
    case "manual":
      return "직접 추가";
    default:
      return "미분류";
  }
}
