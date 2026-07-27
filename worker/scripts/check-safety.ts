/**
 * Phase 3-3 safety gate smoke checks (no CDP).
 *
 * Usage:
 *   npm run check:safety
 *   WORKER_DAILY_LIKE_LIMIT=0 npm run check:safety
 *   WORKER_ALLOW_PLANNED_TEST=false npm run check:safety
 */

import { config as loadEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  allowPlannedTestJobs,
  dailyLimitFor,
  isDryRun,
  isJobStatusExecutable,
  logSafetyConfig,
} from "../src/jobs/executionSafety";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

loadEnv({ path: path.join(repoRoot, ".env") });
loadEnv({ path: path.join(repoRoot, "worker", ".env"), override: true });

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`assert failed: ${msg}`);
}

async function main() {
  logSafetyConfig();

  const plannedTest = {
    id: "t1",
    action_type: "like",
    status: "planned",
    target_ref: { worker_test: true, post_url: "https://m.blog.naver.com/a/1" },
  };
  const plannedProd = {
    id: "t2",
    action_type: "neighbor_request",
    status: "planned",
    target_ref: { blog_id: "foo", blog_url: "https://m.blog.naver.com/foo" },
  };
  const approved = {
    id: "t3",
    action_type: "comment",
    status: "approved",
    target_ref: { post_url: "https://m.blog.naver.com/a/1" },
  };

  if (allowPlannedTestJobs()) {
    assert(
      isJobStatusExecutable(plannedTest),
      "worker_test planned should be executable when WORKER_ALLOW_PLANNED_TEST",
    );
  } else {
    assert(
      !isJobStatusExecutable(plannedTest),
      "worker_test planned blocked when WORKER_ALLOW_PLANNED_TEST=false",
    );
  }

  assert(
    !isJobStatusExecutable(plannedProd),
    "non-test planned must be blocked (needs approved)",
  );
  assert(isJobStatusExecutable(approved), "approved always executable");

  console.info("[check:safety] status gate OK", {
    allowPlannedTest: allowPlannedTestJobs(),
    dryRun: isDryRun(),
    dailyLike: dailyLimitFor("like"),
    dailyComment: dailyLimitFor("comment"),
    dailyNeighbor: dailyLimitFor("neighbor_request"),
  });
  console.info("[check:safety] done");
}

main().catch((err) => {
  console.error("[check:safety] failed", err instanceof Error ? err.message : err);
  process.exit(1);
});
