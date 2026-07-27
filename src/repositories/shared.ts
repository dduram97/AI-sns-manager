import type {
  ActionJob,
  ActionJobStatus,
  ActionRisk,
  ActionType,
  ActivityItem,
  ActivityKind,
  ApprovalItem,
  BriefSnapshot,
  ChannelType,
  DecisionOutputKind,
  DecisionRecord,
  NextActionType,
  OutcomeDaily,
  PerceptionEvent,
  Person,
  PolicyPreset,
  PolicyProfile,
  RelationshipStage,
  RelationshipState,
  Workflow,
  WorkflowState,
} from "../workers/types";

export function num(v: unknown, fallback = 0): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v !== "") return Number(v);
  return fallback;
}

export function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Column projections — avoid select("*") on hot paths. */
export const PERSON_CRM_COLS =
  "id, display_name, active_workflow_id, discover_meta, created_at, updated_at";

export const RELATIONSHIP_COLS =
  "person_id, stage, score, temperature, last_visit_at, last_like_at, last_comment_at, last_touch_at, updated_at";

export const WORKFLOW_CRM_COLS =
  "id, person_id, current_stage, current_state, next_action, waiting_until, waiting_for, priority, blocked_reason, goal, last_decision_id, created_at, updated_at";

export const APPROVAL_OPEN_COLS =
  "id, workflow_id, action_job_id, person_id, inbox_priority, bundle_id, presented_context, created_at, resolved_at";

export const ACTION_JOB_INBOX_COLS =
  "id, parent_workflow_id, person_id, channel, action_type, risk, status, draft_body, draft_alternatives, target_ref, scheduled_for, decision_id, bundle_id, inbox_priority, reject_reason, executed_at, error, created_at, updated_at";

export const DECISION_EXPLAIN_COLS =
  "id, reason_short, reason_detail, created_at";

export const BRIEF_SNAPSHOT_COLS =
  "id, agent_status, status_detail, activity_summary, approval_count, intervention_minutes_est, time_saved_minutes_est, growth_summary, updated_at";

export const OUTCOME_DAILY_COLS =
  "date, intervention_minutes_est, time_saved_minutes_est, auto_visit_count, auto_like_count, observe_count, waiting_count, approval_pending_count, approval_done_count, temperature_up_count, mutual_reaction_count, lagging_metrics, created_at, updated_at";

export const CHANNEL_CONNECTION_COLS =
  "channel, status, last_synced_at, updated_at";

export const ACTIVITY_DAY_COLS =
  "id, workflow_id, person_id, action_job_id, decision_id, kind, summary, created_at";

export const NEIGHBOR_EXCLUSION_COLS =
  "blog_id, blog_name, blog_url, note, excluded_at";

export function assertData<T>(
  data: T | null,
  error: { message: string } | null,
  label: string,
): T {
  if (error) throw new Error(`${label}: ${error.message}`);
  if (data == null) throw new Error(`${label}: no data`);
  return data;
}

