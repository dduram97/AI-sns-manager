/** More screen view types — safe for client `import type`. */

import type { DiscoverPolicy } from "@/domain/policy/discoverPolicy";
import type { ActionType } from "@/workers/types";
import type { PolicyProfile } from "@/workers/types";

export type ChannelConnectionView = {
  channel: "blog" | "threads" | "instagram";
  label: string;
  status: string;
  statusLabel: string;
  readyHint: string;
  last_synced_at: string | null;
};

export type TickLogView = {
  startedAt: string;
  finishedAt: string;
  timeLabel: string;
  perceptionsProcessed: number;
  approvalsCreated: number;
  actionsExecuted: number;
  actionsFailed: number;
  ok: boolean;
  error: string | null;
  sourceLabel: string | null;
};

export type ExecutionLogStatus = "executed" | "failed" | "blocked";

export type RecentExecutionView = {
  id: string;
  actionType: ActionType;
  actionLabel: string;
  status: ExecutionLogStatus;
  statusLabel: string;
  personLabel: string;
  timeLabel: string;
  error: string | null;
};

export type AgentExecutionLogData = {
  recentTick: TickLogView | null;
  recentExecutions: RecentExecutionView[];
};

export type MoreScreenData = {
  policy: PolicyProfile;
  automation: {
    lowRiskAuto: boolean;
    visitAuto: boolean;
    likeAuto: boolean;
    commentMode: "approval_required";
    mutualRequestMode: "approval_required";
    preset: string;
  };
  limits: {
    visit: number | null;
    like: number | null;
    comment: number | null;
    neighbor_request: number | null;
  };
  tone: {
    base: string;
    preferredPhrases: string[];
    bannedPhrases: string[];
    commentExamples: string[];
  };
  discover: DiscoverPolicy;
  channels: ChannelConnectionView[];
  executionLog: AgentExecutionLogData;
};
