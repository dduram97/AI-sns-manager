/**
 * Phase 3-1/3-2: run keyword candidate discovery → scored planned neighbor_request.
 *
 * Usage:
 *   npm run discover:candidates
 *   npm run discover:candidates -- --keyword=일상 --limit=50
 *   npm run discover:candidates -- --keyword=일상 --limit=50 --job-max=10 --min-score=55
 *   npm run discover:candidates -- --dry-run
 *
 * Env:
 *   WORKER_DISCOVERY_KEYWORD (default: 일상)
 *   WORKER_DISCOVERY_LIMIT (default: 10) — search pool
 *   WORKER_DISCOVERY_JOB_MAX (default: 10) — max planned jobs (top scores)
 *   WORKER_DISCOVERY_MIN_SCORE (default: 55)
 *   WORKER_DISCOVERY_MESSAGE — draft_body for created jobs
 *   NAVER_CLIENT_ID / NAVER_CLIENT_SECRET
 *
 * Does NOT run CDP execution — creates planned jobs only.
 */

import { config as loadEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DISCOVERY_DEFAULT_KEYWORD,
  DISCOVERY_DEFAULT_LIMIT,
  runCandidateDiscovery,
} from "../src/jobs/candidateDiscovery";
import {
  DISCOVERY_DEFAULT_JOB_MAX,
  DISCOVERY_DEFAULT_MIN_SCORE,
} from "../src/jobs/candidateScore";
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
  const keyword =
    argValue("keyword") ??
    process.env.WORKER_DISCOVERY_KEYWORD?.trim() ??
    DISCOVERY_DEFAULT_KEYWORD;
  const limit = parseNum(
    argValue("limit") ?? process.env.WORKER_DISCOVERY_LIMIT,
    DISCOVERY_DEFAULT_LIMIT,
  );
  const jobMax = parseNum(
    argValue("job-max") ??
      argValue("jobMax") ??
      process.env.WORKER_DISCOVERY_JOB_MAX,
    Number.isFinite(DISCOVERY_DEFAULT_JOB_MAX)
      ? DISCOVERY_DEFAULT_JOB_MAX
      : 10,
  );
  const minScore = parseNum(
    argValue("min-score") ??
      argValue("minScore") ??
      process.env.WORKER_DISCOVERY_MIN_SCORE,
    Number.isFinite(DISCOVERY_DEFAULT_MIN_SCORE)
      ? DISCOVERY_DEFAULT_MIN_SCORE
      : 55,
  );
  const dryRun =
    process.argv.includes("--dry-run") ||
    process.env.WORKER_DISCOVERY_DRY_RUN === "1";

  const db = createServiceClient();
  const summary = await runCandidateDiscovery(db, {
    keyword,
    limit,
    jobMax,
    minScore,
    dryRun,
  });

  console.info("[discover:candidates] summary", summary);
  if (summary.errors.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(
    "[discover:candidates] failed",
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});
