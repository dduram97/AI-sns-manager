/**
 * Client-safe neighbor_feed draft helpers (no Node / Playwright imports).
 */

const TEMPLATE_BODIES = new Set([
  "포스팅 잘 보고 갑니다.",
  "포스팅 잘 보고 갑니다",
  "글 잘 보고 갑니다",
  "글 잘 보고 갑니다.",
  "글 잘 봤습니다. 내용이 좋네요.",
]);

/** Preview older than this is considered stale at execute time. */
export const NEIGHBOR_FEED_DRAFT_STALE_MS = 24 * 60 * 60 * 1000;

export type NeighborFeedDraftProbe = {
  source?: string | null;
  draftBody?: string | null;
  aiDraftSource?: string | null;
  aiDraftGeneratedAt?: string | null;
};

export function isNeighborFeedSource(
  source: string | null | undefined,
): boolean {
  return source === "neighbor_feed";
}

/** True when collect-time template is still in place (no real AI draft yet). */
export function needsNeighborFeedAiDraft(
  item: NeighborFeedDraftProbe & { source?: string | null },
): boolean {
  if (item.source != null && item.source !== "neighbor_feed") return false;
  const src = item.aiDraftSource;
  if (src === "neighbor_feed_template" || src == null || src === "") {
    const body = (item.draftBody ?? "").trim();
    if (!body || TEMPLATE_BODIES.has(body)) return true;
    // Non-template body without generated_at → treat as needing preview/execute AI
    if (!item.aiDraftGeneratedAt) return true;
  }
  if (typeof src === "string" && src.includes("neighbor_feed_template")) {
    return true;
  }
  const body = (item.draftBody ?? "").trim();
  return TEMPLATE_BODIES.has(body);
}

export function isNeighborFeedDraftFresh(
  item: NeighborFeedDraftProbe,
  nowMs = Date.now(),
): boolean {
  if (needsNeighborFeedAiDraft({ ...item, source: "neighbor_feed" })) {
    return false;
  }
  const at = item.aiDraftGeneratedAt;
  if (!at || typeof at !== "string") return false;
  const t = Date.parse(at);
  if (Number.isNaN(t)) return false;
  return nowMs - t < NEIGHBOR_FEED_DRAFT_STALE_MS;
}

export function neighborFeedDraftProbeFromInboxItem(item: {
  source?: string | null;
  draftBody?: string | null;
  job?: { target_ref?: Record<string, unknown> | null };
  approval?: { presented_context?: Record<string, unknown> | null };
}): NeighborFeedDraftProbe & { source?: string | null } {
  const ref = item.job?.target_ref ?? {};
  const ctx = item.approval?.presented_context ?? {};
  const generatedAt =
    (typeof ref.ai_generated_at === "string" && ref.ai_generated_at) ||
    (typeof ref.ai_draft_generated_at === "string" &&
      ref.ai_draft_generated_at) ||
    (typeof ctx.ai_generated_at === "string" && ctx.ai_generated_at) ||
    (typeof ctx.ai_draft_generated_at === "string" &&
      ctx.ai_draft_generated_at) ||
    null;
  const aiDraftSource =
    (typeof ref.ai_draft_source === "string" && ref.ai_draft_source) ||
    (typeof ctx.ai_draft_source === "string" && ctx.ai_draft_source) ||
    null;
  const aiComment =
    (typeof ref.ai_comment === "string" && ref.ai_comment) ||
    (typeof ctx.ai_comment === "string" && ctx.ai_comment) ||
    null;
  return {
    source: item.source ?? null,
    draftBody: item.draftBody ?? aiComment ?? null,
    aiDraftSource,
    aiDraftGeneratedAt: generatedAt,
  };
}
