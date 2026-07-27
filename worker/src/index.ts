/**
 * CDP Worker entry
 * Phase 2-1: Naver session check
 * Phase 2-2: visit
 * Phase 2-3: like (max 1)
 * Phase 2-4: comment (max 1)
 * Phase 2-5: neighbor_request (max 1)
 * Phase 3-3: execution safety (daily limit / cooldown / delay / dry-run / approve gate)
 *
 * Usage: npm start (from worker/)
 *
 * Safety env:
 *   WORKER_DRY_RUN=true
 *   WORKER_ALLOW_PLANNED_TEST=true   # planned + worker_test executable
 *   WORKER_DAILY_LIKE_LIMIT / COMMENT / NEIGHBOR
 *   WORKER_ACTION_COOLDOWN_HOURS
 *   WORKER_ACTION_DELAY_MIN_MS / MAX_MS
 */

import { config as loadEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  connectOverCdp,
  disconnectCdp,
  resolveCdpUrl,
} from "./browser/cdpClient";
import {
  COMMENT_JOB_LIMIT,
  detectPendingActionJobs,
  LIKE_JOB_LIMIT,
  NEIGHBOR_REQUEST_JOB_LIMIT,
  runCommentActionJobs,
  runLikeActionJobs,
  runNeighborRequestActionJobs,
  runVisitActionJobs,
} from "./jobs/actionJobRunner";
import {
  isDryRun,
  logSafetyConfig,
} from "./jobs/executionSafety";
import { createServiceClient } from "./lib/supabase";
import { checkNaverSession } from "./naver/naverSessionChecker";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

loadEnv({ path: path.join(repoRoot, ".env") });
loadEnv({ path: path.join(repoRoot, "worker", ".env"), override: true });

async function main() {
  console.info("[cdp-worker] start");
  logSafetyConfig();

  const db = createServiceClient();
  const dryRun = isDryRun();

  if (dryRun) {
    console.info(
      "[cdp-worker] DRY RUN — listing executable jobs only (no CDP / no status change)",
    );
    const { jobs, plans } = await detectPendingActionJobs(db, 20);
    console.info("[cdp-worker] detect summary", {
      neighborRequestFound: jobs.length,
      plansReady: plans.length,
    });

    // Also preview like/comment/neighbor queues without claiming.
    const like = await runLikeActionJobs(db, null, LIKE_JOB_LIMIT);
    console.info("[cdp-worker] like dry-run summary", like);

    const comment = await runCommentActionJobs(
      db,
      null,
      COMMENT_JOB_LIMIT,
    );
    console.info("[cdp-worker] comment dry-run summary", comment);

    const neighbor = await runNeighborRequestActionJobs(
      db,
      null,
      NEIGHBOR_REQUEST_JOB_LIMIT,
    );
    console.info("[cdp-worker] neighbor_request dry-run summary", neighbor);

    console.info("[cdp-worker] done (dry-run)");
    return;
  }

  console.info(`[cdp-worker] CDP_URL=${resolveCdpUrl()}`);
  const conn = await connectOverCdp();
  console.info("[cdp-worker] Chrome CDP connection: OK");

  try {
    const session = await checkNaverSession(conn);
    if (!session.loggedIn) {
      console.error(
        "[cdp-worker] abort: Naver login required before visit/like/comment/neighbor_request execution",
      );
      console.error(`[cdp-worker] ${session.error ?? "naver_not_logged_in"}`);
      process.exitCode = 1;
      return;
    }
    console.info("[cdp-worker] Naver session: OK");

    const { jobs, plans } = await detectPendingActionJobs(db, 20);
    console.info("[cdp-worker] detect summary", {
      neighborRequestFound: jobs.length,
      plansReady: plans.length,
    });

    const visit = await runVisitActionJobs(db, conn.context, 10);
    console.info("[cdp-worker] visit summary", visit);

    const like = await runLikeActionJobs(db, conn.context, LIKE_JOB_LIMIT);
    console.info("[cdp-worker] like summary", like);

    const comment = await runCommentActionJobs(
      db,
      conn.context,
      COMMENT_JOB_LIMIT,
    );
    console.info("[cdp-worker] comment summary", comment);

    const neighbor = await runNeighborRequestActionJobs(
      db,
      conn.context,
      NEIGHBOR_REQUEST_JOB_LIMIT,
    );
    console.info("[cdp-worker] neighbor_request summary", neighbor);
  } finally {
    await disconnectCdp(conn);
  }

  console.info("[cdp-worker] done");
}

main().catch((err) => {
  console.error("[cdp-worker] fatal", err instanceof Error ? err.message : err);
  process.exit(1);
});
