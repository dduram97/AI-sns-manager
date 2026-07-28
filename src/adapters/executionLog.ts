/**
 * Append-only ActionJob execution log (Live ops, no UI).
 */

import fs from "node:fs";
import path from "node:path";

export type ExecutionLogEntry = {
  at: string;
  job_id: string;
  action_type: string;
  person_id: string;
  status: "executed" | "failed" | "blocked" | "running" | "skipped" | "excluded";
  ok: boolean;
  error?: string | null;
  retry_count?: number;
  mode?: string;
  skipped?: boolean;
};

function logPath(): string {
  return (
    process.env.ACTION_EXECUTION_LOG_PATH ??
    path.join(process.cwd(), ".data", "logs", "action-execution.jsonl")
  );
}

export function appendExecutionLog(entry: ExecutionLogEntry): void {
  try {
    const p = logPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (err) {
    console.warn(
      "[executionLog] write failed:",
      err instanceof Error ? err.message : err,
    );
  }
}
