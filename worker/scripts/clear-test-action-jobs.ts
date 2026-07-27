/**
 * Dev/verify helper: delete only worker test action_jobs.
 *
 * Safety: deletes rows where target_ref.worker_test === true only.
 * Production / non-test jobs are never touched.
 *
 * Usage:
 *   npm run test:clear
 *   npm run test:clear -- --dry-run
 */

import { config as loadEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createServiceClient } from "../src/lib/supabase";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

loadEnv({ path: path.join(repoRoot, ".env") });
loadEnv({ path: path.join(repoRoot, "worker", ".env"), override: true });

const dryRun = process.argv.includes("--dry-run");

async function main() {
  const db = createServiceClient();

  // PostgREST filter on jsonb boolean
  const { data: jobs, error: listErr } = await db
    .from("action_jobs")
    .select("id, action_type, status, target_ref, created_at")
    .eq("target_ref->>worker_test", "true")
    .order("created_at", { ascending: false });

  if (listErr) {
    throw new Error(`list test jobs: ${listErr.message}`);
  }

  const rows = jobs ?? [];
  console.info(`[test:clear] matched worker_test jobs count=${rows.length}`);
  for (const row of rows.slice(0, 20)) {
    console.info("[test:clear] candidate", {
      id: row.id,
      action_type: row.action_type,
      status: row.status,
      smoke: (row.target_ref as Record<string, unknown> | null)?.smoke,
    });
  }
  if (rows.length > 20) {
    console.info(`[test:clear] ... and ${rows.length - 20} more`);
  }

  if (rows.length === 0) {
    console.info("[test:clear] nothing to delete");
    return;
  }

  if (dryRun) {
    console.info("[test:clear] dry-run — no deletes");
    return;
  }

  const ids = rows.map((r) => String(r.id));
  const { error: delErr, count } = await db
    .from("action_jobs")
    .delete({ count: "exact" })
    .in("id", ids)
    .eq("target_ref->>worker_test", "true");

  if (delErr) {
    throw new Error(`delete test jobs: ${delErr.message}`);
  }

  console.info(`[test:clear] deleted count=${count ?? ids.length}`);
}

main().catch((err) => {
  console.error(
    "[test:clear] failed",
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});
