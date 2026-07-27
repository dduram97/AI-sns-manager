import { readSessionHealth } from "@/adapters/naver/sessionHealth";
import "server-only";
import { cache } from "react";
import { createServiceClient } from "@/lib/supabase";
import { runWithDbTrace } from "@/lib/dbTrace";
import { createSupervisorRepos } from "@/repositories/index";
import type { OutcomeDaily } from "@/workers/types";

export type AgentUiStatus = "active" | "syncing" | "warning";

export interface AgentBriefViewModel {
  status: AgentUiStatus;
  statusLabel: string;
  lastTickAt: string | null;
  lastTickLabel: string;
  syncChannels: Record<string, string>;
  syncSummary: string;
  interventionMinutes: number;
  timeSavedMinutes: number;
  approvalCount: number;
  activity: {
    autoVisits: number;
    autoLikes: number;
    approvalsDone: number;
    observe: number;
    waiting: number;
  };
  relationship: {
    temperatureUp: number;
    mutualReactions: number;
    newRelationships: number;
    maintaining: number;
  };
}

const CHANNELS = ["blog", "threads", "instagram"] as const;

function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v !== "") return Number(v);
  return 0;
}

/** Prefer first positive value; else last source (may be 0). */
function pickMetric(...sources: unknown[]): number {
  for (const s of sources) {
    const n = num(s);
    if (n > 0) return n;
  }
  return num(sources[sources.length - 1]);
}

function formatRelative(iso: string | null): string {
  if (!iso) return "기록 없음";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "기록 없음";
  const diffSec = Math.floor((Date.now() - t) / 1000);
  if (diffSec < 60) return "방금 전";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}분 전`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}시간 전`;
  return new Date(iso).toLocaleString("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function deriveStatus(
  agentStatus: string,
  channels: Record<string, string>,
  lastTickAt: string | null,
): { status: AgentUiStatus; label: string } {
  const hasError = Object.values(channels).some(
    (s) => s === "error" || s === "revoked",
  );
  if (hasError || agentStatus === "error") {
    return { status: "warning", label: "주의 필요" };
  }
  if (agentStatus === "syncing") {
    return { status: "syncing", label: "동기화 중" };
  }
  if (lastTickAt) {
    const ageMin = (Date.now() - new Date(lastTickAt).getTime()) / 60000;
    if (ageMin > 180) {
      return { status: "warning", label: "Tick 지연" };
    }
  }
  return { status: "active", label: "정상 작동" };
}

function resolveLastTickAt(detail: Record<string, unknown>): string | null {
  if (typeof detail.last_tick_at === "string") return detail.last_tick_at;
  const run = detail.last_tick_run;
  if (run && typeof run === "object" && !Array.isArray(run)) {
    const r = run as Record<string, unknown>;
    if (typeof r.finished_at === "string") return r.finished_at;
    if (typeof r.started_at === "string") return r.started_at;
  }
  return null;
}

function outcomeHasLiveData(
  outcome: OutcomeDaily,
  todayActivitiesCount: number,
): boolean {
  if (todayActivitiesCount > 0) return true;
  return (
    outcome.auto_visit_count > 0 ||
    outcome.auto_like_count > 0 ||
    outcome.approval_done_count > 0 ||
    outcome.observe_count > 0 ||
    outcome.waiting_count > 0 ||
    outcome.intervention_minutes_est > 0 ||
    outcome.time_saved_minutes_est > 0
  );
}

/**
 * Live DB channel status wins over stale brief.status_detail.channels snapshot.
 * Blog reflects Naver session health when DB still says disconnected.
 */
function resolveChannelMap(
  live: Record<string, string>,
  snapshot: Record<string, string> | undefined,
): Record<string, string> {
  const health = readSessionHealth();
  const out: Record<string, string> = {};

  for (const ch of CHANNELS) {
    let st = live[ch] ?? snapshot?.[ch] ?? "disconnected";
    if (ch === "blog") {
      if (health?.state === "logged_in" && st === "disconnected") {
        st = "connected";
      } else if (
        health?.state === "needs_relogin" ||
        health?.state === "expired" ||
        health?.state === "error"
      ) {
        st = "error";
      }
    }
    out[ch] = st;
  }
  return out;
}

const getBriefRepos = cache(async () => {
  const repos = createSupervisorRepos(createServiceClient());
  await repos.policy.ensureChannelConnectionRows();
  return repos;
});

const loadBriefCore = cache(async () => {
  const repos = await getBriefRepos();
  const [brief, outcome, liveChannels] = await Promise.all([
    repos.brief.getBrief(),
    repos.brief.ensureOutcomeToday(),
    repos.brief.listChannelConnectionStatuses(),
  ]);
  return { repos, brief, outcome, liveChannels };
});

const loadTodayActivities = cache(async () => {
  const { repos, outcome } = await loadBriefCore();
  return repos.activity.listForDate(outcome.date);
});

