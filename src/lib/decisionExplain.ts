import type { DecisionRecord } from "@/workers/types";

/** UI-only view of DecisionRecord explain fields (consume-only). */
export interface DecisionExplainView {
  decisionId: string;
  reason_short: string;
  explanation: string;
  reasons: string[];
  rule_ids: string[];
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.trim() !== "");
}

/** Map DecisionRecord → Explain view. Does not alter Decision Engine. */
export function toDecisionExplainView(
  record: DecisionRecord,
): DecisionExplainView {
  const detail = record.reason_detail ?? {};
  const explanation =
    typeof detail.explanation === "string" && detail.explanation.trim()
      ? detail.explanation
      : record.reason_short;
  const reasons = asStringArray(detail.reasons);
  const rule_ids = asStringArray(detail.rule_ids);
  if (rule_ids.length === 0 && Array.isArray(detail.rule_ids) === false) {
    // legacy: top-level may miss; ignore
  }

  return {
    decisionId: record.id,
    reason_short: record.reason_short,
    explanation,
    reasons:
      reasons.length > 0
        ? reasons
        : [record.reason_short].filter(Boolean),
    rule_ids,
  };
}

/** Supervisor-facing reason line (hide raw rule id brackets). */
export function formatExplainReason(reason: string): string {
  const cleaned = reason.replace(/^\[[^\]]+\]\s*/, "").trim();
  return cleaned || reason;
}
