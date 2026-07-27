/**
 * More / Agent Policy — Supervisor service (no direct Supabase from UI).
 * Policy constrains Decision; does not change Rule Pipeline.
 */

import "server-only";

import { createServiceClient } from "@/lib/supabase";
import {
  discoverPolicyToWeeklyGoalsPatch,
  getDiscoverPolicy,
} from "@/domain/policy/discoverPolicy";
import { createSupervisorRepos } from "@/repositories/index";
import type { PolicyProfile } from "@/workers/types";
import {
  getAgentExecutionLog,
} from "@/services/agentExecutionLogService";
import type {
  AgentExecutionLogData,
  ChannelConnectionView,
  MoreScreenData,
} from "@/types/moreScreen";

const DEFAULT_LIMIT = 20;

export type {
  AgentExecutionLogData,
  ChannelConnectionView,
  MoreScreenData,
} from "@/types/moreScreen";

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string")
    .map((s) => s.trim())
    .filter(Boolean);
}

function readLowRiskFlags(policy: PolicyProfile): {
  visit: boolean;
  like: boolean;
} {
  const goals = asRecord(policy.weekly_goals);
  const flags = asRecord(goals.low_risk_actions);
  const visit =
    typeof flags.visit === "boolean"
      ? flags.visit
      : policy.low_risk_auto &&
        (policy.daily_limits.visit == null || policy.daily_limits.visit > 0);
  const like =
    typeof flags.like === "boolean"
      ? flags.like
      : policy.low_risk_auto &&
        (policy.daily_limits.like == null || policy.daily_limits.like > 0);
  return { visit, like };
}

function channelLabel(channel: string): string {
  if (channel === "blog") return "Blog (Naver)";
  if (channel === "threads") return "Threads";
  if (channel === "instagram") return "Instagram";
  return channel;
}

function statusLabel(status: string): string {
  switch (status) {
    case "connected":
      return "연결됨";
    case "error":
      return "오류";
    case "revoked":
      return "철회됨";
    default:
      return "미연결";
  }
}

function readyHint(channel: string, status: string): string {
  if (channel === "blog") {
    return status === "connected"
      ? "NaverBlogAdapter 사용 가능"
      : "Tick Sync / Adapter 자격증명 연결 필요";
  }
  if (channel === "threads") {
    return "Adapter 확장 대기 · Spec F1";
  }
  return "향후 Adapter 확장 슬롯";
}

export async function getMoreScreenData(): Promise<MoreScreenData> {
  const repos = createSupervisorRepos(createServiceClient());
  await repos.policy.ensureChannelConnectionRows();
  const [policy, connections, executionLog] = await Promise.all([
    repos.policy.get(),
    repos.policy.listChannelConnections(),
    getAgentExecutionLog(12),
  ]);
  const flags = readLowRiskFlags(policy);
  const discover = getDiscoverPolicy(policy);
  const toneObj = asRecord(policy.tone);

  const byChannel = new Map(connections.map((c) => [c.channel, c]));
  const channels: ChannelConnectionView[] = (
    ["blog", "threads", "instagram"] as const
  ).map((channel) => {
    const row = byChannel.get(channel);
    const status = row?.status ?? "disconnected";
    return {
      channel,
      label: channelLabel(channel),
      status,
      statusLabel: statusLabel(status),
      readyHint: readyHint(channel, status),
      last_synced_at: row?.last_synced_at ?? null,
    };
  });

  return {
    policy,
    automation: {
      lowRiskAuto: policy.low_risk_auto,
      visitAuto: flags.visit,
      likeAuto: flags.like,
      commentMode: "approval_required",
      mutualRequestMode: "approval_required",
      preset: policy.preset,
    },
    limits: {
      visit: policy.daily_limits.visit ?? null,
      like: policy.daily_limits.like ?? null,
      comment: policy.daily_limits.comment ?? null,
      neighbor_request: policy.daily_limits.neighbor_request ?? null,
    },
    tone: {
      base:
        typeof toneObj.base === "string"
          ? toneObj.base
          : typeof toneObj.style === "string"
            ? toneObj.style
            : "",
      preferredPhrases: asStringArray(
        toneObj.preferred_phrases ?? toneObj.preferredPhrases,
      ),
      bannedPhrases: policy.banned_phrases ?? [],
      commentExamples: asStringArray(
        toneObj.comment_examples ?? toneObj.commentExamples,
      ),
    },
    discover,
    channels,
    executionLog,
  };
}

export type SaveAutomationInput = {
  visitAuto: boolean;
  likeAuto: boolean;
};

export type SaveLimitsInput = {
  visit: number | null;
  like: number | null;
  comment: number | null;
  neighbor_request: number | null;
};

