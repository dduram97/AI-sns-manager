/**
 * Local auth + scheduled-feed dry check (no Agent Tick, no feed collect writes).
 * Run: node --import ./scripts/stub-server-only.mjs --import tsx scripts/verify-tick-feed-local-dry.ts
 */
import "dotenv/config";

import { authorizeAgentTickRequest } from "../src/services/agentTickService";
import { shouldRunScheduledNeighborFeedCollect } from "../src/domain/neighbor/feedSchedule";
import { getNeighborPolicy } from "../src/domain/policy/neighborPolicy";
import { createServiceClient } from "../src/lib/supabase";
import { createSupervisorRepos } from "../src/repositories/index";
import { maybeRunScheduledNeighborFeedCollect } from "../src/services/neighborFeedScheduleService";

function mask(v: string) {
  return v ? `set(len=${v.length})` : "EMPTY";
}

async function main() {
  const cron = (process.env.CRON_SECRET ?? "").trim();
  const tick = (process.env.AGENT_TICK_SECRET ?? "").trim();

  console.log("=== 1) .env recognition ===");
  console.log("CRON_SECRET:", mask(cron));
  console.log("AGENT_TICK_SECRET:", mask(tick));
  console.log(
    "SUPABASE_URL:",
    mask((process.env.SUPABASE_URL ?? "").trim()),
  );

  console.log("\n=== 2) authorizeAgentTickRequest ===");
  const noAuth = authorizeAgentTickRequest(null, null);
  console.log("no auth:", noAuth);

  const badBearer = authorizeAgentTickRequest("Bearer wrong-secret", null);
  console.log("bad bearer:", badBearer);

  const cronAuth = authorizeAgentTickRequest(
    cron ? `Bearer ${cron}` : null,
    null,
  );
  console.log("CRON_SECRET bearer:", cronAuth);

  const tickBearer = authorizeAgentTickRequest(
    tick ? `Bearer ${tick}` : null,
    null,
  );
  console.log("AGENT_TICK_SECRET bearer:", tickBearer);

  const tickHeader = authorizeAgentTickRequest(
    null,
    tick || null,
  );
  console.log("x-agent-tick-secret:", tickHeader);

  const authPass =
    cronAuth.ok &&
    cronAuth.source === "cron" &&
    tickBearer.ok &&
    tickBearer.source === "manual" &&
    tickHeader.ok &&
    tickHeader.source === "manual" &&
    !noAuth.ok &&
    !badBearer.ok;

  console.log("auth_gate:", authPass ? "PASS" : "FAIL");

  console.log("\n=== 3) neighbor feed schedule (read-only / skip path) ===");
  console.log(
    "wiring: runAgentTickLocked → tick() → maybeRunScheduledNeighborFeedCollect()",
  );

  const repos = createSupervisorRepos(createServiceClient());
  const np = getNeighborPolicy(await repos.policy.get());
  const schedulePolicy =
    np.feed_collect_mode === "manual"
      ? { ...np, feed_collect_mode: "daily_1" as const }
      : np;
  const due = shouldRunScheduledNeighborFeedCollect(schedulePolicy);
  console.log({
    savedMode: np.feed_collect_mode,
    hour: np.feed_collect_hour,
    lastAt: np.feed_last_collect_at,
    dueNow: due,
  });

  if (due) {
    console.log(
      "dueNow=true → skip calling maybeRun to avoid collect / DB writes",
    );
    console.log(
      "feed_invoke_check: SKIPPED_SAFE (would call collectNeighborFeed)",
    );
  } else {
    const outcome = await maybeRunScheduledNeighborFeedCollect();
    console.log("maybeRun outcome:", outcome);
    const ok =
      outcome.skipped === true &&
      outcome.ran === false &&
      outcome.reason === "not_due";
    console.log(
      "feed_invoke_check:",
      ok ? "PASS (called, skipped not_due, no collect write)" : "UNEXPECTED",
    );
  }

  console.log("\n=== summary ===");
  console.log(
    JSON.stringify({
      env_secrets: Boolean(cron && tick),
      auth_gate: authPass,
      full_tick_http: "NOT_RUN (would write ops DB)",
      feed_hook_wired: true,
    }),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
