import type { DatabaseClient } from "../lib/supabase";
import { createActivityRepository } from "./ActivityRepository";
import { createApprovalRepository } from "./ApprovalRepository";
import { createBriefRepository } from "./BriefRepository";
import { createNeighborExclusionRepository } from "./NeighborExclusionRepository";
import { createPersonRepository } from "./PersonRepository";
import { createPolicyRepository } from "./PolicyRepository";
import {
  assertData,
  mapActionJob,
  mapDecision,
  mapPerception,
  type ActionJob,
  type ActionJobStatus,
  type ActionRisk,
  type ActionType,
  type ChannelType,
  type DecisionOutputKind,
  type DecisionRecord,
  type PerceptionEvent,
  type PolicyProfile,
} from "./shared";

/**
 * UI / Supervisor Console — named repositories only.
 */
export function createSupervisorRepos(db: DatabaseClient) {
  return {
    brief: createBriefRepository(db),
    approval: createApprovalRepository(db),
    person: createPersonRepository(db),
    activity: createActivityRepository(db),
    policy: createPolicyRepository(db),
    neighborExclusion: createNeighborExclusionRepository(db),
  };
}

export type SupervisorRepos = ReturnType<typeof createSupervisorRepos>;

/**
 * Agent workers — flat API composed from the same repositories.
 */
