/**
 * Shared domain types — mirrors ARCHITECTURE_SPEC v2.0 / 001_init.sql enums.
 */

export type ChannelType = "blog" | "threads" | "instagram";
export type ChannelConnectionStatus =
  | "connected"
  | "error"
  | "revoked"
  | "disconnected";

export type RelationshipStage =
  | "discover"
  | "warming"
  | "waiting_new_post"
  | "approval_pending"
  | "early_relationship"
  | "maintain"
  | "vip"
  | "risk";

export type WorkflowState =
  | "active"
  | "waiting"
  | "blocked"
  | "completed"
  | "cancelled";

export type NextActionType =
  | "visit"
  | "like"
  | "comment"
  | "neighbor_request"
  | "threads_reply"
  | "observe"
  | "none";

export type ActionType =
  | "visit"
  | "like"
  | "comment"
  | "neighbor_request"
  | "threads_reply";

export type ActionRisk = "low" | "high";

export type ActionJobStatus =
  | "planned"
  | "running"
  | "executed"
  | "pending_approval"
  | "approved"
  | "rejected"
  | "expired"
  | "failed"
  | "permanently_failed"
  | "skipped_policy"
  | "skipped"
  | "excluded"
  | "partial_success";

export type ActivityKind =
  | "executed"
  | "observed"
  | "waiting"
  | "approval_created"
  | "approved"
  | "rejected"
  | "blocked"
  | "stage_changed"
  | "completed";

export type DecisionOutputKind =
  | "workflow_update"
  | "create_action"
  | "create_approval"
  | "observe"
  | "skip"
  | "delay";

export type PolicyPreset = "supervise" | "default" | "expanded" | "max";

export type GoalCode =
  | "relationship_quality"
  | "natural_interaction"
  | "minimize_user_time"
  | "sustained_growth"
  | "lagging_reach";

export type RulePriority = "critical" | "high" | "normal" | "low";

