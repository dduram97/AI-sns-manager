/**
 * Agent Tick — ARCHITECTURE_SPEC v2.0
 * Recovery → Sync → Perception → Decision → Workflow → Approval/Action → Activity → Brief
 * All persistence via Supabase repositories.
 */

import {
  createRepositories,
  type Repositories,
} from "../repositories/index";
import { createServiceClient } from "../lib/supabase";
import { projectActivity } from "./activity";
import {
  enqueueLowRiskAction,
  resetLowRiskLikeBatchState,
} from "./action";
import { enqueueApproval } from "./approval";
import { refreshBriefSnapshot } from "./brief";
import { loadDecisionContext } from "./context";
import { runDecision } from "./decision";
import { touchOutcome } from "./outcome";
import {
  loadUnprocessedPerceptions,
  markPerceptionsProcessed,
} from "./perception";
import { ingestDiscoverCandidates } from "./discover";
import { runActionJobRecovery } from "./recovery";
import { ingestNaverBlogPerceptions } from "./sync";
import type {
  ActionCandidate,
  DecisionOutput,
  PerceptionEvent,
  TickResult,
} from "./types";
import { applyWorkflowUpdate } from "./workflow";

/** Enrich Action/Approval target_ref from new_post perception (Decision Engine untouched). */
function enrichTargetFromPerceptions(
  target: Record<string, unknown> | undefined,
  perceptions: PerceptionEvent[],
): Record<string, unknown> {
  const pe = perceptions.find((p) => p.event_type === "new_post");
  const base = { ...(target ?? {}) };
  if (!pe) return base;
  const p = pe.payload ?? {};
  return {
    ...base,
    post_url: (p.post_url as string) ?? base.post_url,
    blog_id: (p.blog_id as string) ?? base.blog_id,
    post_id: (p.post_id as string) ?? (p.log_no as string) ?? base.post_id,
    title: (p.title as string) ?? base.title,
    content_summary:
      (p.content_summary as string) ?? base.content_summary,
    content_excerpt:
      (p.content_excerpt as string) ??
      (typeof p.content_summary === "string"
        ? p.content_summary.slice(0, 500)
        : base.content_excerpt),
  };
}

function enrichOutput(
  output: DecisionOutput,
  perceptions: PerceptionEvent[],
): DecisionOutput {
  if (output.kind === "create_approval") {
    return {
      ...output,
      draft: {
        ...output.draft,
        target_ref: enrichTargetFromPerceptions(
          output.draft.target_ref,
          perceptions,
        ),
      },
    };
  }
  if (output.kind === "create_action") {
    const action: ActionCandidate = {
      ...output.action,
      target_ref: enrichTargetFromPerceptions(
        output.action.target_ref,
        perceptions,
      ),
    };
    return { ...output, action };
  }
  return output;
}

export type TickOptions = {
  /** Only process these persons (verify isolation). */
  personIds?: string[];
  /** Skip Discover ingest (verify default). */
  skipDiscover?: boolean;
  /** Skip Sync ingest (verify often syncs separately). */
  skipSync?: boolean;
  /** Skip stuck-running recovery / retry policy (verify). */
  skipRecovery?: boolean;
  /**
   * When personIds unset: include verify-tagged persons.
   * Default false so ops tick ignores verify fixtures.
   */
  includeVerifyPersons?: boolean;
};

function isVerifyPerson(person: {
  discover_meta?: Record<string, unknown> | null;
  display_name?: string;
}): boolean {
  if (person.discover_meta?.verify === true) return true;
  return String(person.display_name ?? "").startsWith("[verify:");
}

