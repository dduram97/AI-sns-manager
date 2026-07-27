/**
 * Neighbor feed scheduled collect — runs from Agent Tick / cron.
 * Failures are logged only; they must not fail the tick or touch ops UI.
 */

import "server-only";

import { shouldRunScheduledNeighborFeedCollect } from "@/domain/neighbor/feedSchedule";
import { getNeighborPolicy } from "@/domain/policy/neighborPolicy";
import { createServiceClient } from "@/lib/supabase";
import { createSupervisorRepos } from "@/repositories/index";
import { collectNeighborFeed } from "@/services/neighborFeedService";

export type ScheduledNeighborFeedCollectOutcome = {
  ran: boolean;
  skipped: boolean;
  reason?: "not_due" | "error";
};

/**
 * If neighbor policy schedule says a collect is due, run the same
 * collectNeighborFeed() path as the manual "새글 수집" button.
 * Never throws.
 */
export async function maybeRunScheduledNeighborFeedCollect(): Promise<ScheduledNeighborFeedCollectOutcome> {
  try {
    const repos = createSupervisorRepos(createServiceClient());
    const np = getNeighborPolicy(await repos.policy.get());

    // Legacy installs kept mode=manual while scheduler was unwired.
    // Treat that as daily_1 for due checks only (does not rewrite settings).
    // Explicit daily_2 / daily_4 are respected as saved.
    const schedulePolicy =
      np.feed_collect_mode === "manual"
        ? { ...np, feed_collect_mode: "daily_1" as const }
        : np;

    if (np.feed_collect_mode === "manual") {
      console.info(
        "[neighbor-feed] mode=manual → schedule as daily_1 (legacy compat)",
      );
    }

    if (!shouldRunScheduledNeighborFeedCollect(schedulePolicy)) {
      console.info("[neighbor-feed] scheduled collect skipped (not due)");
      return { ran: false, skipped: true, reason: "not_due" };
    }

    console.info("[neighbor-feed] scheduled collect start", {
      mode: schedulePolicy.feed_collect_mode,
      savedMode: np.feed_collect_mode,
      hour: np.feed_collect_hour,
      lastAt: np.feed_last_collect_at,
    });

    const result = await collectNeighborFeed();

    console.info("[neighbor-feed] scheduled collect done", {
      finalCount: result.finalCount,
      approvalsCreated: result.approvalsCreated,
      poolSize: result.poolSize,
      message: result.message,
    });

    return { ran: true, skipped: false };
  } catch (err) {
    console.error(
      "[neighbor-feed] scheduled collect failed",
      err instanceof Error ? err.message : err,
    );
    return { ran: false, skipped: false, reason: "error" };
  }
}