export interface Person {
  id: string;
  display_name: string;
  active_workflow_id: string | null;
  discover_meta: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface RelationshipState {
  person_id: string;
  stage: RelationshipStage;
  score: number;
  temperature: number;
  last_visit_at: string | null;
  last_like_at: string | null;
  last_comment_at: string | null;
  last_touch_at: string | null;
  updated_at: string;
}

export interface Workflow {
  id: string;
  person_id: string;
  current_stage: RelationshipStage;
  current_state: WorkflowState;
  next_action: NextActionType;
  waiting_until: string | null;
  waiting_for: string | null;
  priority: number;
  blocked_reason: string | null;
  goal: string | null;
  last_decision_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ActionJob {
  id: string;
  parent_workflow_id: string;
  person_id: string;
  channel: ChannelType;
  action_type: ActionType;
  risk: ActionRisk;
  status: ActionJobStatus;
  draft_body: string | null;
  draft_alternatives: string[] | null;
  target_ref: Record<string, unknown>;
  scheduled_for: string | null;
  decision_id: string | null;
  bundle_id: string | null;
  inbox_priority: number;
  reject_reason: string | null;
  executed_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApprovalItem {
  id: string;
  workflow_id: string;
  action_job_id: string;
  person_id: string;
  inbox_priority: number;
  bundle_id: string | null;
  presented_context: Record<string, unknown>;
  created_at: string;
  resolved_at: string | null;
}

export interface ActivityItem {
  id: string;
  workflow_id: string | null;
  person_id: string | null;
  action_job_id: string | null;
  decision_id: string | null;
  kind: ActivityKind;
  summary: string;
  created_at: string;
}

export interface PerceptionEvent {
  id: string;
  person_id: string | null;
  channel: ChannelType;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: string;
  ingested_at: string;
  processed_at: string | null;
}

export interface DecisionRecord {
  id: string;
  person_id: string | null;
  workflow_id: string | null;
  perception_event_id: string | null;
  decision_type: DecisionOutputKind;
  reason_short: string;
  reason_detail: Record<string, unknown>;
  inputs: Record<string, unknown>;
  created_at: string;
}

export interface PolicyProfile {
  id: true;
  preset: PolicyPreset;
  low_risk_auto: boolean;
  high_risk_auto_comment: boolean;
  high_risk_auto_request: boolean;
  daily_limits: {
    visit?: number;
    like?: number;
    comment?: number;
    neighbor_request?: number;
  };
  quiet_hours: { startHour?: number; endHour?: number };
  tone: Record<string, unknown>;
  banned_phrases: string[];
  /**
   * May include discover_policy / discover_exclude_keywords / discover_categories
   * — see domain/policy/discoverPolicy.ts
   */
  weekly_goals: Record<string, unknown>;
  /** Discover search keywords (Policy column) */
  discover_keywords: string[];
  updated_at: string;
}

export interface BriefSnapshot {
  id: true;
  agent_status: string;
  status_detail: Record<string, unknown>;
  activity_summary: Record<string, unknown>;
  approval_count: number;
  intervention_minutes_est: number;
  time_saved_minutes_est: number;
  growth_summary: Record<string, unknown>;
  updated_at: string;
}

export interface OutcomeDaily {
  date: string;
  intervention_minutes_est: number;
  time_saved_minutes_est: number;
  auto_visit_count: number;
  auto_like_count: number;
  observe_count: number;
  waiting_count: number;
  approval_pending_count: number;
  approval_done_count: number;
  temperature_up_count: number;
  mutual_reaction_count: number;
  lagging_metrics: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface GoalScoreVector {
  relationship_health: number;
  engagement_potential: number;
  trust_level: number;
  growth_opportunity: number;
  user_time_cost: number;
  lagging_reach_proxy: number;
}

export interface ActionCandidate {
  action_type: ActionType | "observe";
  risk: ActionRisk | "low";
  reason_short: string;
  score: number;
  /** Pipeline priority band used for conflict resolution */
  priority_band?:
    | "vip_neglect"
    | "approval_pending"
    | "new_post"
    | "warming_done"
    | "discover"
    | "maintain"
    | "observe";
  supports_goals: GoalCode[];
  estimated_user_time_cost: number;
  draft_body?: string;
  draft_alternatives?: string[];
  target_ref?: Record<string, unknown>;
  channel?: ChannelType;
}

export interface RelationshipHealthFactors {
  days_since_visit: number | null;
  days_since_like: number | null;
  days_since_comment: number | null;
  days_since_reply: number | null;
  days_since_approval: number | null;
  days_since_request: number | null;
  stage: RelationshipStage;
  temperature: number;
  score: number;
}

export type RiskLevel = "low" | "medium" | "high";

export interface WorkflowPatch {
  current_stage?: RelationshipStage;
  current_state?: WorkflowState;
  next_action?: NextActionType;
  waiting_until?: string | null;
  waiting_for?: string | null;
  priority?: number;
  blocked_reason?: string | null;
  goal?: string | null;
  relationship?: {
    score_delta?: number;
    temperature_delta?: number;
    stage?: RelationshipStage;
  };
}

/** Shared explain fields — Supervisor can show “왜 이 결정인가” */
export interface DecisionExplainFields {
  reason_short: string;
  explanation: string;
  reasons: string[];
  rule_ids: string[];
}

export type DecisionOutput =
  | ({
      kind: "workflow_update";
      patch: WorkflowPatch;
    } & DecisionExplainFields)
  | ({
      kind: "create_action";
      action: ActionCandidate;
      workflow_patch?: WorkflowPatch;
    } & DecisionExplainFields)
  | ({
      kind: "create_approval";
      draft: {
        action_type: "comment" | "neighbor_request" | "threads_reply";
        body: string;
        alternatives: string[];
        target_ref: Record<string, unknown>;
        channel: ChannelType;
      };
      workflow_patch: WorkflowPatch;
    } & DecisionExplainFields)
  | ({
      kind: "observe";
      workflow_patch?: WorkflowPatch;
    } & DecisionExplainFields)
  | ({
      kind: "skip";
    } & DecisionExplainFields)
  | ({
      kind: "delay";
      delay_until: string;
      waiting_for?: string;
      workflow_patch?: WorkflowPatch;
    } & DecisionExplainFields);

export interface DecisionBlackboard {
  normalized_events: Array<{
    id: string;
    event_type: string;
    payload: Record<string, unknown>;
  }>;
  relationship_eval: {
    health: number;
    factors: RelationshipHealthFactors;
    suggested_stage?: RelationshipStage;
    score_delta?: number;
    temperature_delta?: number;
    flags: string[];
  };
  priority_score: number;
  /** Conflict labels resolved in priority stage */
  priority_conflicts: string[];
  risk: { level: RiskLevel; reasons: string[] };
  goal: {
    code: GoalCode;
    unmet: boolean;
    scores: GoalScoreVector;
    active_rank: GoalCode[];
    /** G5 never outranks G1–G3 */
    g5_capped: boolean;
  };
  action_candidates: ActionCandidate[];
  approval_required: boolean;
  schedule?: {
    scheduled_for?: string;
    delay_until?: string;
    waiting_for?: string;
  };
  transition?: {
    to_stage?: RelationshipStage;
    to_state?: WorkflowState;
    reason: string;
  };
  draft?: {
    action_type: "comment" | "neighbor_request" | "threads_reply";
    body: string;
    alternatives: string[];
    target_ref: Record<string, unknown>;
    channel: ChannelType;
  };
  rule_fires: Array<{
    rule_id: string;
    priority: RulePriority;
    supports_goals?: GoalCode[];
    note?: string;
  }>;
  /** Accumulated human-readable reasons for Decision Explain */
  reasons: string[];
  terminal?: DecisionOutput;
}

export interface DecisionContext {
  now: Date;
  person: Person;
  relationship: RelationshipState;
  workflow: Workflow | null;
  policy: PolicyProfile;
  perceptions: PerceptionEvent[];
  recent_activity: ActivityItem[];
  recent_approvals: ApprovalItem[];
  recent_action_jobs: ActionJob[];
  outcome_today: OutcomeDaily;
  blackboard: DecisionBlackboard;
}

export interface TickResult {
  ok: boolean;
  personsProcessed: number;
  perceptionsProcessed: number;
  decisions: DecisionRecord[];
  workflowsUpdated: string[];
  actionJobsCreated: string[];
  approvalsCreated: string[];
  activitiesCreated: string[];
  actionsExecuted: number;
  actionsBlocked: number;
  brief: BriefSnapshot;
  logs: string[];
}