export function mapPerson(row: Record<string, unknown>): Person {
  return {
    id: String(row.id),
    display_name: String(row.display_name),
    active_workflow_id: (row.active_workflow_id as string) ?? null,
    discover_meta: (row.discover_meta as Record<string, unknown>) ?? {},
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export function mapRelationship(
  row: Record<string, unknown>,
): RelationshipState {
  return {
    person_id: String(row.person_id),
    stage: row.stage as RelationshipStage,
    score: num(row.score),
    temperature: num(row.temperature),
    last_visit_at: (row.last_visit_at as string) ?? null,
    last_like_at: (row.last_like_at as string) ?? null,
    last_comment_at: (row.last_comment_at as string) ?? null,
    last_touch_at: (row.last_touch_at as string) ?? null,
    updated_at: String(row.updated_at),
  };
}

export function mapWorkflow(row: Record<string, unknown>): Workflow {
  return {
    id: String(row.id),
    person_id: String(row.person_id),
    current_stage: row.current_stage as RelationshipStage,
    current_state: row.current_state as WorkflowState,
    next_action: row.next_action as NextActionType,
    waiting_until: (row.waiting_until as string) ?? null,
    waiting_for: (row.waiting_for as string) ?? null,
    priority: num(row.priority),
    blocked_reason: (row.blocked_reason as string) ?? null,
    goal: (row.goal as string) ?? null,
    last_decision_id: (row.last_decision_id as string) ?? null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export function mapActionJob(row: Record<string, unknown>): ActionJob {
  return {
    id: String(row.id),
    parent_workflow_id: String(row.parent_workflow_id),
    person_id: String(row.person_id),
    channel: row.channel as ChannelType,
    action_type: row.action_type as ActionType,
    risk: row.risk as ActionRisk,
    status: row.status as ActionJobStatus,
    draft_body: (row.draft_body as string) ?? null,
    draft_alternatives: (row.draft_alternatives as string[]) ?? null,
    target_ref: (row.target_ref as Record<string, unknown>) ?? {},
    scheduled_for: (row.scheduled_for as string) ?? null,
    decision_id: (row.decision_id as string) ?? null,
    bundle_id: (row.bundle_id as string) ?? null,
    inbox_priority: num(row.inbox_priority),
    reject_reason: (row.reject_reason as string) ?? null,
    executed_at: (row.executed_at as string) ?? null,
    error: (row.error as string) ?? null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export function mapApproval(row: Record<string, unknown>): ApprovalItem {
  return {
    id: String(row.id),
    workflow_id: String(row.workflow_id),
    action_job_id: String(row.action_job_id),
    person_id: String(row.person_id),
    inbox_priority: num(row.inbox_priority),
    bundle_id: (row.bundle_id as string) ?? null,
    presented_context: (row.presented_context as Record<string, unknown>) ?? {},
    created_at: String(row.created_at),
    resolved_at: (row.resolved_at as string) ?? null,
  };
}

export function mapActivity(row: Record<string, unknown>): ActivityItem {
  return {
    id: String(row.id),
    workflow_id: (row.workflow_id as string) ?? null,
    person_id: (row.person_id as string) ?? null,
    action_job_id: (row.action_job_id as string) ?? null,
    decision_id: (row.decision_id as string) ?? null,
    kind: row.kind as ActivityKind,
    summary: String(row.summary),
    created_at: String(row.created_at),
  };
}

export function mapPerception(row: Record<string, unknown>): PerceptionEvent {
  return {
    id: String(row.id),
    person_id: (row.person_id as string) ?? null,
    channel: row.channel as ChannelType,
    event_type: String(row.event_type),
    payload: (row.payload as Record<string, unknown>) ?? {},
    occurred_at: String(row.occurred_at),
    ingested_at: String(row.ingested_at),
    processed_at: (row.processed_at as string) ?? null,
  };
}

export function mapDecision(row: Record<string, unknown>): DecisionRecord {
  return {
    id: String(row.id),
    person_id: (row.person_id as string) ?? null,
    workflow_id: (row.workflow_id as string) ?? null,
    perception_event_id: (row.perception_event_id as string) ?? null,
    decision_type: row.decision_type as DecisionOutputKind,
    reason_short: String(row.reason_short),
    reason_detail: (row.reason_detail as Record<string, unknown>) ?? {},
    inputs: (row.inputs as Record<string, unknown>) ?? {},
    created_at: String(row.created_at),
  };
}

export function mapPolicy(row: Record<string, unknown>): PolicyProfile {
  return {
    id: true,
    preset: row.preset as PolicyPreset,
    low_risk_auto: Boolean(row.low_risk_auto),
    high_risk_auto_comment: Boolean(row.high_risk_auto_comment),
    high_risk_auto_request: Boolean(row.high_risk_auto_request),
    daily_limits: (row.daily_limits as PolicyProfile["daily_limits"]) ?? {},
    quiet_hours: (row.quiet_hours as PolicyProfile["quiet_hours"]) ?? {},
    tone: (row.tone as Record<string, unknown>) ?? {},
    banned_phrases: (row.banned_phrases as string[]) ?? [],
    weekly_goals: (row.weekly_goals as Record<string, unknown>) ?? {},
    discover_keywords: (row.discover_keywords as string[]) ?? [],
    updated_at: String(row.updated_at),
  };
}

export function mapBrief(row: Record<string, unknown>): BriefSnapshot {
  return {
    id: true,
    agent_status: String(row.agent_status),
    status_detail: (row.status_detail as Record<string, unknown>) ?? {},
    activity_summary: (row.activity_summary as Record<string, unknown>) ?? {},
    approval_count: num(row.approval_count),
    intervention_minutes_est: num(row.intervention_minutes_est),
    time_saved_minutes_est: num(row.time_saved_minutes_est),
    growth_summary: (row.growth_summary as Record<string, unknown>) ?? {},
    updated_at: String(row.updated_at),
  };
}

export function mapOutcome(row: Record<string, unknown>): OutcomeDaily {
  return {
    date: String(row.date),
    intervention_minutes_est: num(row.intervention_minutes_est),
    time_saved_minutes_est: num(row.time_saved_minutes_est),
    auto_visit_count: num(row.auto_visit_count),
    auto_like_count: num(row.auto_like_count),
    observe_count: num(row.observe_count),
    waiting_count: num(row.waiting_count),
    approval_pending_count: num(row.approval_pending_count),
    approval_done_count: num(row.approval_done_count),
    temperature_up_count: num(row.temperature_up_count),
    mutual_reaction_count: num(row.mutual_reaction_count),
    lagging_metrics: (row.lagging_metrics as Record<string, unknown>) ?? {},
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export type {
  ActionJob,
  ActionJobStatus,
  ActionRisk,
  ActionType,
  ActivityItem,
  ActivityKind,
  ApprovalItem,
  BriefSnapshot,
  ChannelType,
  DecisionOutputKind,
  DecisionRecord,
  NextActionType,
  OutcomeDaily,
  PerceptionEvent,
  Person,
  PolicyProfile,
  RelationshipStage,
  RelationshipState,
  Workflow,
  WorkflowState,
};
