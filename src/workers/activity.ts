/**
 * Activity Projection — persists report rows to activity_items.
 */

import type { Repositories } from "../repositories/index";
import type {
  ActionJob,
  ActivityItem,
  ActivityKind,
  DecisionOutput,
  DecisionRecord,
  Workflow,
} from "./types";

export async function projectActivity(
  repos: Repositories,
  args: {
    workflow: Workflow;
    output: DecisionOutput;
    record: DecisionRecord;
    stageChanged: boolean;
    job?: ActionJob;
  },
): Promise<ActivityItem[]> {
  const created: ActivityItem[] = [];

  const push = async (
    kind: ActivityKind,
    summary: string,
    action_job_id: string | null = null,
  ) => {
    const item = await repos.insertActivity({
      workflow_id: args.workflow.id,
      person_id: args.workflow.person_id,
      decision_id: args.record.id,
      action_job_id,
      kind,
      summary,
    });
    created.push(item);
  };

  if (args.stageChanged) {
    await push(
      "stage_changed",
      `단계 변경 → ${args.workflow.current_stage} (${args.workflow.current_state})`,
    );
  }

  switch (args.output.kind) {
    case "observe":
      await push("observed", args.output.reason_short);
      await repos.incrementOutcomeCounters({ observe_count: 1 });
      break;
    case "delay":
      await push(
        "waiting",
        `대기: ${args.output.waiting_for ?? "delay"} until ${args.output.delay_until}`,
      );
      await repos.incrementOutcomeCounters({ waiting_count: 1 });
      break;
    case "skip":
      await push("blocked", args.output.reason_short);
      break;
    case "create_action":
      // executed activity is written by executeActionJob.applyChannelSuccess
      break;
    case "create_approval":
      if (args.job) {
        await push(
          "approval_created",
          `승인 대기: ${args.job.action_type} · ${args.output.reason_short}`,
          args.job.id,
        );
      }
      break;
    case "workflow_update":
      await push("stage_changed", args.output.reason_short);
      break;
  }

  return created;
}
