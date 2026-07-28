/**
 * Phase 3-5: Admin action_jobs history.
 */

import { detailUrl, parseActionJobFailure } from "@/lib/actionJobFailure";
import { createServiceClient } from "@/lib/supabase";

export type AdminActionRow = {
  id: string;
  actionType: string;
  status: string;
  risk: string;
  blogId: string | null;
  targetUrl: string | null;
  createdAt: string;
  completedAt: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
  error: string | null;
  workerTest: boolean;
  failure: {
    errorCode: string;
    errorMessage: string;
    failedStep: string;
    failedStepLabel: string;
    retryable: boolean;
    url: string | null;
    steps: string[];
    kind: "failure" | "skipped" | "excluded";
    summary: string;
  } | null;
};

export type AdminActionsScreenData = {
  rows: AdminActionRow[];
  counts: {
    total: number;
    planned: number;
    approved: number;
    executed: number;
    failed: number;
    skipped: number;
    running: number;
  };
};

function strRef(
  ref: Record<string, unknown> | null | undefined,
  ...keys: string[]
): string | null {
  if (!ref) return null;
  for (const key of keys) {
    const v = ref[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

export async function getAdminActionsScreenData(opts?: {
  limit?: number;
}): Promise<AdminActionsScreenData> {
  const db = createServiceClient();
  const limit = Math.max(1, Math.min(300, opts?.limit ?? 100));

  const { data, error } = await db
    .from("action_jobs")
    .select(
      "id, action_type, status, risk, target_ref, created_at, executed_at, updated_at, error, approved_at, approved_by",
    )
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    // approved_* columns may be missing before migration 008
    if (/approved_at|approved_by|schema cache/i.test(error.message)) {
      const fallback = await db
        .from("action_jobs")
        .select(
          "id, action_type, status, risk, target_ref, created_at, executed_at, updated_at, error",
        )
        .order("created_at", { ascending: false })
        .limit(limit);
      if (fallback.error) {
        throw new Error(`getAdminActionsScreenData: ${fallback.error.message}`);
      }
      return mapActionRows(fallback.data ?? []);
    }
    throw new Error(`getAdminActionsScreenData: ${error.message}`);
  }

  return mapActionRows(data ?? []);
}

function mapActionRows(
  data: Array<Record<string, unknown>>,
): AdminActionsScreenData {
  const rows: AdminActionRow[] = data.map((r) => {
    const ref = (r.target_ref ?? {}) as Record<string, unknown>;
    const blogId = strRef(ref, "blog_id", "blogId");
    const targetUrl =
      strRef(ref, "post_url", "blog_url", "url", "permalink") ??
      (blogId ? `https://m.blog.naver.com/${blogId}` : null);
    const executedAt =
      typeof r.executed_at === "string" ? r.executed_at : null;
    const status = String(r.status ?? "");
    const completedAt =
      executedAt ||
      (status === "failed" || status === "permanently_failed"
        ? typeof r.updated_at === "string"
          ? r.updated_at
          : null
        : null);

    const error = typeof r.error === "string" ? r.error : null;
    const parsed = parseActionJobFailure({
      error,
      targetRef: ref,
      status,
    });
    const isFailed =
      status === "failed" || status === "permanently_failed";
    const isSoft =
      status === "skipped" ||
      status === "excluded" ||
      (parsed != null && parsed.kind !== "failure");

    return {
      id: String(r.id),
      actionType: String(r.action_type ?? ""),
      status,
      risk: String(r.risk ?? ""),
      blogId,
      targetUrl,
      createdAt: String(r.created_at ?? ""),
      completedAt,
      approvedAt: typeof r.approved_at === "string" ? r.approved_at : null,
      approvedBy: typeof r.approved_by === "string" ? r.approved_by : null,
      error,
      workerTest: ref.worker_test === true,
      failure:
        (isFailed || isSoft) && parsed
          ? {
              errorCode: parsed.errorCode,
              errorMessage: parsed.errorMessage,
              failedStep: parsed.failedStep,
              failedStepLabel: parsed.failedStepLabel,
              retryable: parsed.retryable,
              url: detailUrl(parsed.detail) ?? targetUrl,
              steps: parsed.steps,
              kind: parsed.kind,
              summary: parsed.summary,
            }
          : null,
    };
  });

  const counts = {
    total: rows.length,
    planned: rows.filter((r) => r.status === "planned").length,
    approved: rows.filter((r) => r.status === "approved").length,
    executed: rows.filter((r) => r.status === "executed").length,
    failed: rows.filter(
      (r) => r.status === "failed" || r.status === "permanently_failed",
    ).length,
    skipped: rows.filter(
      (r) => r.status === "skipped" || r.status === "excluded",
    ).length,
    running: rows.filter((r) => r.status === "running").length,
  };

  return { rows, counts };
}
