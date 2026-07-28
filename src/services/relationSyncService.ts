/**
 * Daily relation analysis batch runner (cron / manual).
 * Does not touch like automation adapters.
 */

import "server-only";

import { createServiceClient } from "@/lib/supabase";
import { syncReplyQueueFromInbound } from "@/services/replyQueueService";

const RUNNING_TTL_MS = 30 * 60_000; // 30m

export type RelationSyncSource = "cron" | "manual";

export type RelationSyncResult = {
  ok: boolean;
  status: "success" | "failed" | "skipped";
  runId: string | null;
  startedAt: string;
  finishedAt: string;
  rowsUpserted: number;
  skippedReason?: string;
  error?: string;
};

function startOfKstDayIso(now = new Date()): string {
  const kst = new Date(now.getTime() + 9 * 60 * 60_000);
  const y = kst.getUTCFullYear();
  const m = kst.getUTCMonth();
  const d = kst.getUTCDate();
  // KST midnight → UTC
  return new Date(Date.UTC(y, m, d, 0, 0, 0) - 9 * 60 * 60_000).toISOString();
}

async function findActiveOrTodaySuccess(source: RelationSyncSource): Promise<{
  skip: boolean;
  reason?: string;
  runId?: string;
}> {
  const db = createServiceClient();
  const sinceKst = startOfKstDayIso();

  const { data: running } = await db
    .from("relation_sync_runs")
    .select("id, started_at, status")
    .eq("status", "running")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (running?.started_at) {
    const age = Date.now() - Date.parse(String(running.started_at));
    if (Number.isFinite(age) && age < RUNNING_TTL_MS) {
      return {
        skip: true,
        reason: "already_running",
        runId: String(running.id),
      };
    }
    // Stale running → mark failed
    await db
      .from("relation_sync_runs")
      .update({
        status: "failed",
        finished_at: new Date().toISOString(),
        error: "stale_running_lock_cleared",
      })
      .eq("id", running.id);
  }

  // Cron: at most one successful run per KST day
  if (source === "cron") {
    const { data: todayOk } = await db
      .from("relation_sync_runs")
      .select("id")
      .eq("status", "success")
      .gte("started_at", sinceKst)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (todayOk?.id) {
      return {
        skip: true,
        reason: "already_succeeded_today_kst",
        runId: String(todayOk.id),
      };
    }
  }

  return { skip: false };
}

export async function runRelationSyncBatch(input?: {
  source?: RelationSyncSource;
  force?: boolean;
}): Promise<RelationSyncResult> {
  const source = input?.source ?? "cron";
  const startedAt = new Date().toISOString();
  const db = createServiceClient();

  if (!input?.force) {
    const gate = await findActiveOrTodaySuccess(source);
    if (gate.skip) {
      const finishedAt = new Date().toISOString();
      const { data: skipped } = await db
        .from("relation_sync_runs")
        .insert({
          started_at: startedAt,
          finished_at: finishedAt,
          status: "skipped",
          source,
          rows_upserted: 0,
          error: gate.reason ?? "skipped",
          meta: { prior_run_id: gate.runId ?? null },
        })
        .select("id")
        .maybeSingle();
      console.info("[relation_sync] skipped", {
        reason: gate.reason,
        priorRunId: gate.runId,
      });
      return {
        ok: true,
        status: "skipped",
        runId: skipped?.id ? String(skipped.id) : null,
        startedAt,
        finishedAt,
        rowsUpserted: 0,
        skippedReason: gate.reason,
      };
    }
  }

  const { data: runRow, error: insertErr } = await db
    .from("relation_sync_runs")
    .insert({
      started_at: startedAt,
      status: "running",
      source,
      rows_upserted: 0,
      meta: {},
    })
    .select("id")
    .single();

  if (insertErr || !runRow) {
    return {
      ok: false,
      status: "failed",
      runId: null,
      startedAt,
      finishedAt: new Date().toISOString(),
      rowsUpserted: 0,
      error: insertErr?.message ?? "failed_to_create_run",
    };
  }

  const runId = String(runRow.id);
  console.info("[relation_sync] start", { runId, source, startedAt });

  try {
    const result = await syncReplyQueueFromInbound();
    const finishedAt = new Date().toISOString();
    await db
      .from("relation_sync_runs")
      .update({
        status: "success",
        finished_at: finishedAt,
        rows_upserted: result.rowsUpserted,
        meta: {
          relationUsers: result.relationUsers,
          replyQueueRows: result.replyQueueRows,
          postsScanned: result.postsScanned ?? null,
          durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
        },
      })
      .eq("id", runId);

    console.info("[relation_sync] success", {
      runId,
      source,
      postsScanned: result.postsScanned ?? null,
      relationUsers: result.relationUsers,
      rowsUpserted: result.rowsUpserted,
      replyQueueRows: result.replyQueueRows,
      durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
      finishedAt,
    });

    return {
      ok: true,
      status: "success",
      runId,
      startedAt,
      finishedAt,
      rowsUpserted: result.rowsUpserted,
    };
  } catch (err) {
    const finishedAt = new Date().toISOString();
    const message = err instanceof Error ? err.message : String(err);
    await db
      .from("relation_sync_runs")
      .update({
        status: "failed",
        finished_at: finishedAt,
        error: message,
      })
      .eq("id", runId);
    console.error("[relation_sync] failed", { runId, error: message });
    return {
      ok: false,
      status: "failed",
      runId,
      startedAt,
      finishedAt,
      rowsUpserted: 0,
      error: message,
    };
  }
}

export async function getLastRelationSyncRun(): Promise<{
  startedAt: string | null;
  finishedAt: string | null;
  status: string | null;
  error: string | null;
  rowsUpserted: number;
} | null> {
  const db = createServiceClient();
  const { data } = await db
    .from("relation_sync_runs")
    .select("started_at, finished_at, status, error, rows_upserted")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  return {
    startedAt: data.started_at ? String(data.started_at) : null,
    finishedAt: data.finished_at ? String(data.finished_at) : null,
    status: data.status ? String(data.status) : null,
    error: data.error ? String(data.error) : null,
    rowsUpserted: Number(data.rows_upserted ?? 0) || 0,
  };
}
