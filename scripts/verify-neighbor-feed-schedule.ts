/**
 * Verify neighbor feed scheduled collect (no full Agent Tick required).
 *
 * Usage:
 *   npm run verify:neighbor-feed-schedule
 *   npm run verify:neighbor-feed-schedule -- --status
 *   npm run verify:neighbor-feed-schedule -- --run
 *
 * --status  Load policy from Supabase and print due decision
 * --run     Call maybeRunScheduledNeighborFeedCollect() (may collect)
 */

import "dotenv/config";

import { shouldRunScheduledNeighborFeedCollect } from "../src/domain/neighbor/feedSchedule";

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`  OK  ${msg}`);
}

function runUnitChecks() {
  console.log("\n=== Schedule unit checks (daily_1) ===");
  const hour = 9;

  const afterAnchor = new Date(Date.UTC(2026, 6, 28, 1, 0, 0)); // 10:00 KST
  assert(
    shouldRunScheduledNeighborFeedCollect(
      {
        feed_collect_mode: "daily_1",
        feed_collect_hour: hour,
        feed_last_collect_at: null,
      },
      afterAnchor,
    ),
    "no last_collect_at → first run due after hour",
  );

  const beforeAnchor = new Date(Date.UTC(2026, 6, 27, 23, 0, 0)); // 08:00 KST Jul 28
  assert(
    !shouldRunScheduledNeighborFeedCollect(
      {
        feed_collect_mode: "daily_1",
        feed_collect_hour: hour,
        feed_last_collect_at: null,
      },
      beforeAnchor,
    ),
    "before feed_collect_hour → not due",
  );

  const lastToday = new Date(Date.UTC(2026, 6, 28, 1, 30, 0)).toISOString();
  assert(
    !shouldRunScheduledNeighborFeedCollect(
      {
        feed_collect_mode: "daily_1",
        feed_collect_hour: hour,
        feed_last_collect_at: lastToday,
      },
      afterAnchor,
    ),
    "already collected today (KST) → not due",
  );

  const lastYesterday = new Date(Date.UTC(2026, 6, 27, 1, 0, 0)).toISOString();
  assert(
    shouldRunScheduledNeighborFeedCollect(
      {
        feed_collect_mode: "daily_1",
        feed_collect_hour: hour,
        feed_last_collect_at: lastYesterday,
      },
      afterAnchor,
    ),
    "last collect yesterday → due again",
  );

  assert(
    !shouldRunScheduledNeighborFeedCollect(
      {
        feed_collect_mode: "manual",
        feed_collect_hour: hour,
        feed_last_collect_at: null,
      },
      afterAnchor,
    ),
    "raw mode=manual → shouldRun false (coerce happens in service)",
  );

  console.log(
    `  (ref) KST≈${new Date(Date.now() + KST_OFFSET_MS).toISOString().replace("Z", "+09approx")}`,
  );
}

async function printStatus() {
  console.log("\n=== Live policy status ===");
  const { getNeighborPolicy } = await import(
    "../src/domain/policy/neighborPolicy"
  );
  const { createServiceClient } = await import("../src/lib/supabase");
  const { createSupervisorRepos } = await import("../src/repositories/index");

  const repos = createSupervisorRepos(createServiceClient());
  const np = getNeighborPolicy(await repos.policy.get());
  const schedulePolicy =
    np.feed_collect_mode === "manual"
      ? { ...np, feed_collect_mode: "daily_1" as const }
      : np;
  const due = shouldRunScheduledNeighborFeedCollect(schedulePolicy);
  console.log({
    savedMode: np.feed_collect_mode,
    scheduleMode: schedulePolicy.feed_collect_mode,
    feed_collect_hour: np.feed_collect_hour,
    feed_last_collect_at: np.feed_last_collect_at,
    feed_lookback_days: np.feed_lookback_days,
    feed_max_per_neighbor_day: np.feed_max_per_neighbor_day,
    dueNow: due,
  });
}

async function runCollect() {
  console.log("\n=== maybeRunScheduledNeighborFeedCollect() ===");
  const { maybeRunScheduledNeighborFeedCollect } = await import(
    "../src/services/neighborFeedScheduleService"
  );
  const outcome = await maybeRunScheduledNeighborFeedCollect();
  console.log("outcome:", outcome);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  runUnitChecks();

  if (args.has("--status") || args.has("--run")) {
    await printStatus();
  }

  if (args.has("--run")) {
    await runCollect();
  } else if (!args.has("--status")) {
    console.log(
      "\nTip: add --status (read policy) or --run (invoke scheduled collect).",
    );
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