export type SaveToneInput = {
  base: string;
  preferredPhrases: string[];
  bannedPhrases: string[];
  commentExamples?: string[];
};

export type SaveDiscoverPolicyInput = {
  search_keywords: string[];
  goal_label: string;
  active: boolean;
  exclude_keywords?: string[];
  max_candidates_per_tick?: number;
};

/**
 * Visit/like auto: Policy gates via low_risk_auto + daily_limits=0 (no Decision Engine change).
 */
export async function saveAutomationPolicy(
  input: SaveAutomationInput,
): Promise<void> {
  const repos = createSupervisorRepos(createServiceClient());
  const current = await repos.policy.get();
  const goals = { ...asRecord(current.weekly_goals) };
  const memory = asRecord(goals.limit_memory);
  const limits = { ...current.daily_limits };

  const remember = (key: "visit" | "like", value: number | undefined) => {
    if (value != null && value > 0) memory[key] = value;
  };

  if (!input.visitAuto) {
    remember("visit", limits.visit);
    limits.visit = 0;
  } else if (limits.visit == null || limits.visit <= 0) {
    limits.visit =
      typeof memory.visit === "number" && memory.visit > 0
        ? memory.visit
        : DEFAULT_LIMIT;
  }

  if (!input.likeAuto) {
    remember("like", limits.like);
    limits.like = 0;
  } else if (limits.like == null || limits.like <= 0) {
    limits.like =
      typeof memory.like === "number" && memory.like > 0
        ? memory.like
        : DEFAULT_LIMIT;
  }

  await repos.policy.update({
    low_risk_auto: input.visitAuto || input.likeAuto,
    daily_limits: limits,
    high_risk_auto_comment: false,
    high_risk_auto_request: false,
    weekly_goals: {
      ...goals,
      limit_memory: memory,
      low_risk_actions: {
        visit: input.visitAuto,
        like: input.likeAuto,
      },
    },
  });
}

export async function saveDailyLimits(input: SaveLimitsInput): Promise<void> {
  const repos = createSupervisorRepos(createServiceClient());
  const current = await repos.policy.get();
  const flags = readLowRiskFlags(current);
  const goals = { ...asRecord(current.weekly_goals) };
  const memory = asRecord(goals.limit_memory);

  const limits: PolicyProfile["daily_limits"] = {};
  const assign = (
    key: keyof PolicyProfile["daily_limits"],
    value: number | null,
    autoOn: boolean,
  ) => {
    if (value == null || Number.isNaN(value)) return;
    const n = Math.max(0, Math.floor(value));
    if (autoOn && n > 0) memory[key] = n;
    limits[key] = autoOn ? n : 0;
  };

  assign("visit", input.visit, flags.visit);
  assign("like", input.like, flags.like);
  if (input.comment != null) limits.comment = Math.max(0, Math.floor(input.comment));
  if (input.neighbor_request != null) {
    limits.neighbor_request = Math.max(0, Math.floor(input.neighbor_request));
  }

  await repos.policy.update({
    daily_limits: limits,
    weekly_goals: { ...goals, limit_memory: memory },
  });
}

export async function saveTonePolicy(input: SaveToneInput): Promise<void> {
  const repos = createSupervisorRepos(createServiceClient());
  const current = await repos.policy.get();
  const prevTone = asRecord(current.tone);
  const commentExamples = (
    input.commentExamples ??
    asStringArray(prevTone.comment_examples ?? prevTone.commentExamples)
  )
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 40);

  await repos.policy.update({
    tone: {
      ...prevTone,
      base: input.base.trim(),
      preferred_phrases: input.preferredPhrases
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 40),
      comment_examples: commentExamples,
    },
    banned_phrases: input.bannedPhrases
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 80),
  });
}

export async function saveDiscoverPolicySettings(
  input: SaveDiscoverPolicyInput,
): Promise<void> {
  const repos = createSupervisorRepos(createServiceClient());
  const current = await repos.policy.get();
  const keywords = input.search_keywords.map((s) => s.trim()).filter(Boolean);
  const weekly = discoverPolicyToWeeklyGoalsPatch(
    {
      search_keywords: keywords,
      goal_label: input.goal_label.trim() || null,
      active: input.active,
      exclude_keywords: input.exclude_keywords,
      max_candidates_per_tick: input.max_candidates_per_tick,
    },
    current.weekly_goals,
  );
  weekly.discover_active = input.active;
  weekly.discover_goal = input.goal_label.trim() || null;

  await repos.policy.update({
    discover_keywords: keywords,
    weekly_goals: weekly,
  });
}
