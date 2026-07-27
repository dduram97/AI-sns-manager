/**
 * Agent Tick execution log (ops, no UI).
 * Persist last run on brief.status_detail + optional JSONL file.
 */

import fs from "node:fs";
import path from "node:path";
import type { DatabaseClient } from "../lib/supabase";

export type TickRunLogEntry = {
  started_at: string;
  finished_at: string;
  perceptions_processed: number;
  approvals_created: number;
  actions_executed: number;
  actions_failed: number;
  ok: boolean;
  error?: string | null;
  source?: "cron" | "manual" | "unknown";
};

function fileLogPath(): string {
  return (
    process.env.AGENT_TICK_LOG_PATH ??
    path.join(process.cwd(), ".data", "logs", "agent-tick.jsonl")
  );
}

export function appendTickRunFileLog(entry: TickRunLogEntry): void {
  try {
    const p = fileLogPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (err) {
    console.warn(
      "[tickRunLog] file write skipped:",
      err instanceof Error ? err.message : err,
    );
  }
}

/** Store last tick run on brief_snapshots.status_detail (durable on Vercel). */
export async function persistTickRunLog(
  db: DatabaseClient,
  entry: TickRunLogEntry,
): Promise<void> {
  appendTickRunFileLog(entry);
  console.log(
    `[tickRunLog] start=${entry.started_at} perceptions=${entry.perceptions_processed} approvals=${entry.approvals_created} actions=${entry.actions_executed} failed=${entry.actions_failed} ok=${entry.ok}`,
  );

  try {
    const { data: row, error } = await db
      .from("brief_snapshots")
      .select("status_detail, updated_at")
      .eq("id", true)
      .single();
    if (error || !row) {
      console.warn("[tickRunLog] brief missing:", error?.message);
      return;
    }
    const detail = {
      ...((row.status_detail ?? {}) as Record<string, unknown>),
      last_tick_at: entry.finished_at,
      last_tick_run: entry,
    };
    await db
      .from("brief_snapshots")
      .update({ status_detail: detail })
      .eq("id", true)
      .eq("updated_at", row.updated_at);
  } catch (err) {
    console.warn(
      "[tickRunLog] brief persist failed:",
      err instanceof Error ? err.message : err,
    );
  }
}
