/**
 * Approval Inbox types — safe for client `import type` (no runtime Node deps).
 */

import type { ApprovalExecuteMode } from "@/lib/approvalExecuteMode";
import type { CommentSituation } from "@/lib/commentSituation";
import type {
  ActionJob,
  ApprovalItem,
  Person,
  Workflow,
} from "@/workers/types";

export type ApprovalInboxSource = "neighbor_feed" | null;

export interface ApprovalInboxItem {
  approval: ApprovalItem;
  person: Person;
  job: ActionJob;
  workflow: Workflow;
  reasonShort: string;
  draftBody: string;
  actionLabel: string;
  bundleId: string | null;
  hasBundledLike: boolean;
  availableModes: ApprovalExecuteMode[];
  commentSituation: CommentSituation | null;
  postTitle: string | null;
  postSummary: string | null;
  source: ApprovalInboxSource;
  publishedAt: string | null;
  mutualRequest: {
    blogName: string;
    recommendReasons: string[];
  } | null;
  decisionExplain: {
    decisionId: string;
    reason_short: string;
    explanation: string;
    reasons: string[];
    rule_ids: string[];
  } | null;
}

export interface ApprovalHistoryItem {
  approval: ApprovalItem;
  person: Person;
  job: ActionJob;
  draftBody: string;
  postTitle: string | null;
  executeMode: ApprovalExecuteMode | null;
  resolvedAt: string;
  success: boolean;
  actionLabel: string;
}

export type ApprovalHistoryPage = {
  items: ApprovalHistoryItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  successCount: number;
  rangeLabel: string;
  fromIso: string;
  toIso: string;
};

export type DuplicatePostHit = {
  approvalId: string;
  title: string;
  priorMode: "comment" | "like" | "both";
  lastExecutedAt: string;
  postKey: string;
};
