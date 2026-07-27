/**
 * Phase 3-4: approve a single planned action_job → approved.
 *
 * Usage:
 *   npm run approve:job -- --id={job_id}
 *   npm run approve:job -- --id={job_id} --by=cli:dohee
 */

import { config as loadEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { approveJobById } from "../src/jobs/approveJobs";
import { createServiceClient } from "../src/lib/supabase";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

loadEnv({ path: path.join(repoRoot, ".env") });
loadEnv({ path: path.join(repoRoot, "worker", ".env"), override: true });

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  for (const a of process.argv.slice(2)) {
    if (a.startsWith(prefix)) return a.slice(prefix.length).trim() || null;
    if (a === `--${name}`) {
      const idx = process.argv.indexOf(a);
      const next = process.argv[idx + 1];
      if (next && !next.startsWith("--")) return next.trim();
    }
  }
  return null;
}

async function main() {
  const jobId = argValue("id") ?? argValue("job") ?? argValue("job-id");
  if (!jobId) {
    throw new Error(
      "job id required. Example:\n  npm run approve:job -- --id=<uuid>",
    );
  }
  const approvedBy =
    argValue("by") ??
    argValue("approved-by") ??
    process.env.WORKER_APPROVED_BY?.trim() ??
    "cli";

  const db = createServiceClient();
  const result = await approveJobById(db, { jobId, approvedBy });

  if (!result.ok) {
    console.error("[approve:job] failed", result);
    process.exitCode = 1;
    return;
  }

  console.info("[approve:job] ok", result);
}

main().catch((err) => {
  console.error(
    "[approve:job] failed",
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});
