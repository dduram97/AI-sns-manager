/**
 * Neighbor feed auto-collect schedule helpers.
 * Used by Agent Tick via maybeRunScheduledNeighborFeedCollect.
 */

import type { NeighborPolicy } from "@/domain/policy/neighborPolicy";

/** KST offset from UTC in ms */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function kstParts(now = new Date()): {
  y: number;
  m: number;
  d: number;
  hour: number;
} {
  const kst = new Date(now.getTime() + KST_OFFSET_MS);
  return {
    y: kst.getUTCFullYear(),
    m: kst.getUTCMonth(),
    d: kst.getUTCDate(),
    hour: kst.getUTCHours(),
  };
}

function startOfKstDayMs(now = new Date()): number {
  const { y, m, d } = kstParts(now);
  return Date.UTC(y, m, d) - KST_OFFSET_MS;
}

/** Hours between auto collects for each mode */
export function feedCollectIntervalHours(
  mode: NeighborPolicy["feed_collect_mode"],
): number | null {
  switch (mode) {
    case "daily_1":
      return 24;
    case "daily_2":
      return 12;
    case "daily_4":
      return 6;
    default:
      return null;
  }
}

export function feedCollectModeLabel(
  mode: NeighborPolicy["feed_collect_mode"],
): string {
  switch (mode) {
    case "daily_1":
      return "하루 1회";
    case "daily_2":
      return "하루 2회";
    case "daily_4":
      return "하루 4회";
    default:
      return "수동 실행";
  }
}

/**
 * Whether a scheduled (non-manual) collect should run now.
 * Does not execute — Agent Tick calls collect when this returns true.
 *
 * daily_1: after feed_collect_hour KST, once per KST day
 * daily_2 / daily_4: every 12h / 6h after feed_collect_hour anchor
 */
export function shouldRunScheduledNeighborFeedCollect(
  policy: Pick<
    NeighborPolicy,
    "feed_collect_mode" | "feed_collect_hour" | "feed_last_collect_at"
  >,
  now = new Date(),
): boolean {
  const intervalH = feedCollectIntervalHours(policy.feed_collect_mode);
  if (intervalH == null) return false;

  const { hour } = kstParts(now);
  const dayStart = startOfKstDayMs(now);
  const anchorMs = dayStart + policy.feed_collect_hour * 3_600_000;

  if (now.getTime() < anchorMs) return false;

  if (!policy.feed_last_collect_at) return true;
  const last = new Date(policy.feed_last_collect_at).getTime();
  if (Number.isNaN(last)) return true;

  if (policy.feed_collect_mode === "daily_1") {
    return last < dayStart;
  }

  return now.getTime() - last >= intervalH * 3_600_000;
}
