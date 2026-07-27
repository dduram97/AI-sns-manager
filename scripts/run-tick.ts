/**
 * Run one Agent Tick against Supabase.
 * Usage: npm run tick
 */

import { createServiceClient } from "../src/lib/supabase";
import { createRepositories } from "../src/repositories/index";
import { tick } from "../src/workers/tick";

async function main() {
  const repos = createRepositories(createServiceClient());
  const result = await tick(repos);

  console.log("\n=== Agent Tick Result ===");
  for (const line of result.logs) console.log(" ", line);

  console.log("\nBrief:", {
    agent_status: result.brief.agent_status,
    approval_count: result.brief.approval_count,
    intervention_minutes_est: result.brief.intervention_minutes_est,
    activity_summary: result.brief.activity_summary,
    time_saved_minutes_est: result.brief.time_saved_minutes_est,
  });

  console.log("\nPersons processed:", result.personsProcessed);
  console.log(
    "Decisions:",
    result.decisions.map((d) => d.decision_type),
  );
  console.log("Action jobs:", result.actionJobsCreated.length);
  console.log("Approvals:", result.approvalsCreated.length);
  console.log("Activities:", result.activitiesCreated.length);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