function buildStatusView(
  brief: Awaited<ReturnType<typeof loadBriefCore>>["brief"],
  liveChannels: Record<string, string>,
) {
  const detail = brief.status_detail ?? {};
  const snapshotChannels = detail.channels as
    | Record<string, string>
    | undefined;
  const lastTickAt = resolveLastTickAt(detail);
  const channelMap = resolveChannelMap(liveChannels, snapshotChannels);
  const { status, label } = deriveStatus(
    brief.agent_status,
    channelMap,
    lastTickAt,
  );
  const syncParts = Object.entries(channelMap).map(
    ([ch, st]) => `${ch}: ${st}`,
  );
  return {
    status,
    statusLabel: label,
    lastTickAt,
    lastTickLabel: formatRelative(lastTickAt),
    syncChannels: channelMap,
    syncSummary:
      syncParts.length > 0 ? syncParts.join(" · ") : "연결된 채널 없음",
  };
}

function buildActivityView(
  brief: Awaited<ReturnType<typeof loadBriefCore>>["brief"],
  outcome: OutcomeDaily,
  todayActivities: Awaited<ReturnType<typeof loadTodayActivities>>,
): AgentBriefViewModel["activity"] {
  const summary = brief.activity_summary ?? {};
  const todayHasLiveData = outcomeHasLiveData(outcome, todayActivities.length);
  const todayApproved = todayActivities.filter(
    (a) => a.kind === "approved",
  ).length;

  return todayHasLiveData
    ? {
        autoVisits: pickMetric(outcome.auto_visit_count, summary.auto_visits),
        autoLikes: pickMetric(outcome.auto_like_count, summary.auto_likes),
        approvalsDone: pickMetric(
          todayApproved,
          outcome.approval_done_count,
          summary.executed,
        ),
        observe: pickMetric(outcome.observe_count, summary.observe),
        waiting: pickMetric(outcome.waiting_count, summary.waiting),
      }
    : {
        autoVisits: pickMetric(summary.auto_visits, outcome.auto_visit_count),
        autoLikes: pickMetric(summary.auto_likes, outcome.auto_like_count),
        approvalsDone: pickMetric(
          summary.executed,
          todayApproved,
          outcome.approval_done_count,
        ),
        observe: pickMetric(summary.observe, outcome.observe_count),
        waiting: pickMetric(summary.waiting, outcome.waiting_count),
      };
}

/** Fast path: brief snapshot + channels (no open-approval scan). */
export async function getAgentBriefStatusSection() {
  return runWithDbTrace("today", async () => {
    const { brief, outcome, liveChannels } = await loadBriefCore();
    const statusView = buildStatusView(brief, liveChannels);
    return {
      ...statusView,
      interventionMinutes: pickMetric(
        brief.intervention_minutes_est,
        outcome.intervention_minutes_est,
      ),
      timeSavedMinutes: pickMetric(
        brief.time_saved_minutes_est,
        outcome.time_saved_minutes_est,
      ),
      approvalCountSnapshot: pickMetric(brief.approval_count),
    };
  });
}

/** Activity metrics — outcome + today's activity rows. */
export async function getAgentBriefActivitySection(): Promise<
  AgentBriefViewModel["activity"]
> {
  return runWithDbTrace("today", async () => {
    const { brief, outcome } = await loadBriefCore();
    const todayActivities = await loadTodayActivities();
    return buildActivityView(brief, outcome, todayActivities);
  });
}

/** Live open approval count (can be slower). */
export async function getAgentBriefApprovalSection(): Promise<number> {
  return runWithDbTrace("today", async () => {
    const repos = await getBriefRepos();
    const [openApprovals, brief] = await Promise.all([
      repos.approval.listOpen(),
      loadBriefCore().then((c) => c.brief),
    ]);
    return pickMetric(openApprovals.length, brief.approval_count);
  });
}

/** CRM relationship counts. */
export async function getAgentBriefRelationshipSection(): Promise<
  AgentBriefViewModel["relationship"]
> {
  return runWithDbTrace("today", async () => {
    const { repos, brief, outcome } = await loadBriefCore();
    const growth = brief.growth_summary ?? {};
    const { newRelationships, maintaining } =
      await repos.person.countActiveWorkflowGroups();
    return {
      temperatureUp: pickMetric(
        growth.temperature_up,
        outcome.temperature_up_count,
      ),
      mutualReactions: pickMetric(
        growth.mutual_reactions,
        outcome.mutual_reaction_count,
      ),
      newRelationships,
      maintaining,
    };
  });
}

export async function getAgentBrief(): Promise<AgentBriefViewModel> {
  const [core, activity, approvalCount, relationship] = await Promise.all([
    getAgentBriefStatusSection(),
    getAgentBriefActivitySection(),
    getAgentBriefApprovalSection(),
    getAgentBriefRelationshipSection(),
  ]);

  console.log(
    `[today] brief streamed status=${core.status} approvalCount=${approvalCount} intervention=${core.interventionMinutes}`,
  );

  const viewModel: AgentBriefViewModel = {
    status: core.status,
    statusLabel: core.statusLabel,
    lastTickAt: core.lastTickAt,
    lastTickLabel: core.lastTickLabel,
    syncChannels: core.syncChannels,
    syncSummary: core.syncSummary,
    interventionMinutes: core.interventionMinutes,
    timeSavedMinutes: core.timeSavedMinutes,
    approvalCount,
    activity,
    relationship,
  };

  return viewModel;
}

/** @deprecated use getAgentBrief */
export const getAgentBriefViewModel = getAgentBrief;