export function createRepositories(db: DatabaseClient) {
  const brief = createBriefRepository(db);
  const approval = createApprovalRepository(db);
  const person = createPersonRepository(db);
  const activity = createActivityRepository(db);
  const policy = createPolicyRepository(db);

  return {
    listPersons: () => person.list(),
    getPerson: (id: string) => person.getById(id),
    createPerson: (input: Parameters<typeof person.createPerson>[0]) =>
      person.createPerson(input),
    upsertBlogIdentity: (
      input: Parameters<typeof person.upsertBlogIdentity>[0],
    ) => person.upsertBlogIdentity(input),
    findPersonIdByBlogId: (blogId: string) =>
      person.findPersonIdByBlogId(blogId),
    setPersonActiveWorkflow: (personId: string, workflowId: string) =>
      person.setActiveWorkflow(personId, workflowId),
    getRelationship: (personId: string) => person.getRelationship(personId),
    updateRelationship: (
      personId: string,
      patch: Parameters<typeof person.updateRelationship>[1],
    ) => person.updateRelationship(personId, patch),
    getActiveWorkflow: (personId: string) => person.getActiveWorkflow(personId),
    createWorkflow: (input: Parameters<typeof person.createWorkflow>[0]) =>
      person.createWorkflow(input),
    updateWorkflow: (
      id: string,
      patch: Parameters<typeof person.updateWorkflow>[1],
    ) => person.updateWorkflow(id, patch),
    listActiveWorkflowPersonIds: () => person.listActiveWorkflowPersonIds(),

    listOpenApprovals: () => approval.listOpen(),
    listRecentApprovals: (personId: string, limit?: number) =>
      approval.listRecentByPerson(personId, limit),
    createApproval: (input: Parameters<typeof approval.create>[0]) =>
      approval.create(input),
    findOpenApprovalByActionJobId: (actionJobId: string) =>
      approval.findOpenByActionJobId(actionJobId),

    listRecentActivities: (personId: string, limit?: number) =>
      activity.listRecentByPerson(personId, limit),
    listActivitiesForDate: (date: string) => activity.listForDate(date),
    insertActivity: (input: Parameters<typeof activity.insert>[0]) =>
      activity.insert(input),

    getBrief: () => brief.getBrief(),
    updateBrief: (patch: Parameters<typeof brief.updateBrief>[0]) =>
      brief.updateBrief(patch),
    ensureOutcomeToday: () => brief.ensureOutcomeToday(),
    updateOutcomeToday: (
      patch: Parameters<typeof brief.updateOutcomeToday>[0],
    ) => brief.updateOutcomeToday(patch),
    incrementOutcomeCounters: (
      deltas: Parameters<typeof brief.incrementOutcomeCounters>[0],
    ) => brief.incrementOutcomeCounters(deltas),
    listChannelConnectionStatuses: () => brief.listChannelConnectionStatuses(),

    getPolicy: () => policy.get(),
    updatePolicy: (patch: Parameters<typeof policy.update>[0]) =>
      policy.update(patch),

    async listUnprocessedPerceptions(
      personId?: string,
    ): Promise<PerceptionEvent[]> {
      let q = db
        .from("perception_events")
        .select("*")
        .is("processed_at", null)
        .order("ingested_at", { ascending: true });
      if (personId) q = q.eq("person_id", personId);
      const { data, error } = await q;
      return assertData(data, error, "listUnprocessedPerceptions").map((r) =>
        mapPerception(r as Record<string, unknown>),
      );
    },

    async listPersonIdsWithUnprocessedPerceptions(): Promise<string[]> {
      const { data, error } = await db
        .from("perception_events")
        .select("person_id")
        .is("processed_at", null)
        .not("person_id", "is", null);
      if (error)
        throw new Error(
          `listPersonIdsWithUnprocessedPerceptions: ${error.message}`,
        );
      const ids = new Set<string>();
      for (const row of data ?? []) {
        if (row.person_id) ids.add(String(row.person_id));
      }
      return [...ids];
    },

    async markPerceptionsProcessed(ids: string[]): Promise<void> {
      if (ids.length === 0) return;
      const { error } = await db
        .from("perception_events")
        .update({ processed_at: new Date().toISOString() })
        .in("id", ids);
      if (error) throw new Error(`markPerceptionsProcessed: ${error.message}`);
    },

    async insertPerception(input: {
      person_id: string;
      channel: ChannelType;
      event_type: string;
      payload: Record<string, unknown>;
      occurred_at: string;
    }): Promise<PerceptionEvent> {
      const { data, error } = await db
        .from("perception_events")
        .insert(input)
        .select("*")
        .single();
      return mapPerception(
        assertData(data, error, "insertPerception") as Record<string, unknown>,
      );
    },

    /** Idempotency: new_post by payload.post_url */
    async perceptionExistsForPostUrl(postUrl: string): Promise<boolean> {
      if (!postUrl) return false;
      const { data, error } = await db
        .from("perception_events")
        .select("id")
        .eq("event_type", "new_post")
        .filter("payload->>post_url", "eq", postUrl)
        .limit(1);
      if (error) {
        throw new Error(`perceptionExistsForPostUrl: ${error.message}`);
      }
      return (data?.length ?? 0) > 0;
    },

    async listBlogChannelIdentities(): Promise<
      Array<{ person_id: string; external_key: string }>
    > {
      const { data, error } = await db
        .from("channel_identities")
        .select("person_id, external_key")
        .eq("channel", "blog");
      if (error) {
        throw new Error(`listBlogChannelIdentities: ${error.message}`);
      }
      return (data ?? []).map((r) => ({
        person_id: String(r.person_id),
        external_key: String(r.external_key),
      }));
    },

    async insertDecision(input: {
      person_id: string | null;
      workflow_id: string | null;
      perception_event_id: string | null;
      decision_type: DecisionOutputKind;
      reason_short: string;
      reason_detail: Record<string, unknown>;
      inputs: Record<string, unknown>;
    }): Promise<DecisionRecord> {
      const { data, error } = await db
        .from("decision_records")
        .insert(input)
        .select("*")
        .single();
      return mapDecision(
        assertData(data, error, "insertDecision") as Record<string, unknown>,
      );
    },

    async listRecentActionJobs(
      personId: string,
      limit = 30,
    ): Promise<ActionJob[]> {
      const { data, error } = await db
        .from("action_jobs")
        .select("*")
        .eq("person_id", personId)
        .order("created_at", { ascending: false })
        .limit(limit);
      return assertData(data, error, "listRecentActionJobs").map((r) =>
        mapActionJob(r as Record<string, unknown>),
      );
    },

    async createActionJob(input: {
      parent_workflow_id: string;
      person_id: string;
      channel: ChannelType;
      action_type: ActionType;
      risk: ActionRisk;
      status: ActionJobStatus;
      draft_body?: string | null;
      draft_alternatives?: string[] | null;
      target_ref?: Record<string, unknown>;
      decision_id?: string | null;
      inbox_priority?: number;
      /** Optional bundle for comment + like approval modes. */
      bundle_id?: string | null;
    }): Promise<ActionJob> {
      const { data, error } = await db
        .from("action_jobs")
        .insert({
          parent_workflow_id: input.parent_workflow_id,
          person_id: input.person_id,
          channel: input.channel,
          action_type: input.action_type,
          risk: input.risk,
          status: input.status,
          draft_body: input.draft_body ?? null,
          draft_alternatives: input.draft_alternatives ?? null,
          target_ref: input.target_ref ?? {},
          decision_id: input.decision_id ?? null,
          inbox_priority: input.inbox_priority ?? 0,
          bundle_id: input.bundle_id ?? null,
        })
        .select("*")
        .single();
      return mapActionJob(
        assertData(data, error, "createActionJob") as Record<string, unknown>,
      );
    },

    async markActionExecuted(jobId: string): Promise<ActionJob> {
      return approval.markJobExecuted(jobId);
    },

    async markActionRunning(jobId: string): Promise<ActionJob> {
      return approval.markJobRunning(jobId);
    },

    async markActionFailed(jobId: string, message: string): Promise<ActionJob> {
      return approval.markJobFailed(jobId, message);
    },

    async markActionFailedWithCode(
      jobId: string,
      message: string,
      errorCode: string,
    ): Promise<ActionJob> {
      return approval.markJobFailed(jobId, message, { errorCode });
    },

    async markActionPermanentlyFailed(
      jobId: string,
      message: string,
      errorCode?: string,
    ): Promise<ActionJob> {
      return approval.markJobPermanentlyFailed(jobId, message, errorCode);
    },

    async listStuckRunningActionJobs(opts: {
      olderThanIso: string;
      limit?: number;
    }): Promise<ActionJob[]> {
      return approval.listStuckRunningJobs(opts);
    },

    async listExhaustedFailedActionJobs(opts?: {
      limit?: number;
      retryLimit: number;
    }): Promise<ActionJob[]> {
      return approval.listExhaustedFailedJobs(opts);
    },

    async listFailedActionJobs(opts?: {
      limit?: number;
      personId?: string;
      retryLimit?: number;
    }): Promise<ActionJob[]> {
      return approval.listFailedActionJobs(opts);
    },

    async listActionJobsByBundleId(bundleId: string): Promise<ActionJob[]> {
      return approval.listJobsByBundleId(bundleId);
    },

    async requeueFailedActionJob(
      jobId: string,
      retryLimit: number,
    ): Promise<ActionJob> {
      return approval.requeueFailedJob(jobId, retryLimit);
    },
    async findRecentExecutedByPerson(
      personId: string,
      actionType: string,
      limit?: number,
    ): Promise<ActionJob[]> {
      return approval.findRecentExecutedByPerson(personId, actionType, limit);
    },
  };
}

export type Repositories = ReturnType<typeof createRepositories>;

export type { BriefRepository } from "./BriefRepository";
export type {
  ApprovalRepository,
  ApprovalInboxItem,
  ApprovalHistoryItem,
  ApprovalHistoryPage,
} from "./ApprovalRepository";
export type { PersonRepository } from "./PersonRepository";
export type { ActivityRepository } from "./ActivityRepository";
export type {
  PolicyRepository,
  PolicyUpdatePatch,
} from "./PolicyRepository";
