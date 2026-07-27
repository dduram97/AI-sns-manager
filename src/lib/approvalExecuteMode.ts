/**
 * Approval Inbox execute modes for comment / like / both (bundle).
 * No Decision Engine / Adapter changes.
 */

export type ApprovalExecuteMode = "comment" | "like" | "both";

export const APPROVAL_EXECUTE_MODES: ApprovalExecuteMode[] = [
  "comment",
  "like",
  "both",
];

export function isApprovalExecuteMode(
  value: unknown,
): value is ApprovalExecuteMode {
  return value === "comment" || value === "like" || value === "both";
}

export function parseApprovalExecuteMode(
  value: unknown,
  fallback: ApprovalExecuteMode = "comment",
): ApprovalExecuteMode {
  return isApprovalExecuteMode(value) ? value : fallback;
}

export function approvalModeLabel(mode: ApprovalExecuteMode): string {
  switch (mode) {
    case "comment":
      return "댓글만";
    case "like":
      return "공감만";
    case "both":
      return "댓글+공감";
  }
}

/** Modes available for an inbox card given primary job + bundled like. */
export function resolveAvailableModes(input: {
  actionType: string;
  hasBundledLike: boolean;
}): ApprovalExecuteMode[] {
  if (input.actionType === "neighbor_request") return [];
  if (input.actionType === "comment" && input.hasBundledLike) {
    return ["comment", "like", "both"];
  }
  if (input.actionType === "comment") return ["comment"];
  if (input.actionType === "like") return ["like"];
  if (input.actionType === "threads_reply") return ["comment"];
  return [];
}

export function defaultApprovalExecuteMode(
  modes: ApprovalExecuteMode[],
): ApprovalExecuteMode {
  if (modes.includes("both")) return "both";
  if (modes.includes("comment")) return "comment";
  if (modes.includes("like")) return "like";
  return "comment";
}
