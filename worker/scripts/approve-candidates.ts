/**
 * Phase 3-4: approve discovery-linked neighbor_request jobs by score.
 *
 * Usage:
 *   npm run approve:candidates -- --score-min=70 --limit=10
 *   npm run approve:candidates -- --score-min=70 --limit=10 --keyword=일상
 *   npm run approve:candidates -- --score-min=70 --limit=5 --by=cli:ops
 */

import { config as loadEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { approveCandidatesByScore } from "../src/jobs/approveJobs";
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

function parseNum(raw: string | null | undefined, fallback: number): number {
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

async function main() {
  const scoreMin = parseNum(
    argValue("score-min") ?? argValue("scoreMin") ?? argValue("min-score"),
    70,
  );
  const limit = parseNum(argValue("limit"), 10);
  const keyword = argValue("keyword");
  const approvedBy =
    argValue("by") ??
    argValue("approved-by") ??
    process.env.WORKER_APPROVED_BY?.trim() ??
    "cli";

  const db = createServiceClient();
  const summary = await approveCandidatesByScore(db, {
    scoreMin,
    limit,
    keyword,
    approvedBy,
  });

  console.info("[approve:candidates] summary", summary);
  if (summary.errors.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(
    "[approve:candidates] failed",
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});
