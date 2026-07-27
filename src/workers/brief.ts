/**
 * Brief Snapshot projection — singleton brief_snapshots row.
 */

import type { Repositories } from "../repositories/index";
import type { BriefSnapshot } from "./types";

const SECONDS_PER_APPROVAL = 50;

export async function refreshBriefSnapshot(
  repos: Repositories,
): Promise<BriefSnapshot> {
  const openApprovals = await repos.listOpenApprovals();
  const today = await repos.ensureOutcomeToday();
  const todayActivities = await repos.listActivitiesForDate(today.date);
  const channels = await repos.listChannelConnectionStatuses();

  const summary = {
    auto_visits: today.auto_visit_count,
    auto_likes: today.auto_like_count,
    observe: today.observe_count,
    waiting: today.waiting_count,
    approval_created: todayActivities.filter(
      (a) => a.kind === "approval_created",
    ).length,
    executed: todayActivities.filter((a) => a.kind === "executed").length,
  };

  const intervention = (openApprovals.length * SECONDS_PER_APPROVAL) / 60;

  const current = await repos.getBrief();
  const prev = current.status_detail ?? {};
  const lockFields: Record<string, unknown> = {};
  if (typeof prev.tick_lock_token === "string") {
    lockFields.tick_lock_token = prev.tick_lock_token;
    lockFields.tick_lock_until = prev.tick_lock_until;
    lockFields.tick_lock_at = prev.tick_lock_at;
  }

  const brief = await repos.updateBrief({
    agent_status: "active",
    status_detail: {
      ...lockFields,
      last_tick_at: new Date().toISOString(),
      channels,
    },
    activity_summary: summary,
    approval_count: openApprovals.length,
    intervention_minutes_est: intervention,
    time_saved_minutes_est: today.time_saved_minutes_est,
    growth_summary: {
      temperature_up: today.temperature_up_count,
      mutual_reactions: today.mutual_reaction_count,
    },
  });

  await repos.updateOutcomeToday({
    approval_pending_count: openApprovals.length,
    intervention_minutes_est: intervention,
  });

  return brief;
}