export async function tick(
  repos?: Repositories,
  options?: TickOptions,
): Promise<TickResult> {
  const db = repos ?? createRepositories(createServiceClient());
  const logs: string[] = [];
  const decisions = [];
  const workflowsUpdated: string[] = [];
  const actionJobsCreated: string[] = [];
  const approvalsCreated: string[] = [];
  const activitiesCreated: string[] = [];
  let perceptionsProcessed = 0;
  let actionsExecuted = 0;
  let actionsBlocked = 0;
  const allowIds = options?.personIds?.length
    ? new Set(options.personIds)
    : null;
  const includeVerify = options?.includeVerifyPersons === true;

  logs.push("tick:start");
  if (allowIds) {
    logs.push(`tick:scope personIds=${allowIds.size}`);
  }
  resetLowRiskLikeBatchState();

  // 0a) Recovery — stuck running → failed; exhausted → permanently_failed; bounded retry
  // Order: recovery → (discover) → sync → perception → decision → action
  if (!options?.skipRecovery) {
    const recovery = await runActionJobRecovery(db);
    logs.push(...recovery.logs);
    actionsBlocked += recovery.stuckRecovered + recovery.permanentlyFailed;
    actionsExecuted += recovery.retrySucceeded;
  } else {
    logs.push("recovery:skipped");
  }

  // 0b) Discover → Person(stage=discover)
  if (!options?.skipDiscover) {
    const discover = await ingestDiscoverCandidates(db);
    logs.push(
      `discover:keywords=${discover.keywords.length} seen=${discover.candidatesSeen} created=${discover.personsCreated} skip=${discover.skippedExisting}`,
    );
    if (discover.errors.length > 0) {
      logs.push(`discover:errors=${discover.errors.length}`);
    }
  } else {
    logs.push("discover:skipped");
  }

  // 1) Sync managed blogs → PerceptionEvent(new_post)
  if (!options?.skipSync) {
    const sync = await ingestNaverBlogPerceptions(db, undefined, {
      personIds: options?.personIds,
      includeVerifyPersons: includeVerify || Boolean(allowIds),
    });
    logs.push(
      `sync:targets=${sync.targets} posts=${sync.postsSeen} created=${sync.perceptionsCreated} dup=${sync.skippedDuplicates}`,
    );
    if (sync.errors.length > 0) {
      logs.push(`sync:errors=${sync.errors.length}`);
    }
  } else {
    logs.push("sync:skipped");
  }

  const pendingPerceptions = await loadUnprocessedPerceptions(db);
  logs.push(`perception:unprocessed=${pendingPerceptions.length}`);

  const personIdSet = new Set<string>(
    allowIds
      ? [...allowIds]
      : [
          ...(await db.listPersonIdsWithUnprocessedPerceptions()),
          ...(await db.listActiveWorkflowPersonIds()),
        ],
  );

  let personsProcessed = 0;

  for (const personId of personIdSet) {
    const person = await db.getPerson(personId);
    if (!person) continue;

    if (allowIds && !allowIds.has(personId)) continue;
    if (!allowIds && !includeVerify && isVerifyPerson(person)) {
      logs.push(`skip:verify-fixture person=${person.display_name}`);
      continue;
    }

    const ctx = await loadDecisionContext(db, person);

    if (ctx.perceptions.length === 0 && !ctx.workflow) {
      continue;
    }

    if (
      ctx.perceptions.length === 0 &&
      ctx.workflow?.current_state === "waiting" &&
      ctx.workflow.waiting_until &&
      new Date(ctx.workflow.waiting_until) > ctx.now
    ) {
      logs.push(`skip:waiting person=${person.display_name}`);
      continue;
    }

    const { output: rawOutput, record } = await runDecision(db, ctx);
    const output = enrichOutput(rawOutput, ctx.perceptions);
    decisions.push(record);
    logs.push(
      `decision:person=${person.display_name} kind=${output.kind} — ${output.reason_short}`,
    );

    const wfResult = await applyWorkflowUpdate(db, person, output, record);
    workflowsUpdated.push(wfResult.workflow.id);
    logs.push(
      `workflow:id=${wfResult.workflow.id} stage=${wfResult.workflow.current_stage} state=${wfResult.workflow.current_state}`,
    );

    let job;
    if (output.kind === "create_approval") {
      const queued = await enqueueApproval(
        db,
        wfResult.workflow,
        output,
        record,
      );
      job = queued.job;
      actionJobsCreated.push(queued.job.id);
      approvalsCreated.push(queued.approval.id);
      logs.push(`approval:created job=${queued.job.id}`);
    } else if (output.kind === "create_action") {
      job = await enqueueLowRiskAction(db, wfResult.workflow, output, record);
      actionJobsCreated.push(job.id);
      if (job.status === "failed") {
        actionsBlocked += 1;
        logs.push(
          `action:failed type=${job.action_type} id=${job.id} error=${job.error ?? ""}`,
        );
      } else {
        actionsExecuted += 1;
        logs.push(`action:executed type=${job.action_type} id=${job.id}`);
      }
    }

    const acts = await projectActivity(db, {
      workflow: wfResult.workflow,
      output,
      record,
      stageChanged: wfResult.stageChanged || wfResult.created,
      job,
    });
    activitiesCreated.push(...acts.map((a) => a.id));

    await markPerceptionsProcessed(
      db,
      ctx.perceptions.map((p) => p.id),
    );
    perceptionsProcessed += ctx.perceptions.length;

    personsProcessed += 1;
  }

  await touchOutcome(db);
  const brief = await refreshBriefSnapshot(db);
  logs.push(
    `brief:approvals=${brief.approval_count} intervention_min=${Number(brief.intervention_minutes_est).toFixed(1)}`,
  );
  logs.push("tick:done");

  return {
    ok: true,
    personsProcessed,
    perceptionsProcessed,
    decisions,
    workflowsUpdated,
    actionJobsCreated,
    approvalsCreated,
    activitiesCreated,
    actionsExecuted,
    actionsBlocked,
    brief,
    logs,
  };
}
