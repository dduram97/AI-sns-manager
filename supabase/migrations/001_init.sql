-- =============================================================================
-- AI SNS Manager — Personal Agent
-- Migration: 001_init.sql
-- Spec: ARCHITECTURE_SPEC v2.0
-- Status: FINAL (reviewed against v2.0 — do not alter without new migration)
-- Soft delete: NONE (hard delete + CASCADE)
-- Run in: Supabase SQL Editor (or supabase db push)
-- =============================================================================

-- Review notes (v2.0 alignment):
-- - Core + channel_connections / channel_identities (spec §9) included
-- - Goals: no table (Decision-internal scores only)
-- - Soft delete: none
-- - Extra vs sketch: perception_events.processed_at (tick idempotency; avoids later ALTER)

create extension if not exists "pgcrypto";

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------

create type public.channel_type as enum (
  'blog',
  'threads',
  'instagram'
);

create type public.channel_connection_status as enum (
  'connected',
  'error',
  'revoked',
  'disconnected'
);

create type public.relationship_stage as enum (
  'discover',
  'warming',
  'waiting_new_post',
  'approval_pending',
  'early_relationship',
  'maintain',
  'vip',
  'risk'
);

create type public.workflow_state as enum (
  'active',
  'waiting',
  'blocked',
  'completed',
  'cancelled'
);

create type public.next_action_type as enum (
  'visit',
  'like',
  'comment',
  'neighbor_request',
  'threads_reply',
  'observe',
  'none'
);

create type public.action_type as enum (
  'visit',
  'like',
  'comment',
  'neighbor_request',
  'threads_reply'
);

create type public.action_risk as enum (
  'low',
  'high'
);

create type public.action_job_status as enum (
  'planned',
  'executed',
  'pending_approval',
  'approved',
  'rejected',
  'expired',
  'failed',
  'skipped_policy'
);

create type public.activity_kind as enum (
  'executed',
  'observed',
  'waiting',
  'approval_created',
  'approved',
  'rejected',
  'blocked',
  'stage_changed',
  'completed'
);

create type public.decision_output_kind as enum (
  'workflow_update',
  'create_action',
  'create_approval',
  'observe',
  'skip',
  'delay'
);

create type public.policy_preset as enum (
  'supervise',
  'default',
  'expanded',
  'max'
);

-- -----------------------------------------------------------------------------
-- updated_at helper
-- -----------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- 1. channel_connections
-- -----------------------------------------------------------------------------

create table public.channel_connections (
  id uuid primary key default gen_random_uuid(),
  channel public.channel_type not null,
  status public.channel_connection_status not null default 'disconnected',
  credentials_encrypted jsonb,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint channel_connections_channel_key unique (channel)
);

create trigger trg_channel_connections_updated_at
before update on public.channel_connections
for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 2. policy_profile (singleton)
-- -----------------------------------------------------------------------------

create table public.policy_profile (
  id boolean primary key default true,
  preset public.policy_preset not null default 'default',
  low_risk_auto boolean not null default true,
  high_risk_auto_comment boolean not null default false,
  high_risk_auto_request boolean not null default false,
  daily_limits jsonb not null default '{}'::jsonb,
  quiet_hours jsonb not null default '{}'::jsonb,
  tone jsonb not null default '{}'::jsonb,
  banned_phrases text[] not null default '{}'::text[],
  weekly_goals jsonb not null default '{}'::jsonb,
  discover_keywords text[] not null default '{}'::text[],
  updated_at timestamptz not null default now(),
  constraint policy_profile_singleton check (id = true)
);

create trigger trg_policy_profile_updated_at
before update on public.policy_profile
for each row execute function public.set_updated_at();

insert into public.policy_profile (id) values (true);

-- -----------------------------------------------------------------------------
-- 3. persons
-- -----------------------------------------------------------------------------

create table public.persons (
  id uuid primary key default gen_random_uuid(),
  display_name text not null,
  active_workflow_id uuid,
  discover_meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint persons_display_name_nonempty check (char_length(trim(display_name)) > 0)
);

create index persons_display_name_idx on public.persons (display_name);
create index persons_created_at_idx on public.persons (created_at desc);

create trigger trg_persons_updated_at
before update on public.persons
for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 4. relationship_states (1:1 Person)
-- -----------------------------------------------------------------------------

create table public.relationship_states (
  person_id uuid primary key
    references public.persons (id) on delete cascade,
  stage public.relationship_stage not null default 'discover',
  score numeric not null default 0,
  temperature numeric not null default 0,
  last_visit_at timestamptz,
  last_like_at timestamptz,
  last_comment_at timestamptz,
  last_touch_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint relationship_states_score_range check (score >= 0),
  constraint relationship_states_temperature_range check (temperature >= 0)
);

create index relationship_states_stage_idx
  on public.relationship_states (stage);

create index relationship_states_last_touch_idx
  on public.relationship_states (last_touch_at desc nulls last);

create trigger trg_relationship_states_updated_at
before update on public.relationship_states
for each row execute function public.set_updated_at();

-- Auto-create relationship_state when person is inserted
create or replace function public.create_relationship_state_for_person()
returns trigger
language plpgsql
as $$
begin
  insert into public.relationship_states (person_id)
  values (new.id);
  return new;
end;
$$;

create trigger trg_persons_create_relationship_state
after insert on public.persons
for each row execute function public.create_relationship_state_for_person();

-- -----------------------------------------------------------------------------
-- 5. workflows
-- -----------------------------------------------------------------------------

create table public.workflows (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null
    references public.persons (id) on delete cascade,
  current_stage public.relationship_stage not null default 'discover',
  current_state public.workflow_state not null default 'active',
  next_action public.next_action_type not null default 'none',
  waiting_until timestamptz,
  waiting_for text,
  priority integer not null default 0,
  blocked_reason text,
  goal text,
  last_decision_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index workflows_person_id_idx on public.workflows (person_id);
create index workflows_priority_idx on public.workflows (priority desc);
create index workflows_waiting_until_idx
  on public.workflows (waiting_until)
  where current_state = 'waiting';

-- At most one non-terminal workflow per person
create unique index workflows_one_active_per_person_idx
  on public.workflows (person_id)
  where current_state in ('active', 'waiting', 'blocked');

create trigger trg_workflows_updated_at
before update on public.workflows
for each row execute function public.set_updated_at();

-- persons.active_workflow_id → workflows (deferred circular FK)
alter table public.persons
  add constraint persons_active_workflow_id_fkey
  foreign key (active_workflow_id)
  references public.workflows (id)
  on delete set null;

-- -----------------------------------------------------------------------------
-- 6. action_jobs
-- -----------------------------------------------------------------------------

create table public.action_jobs (
  id uuid primary key default gen_random_uuid(),
  parent_workflow_id uuid not null
    references public.workflows (id) on delete cascade,
  person_id uuid not null
    references public.persons (id) on delete cascade,
  channel public.channel_type not null,
  action_type public.action_type not null,
  risk public.action_risk not null,
  status public.action_job_status not null default 'planned',
  draft_body text,
  draft_alternatives jsonb,
  target_ref jsonb not null default '{}'::jsonb,
  scheduled_for timestamptz,
  decision_id uuid,
  bundle_id uuid,
  inbox_priority integer not null default 0,
  reject_reason text,
  executed_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint action_jobs_risk_matrix check (
    (action_type in ('visit', 'like') and risk = 'low')
    or
    (action_type in ('comment', 'neighbor_request', 'threads_reply') and risk = 'high')
  )
);

create index action_jobs_workflow_idx
  on public.action_jobs (parent_workflow_id, created_at);

create index action_jobs_person_idx
  on public.action_jobs (person_id, created_at desc);

create index action_jobs_status_idx
  on public.action_jobs (status);

create index action_jobs_pending_approval_idx
  on public.action_jobs (inbox_priority desc, created_at asc)
  where status = 'pending_approval';

create index action_jobs_planned_schedule_idx
  on public.action_jobs (scheduled_for nulls first)
  where status in ('planned', 'approved');

create index action_jobs_bundle_idx
  on public.action_jobs (bundle_id)
  where bundle_id is not null;

create trigger trg_action_jobs_updated_at
before update on public.action_jobs
for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 7. perception_events
-- -----------------------------------------------------------------------------

create table public.perception_events (
  id uuid primary key default gen_random_uuid(),
  person_id uuid
    references public.persons (id) on delete set null,
  channel public.channel_type not null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  processed_at timestamptz,
  constraint perception_events_event_type_nonempty
    check (char_length(trim(event_type)) > 0)
);

create index perception_events_ingested_idx
  on public.perception_events (ingested_at desc);

create index perception_events_person_idx
  on public.perception_events (person_id, occurred_at desc);

create index perception_events_unprocessed_idx
  on public.perception_events (ingested_at)
  where processed_at is null;

-- -----------------------------------------------------------------------------
-- 8. decision_records
-- -----------------------------------------------------------------------------

create table public.decision_records (
  id uuid primary key default gen_random_uuid(),
  person_id uuid
    references public.persons (id) on delete set null,
  workflow_id uuid
    references public.workflows (id) on delete set null,
  perception_event_id uuid
    references public.perception_events (id) on delete set null,
  decision_type public.decision_output_kind not null,
  reason_short text not null,
  reason_detail jsonb not null default '{}'::jsonb,
  inputs jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint decision_records_reason_short_nonempty
    check (char_length(trim(reason_short)) > 0)
);

create index decision_records_created_idx
  on public.decision_records (created_at desc);

create index decision_records_person_idx
  on public.decision_records (person_id, created_at desc);

create index decision_records_workflow_idx
  on public.decision_records (workflow_id, created_at desc);

-- workflows.last_decision_id → decision_records
alter table public.workflows
  add constraint workflows_last_decision_id_fkey
  foreign key (last_decision_id)
  references public.decision_records (id)
  on delete set null;

-- action_jobs.decision_id → decision_records
alter table public.action_jobs
  add constraint action_jobs_decision_id_fkey
  foreign key (decision_id)
  references public.decision_records (id)
  on delete set null;

-- -----------------------------------------------------------------------------
-- 9. activity_items
-- -----------------------------------------------------------------------------

create table public.activity_items (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid
    references public.workflows (id) on delete set null,
  person_id uuid
    references public.persons (id) on delete set null,
  action_job_id uuid
    references public.action_jobs (id) on delete set null,
  decision_id uuid
    references public.decision_records (id) on delete set null,
  kind public.activity_kind not null,
  summary text not null,
  created_at timestamptz not null default now(),
  constraint activity_items_summary_nonempty
    check (char_length(trim(summary)) > 0)
);

create index activity_items_created_idx
  on public.activity_items (created_at desc);

create index activity_items_workflow_idx
  on public.activity_items (workflow_id, created_at);

create index activity_items_person_idx
  on public.activity_items (person_id, created_at desc);

create index activity_items_kind_idx
  on public.activity_items (kind, created_at desc);

-- -----------------------------------------------------------------------------
-- 10. approval_items
-- -----------------------------------------------------------------------------

create table public.approval_items (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null
    references public.workflows (id) on delete cascade,
  action_job_id uuid not null
    references public.action_jobs (id) on delete cascade,
  person_id uuid not null
    references public.persons (id) on delete cascade,
  inbox_priority integer not null default 0,
  bundle_id uuid,
  presented_context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  constraint approval_items_action_job_key unique (action_job_id),
  constraint approval_items_resolved_after_created check (
    resolved_at is null or resolved_at >= created_at
  )
);

create index approval_items_inbox_idx
  on public.approval_items (inbox_priority desc, created_at asc)
  where resolved_at is null;

create index approval_items_person_idx
  on public.approval_items (person_id, created_at desc);

create index approval_items_workflow_idx
  on public.approval_items (workflow_id);

create index approval_items_bundle_idx
  on public.approval_items (bundle_id)
  where bundle_id is not null;

-- -----------------------------------------------------------------------------
-- 11. brief_snapshots (singleton)
-- -----------------------------------------------------------------------------

create table public.brief_snapshots (
  id boolean primary key default true,
  agent_status text not null default 'idle',
  status_detail jsonb not null default '{}'::jsonb,
  activity_summary jsonb not null default '{}'::jsonb,
  approval_count integer not null default 0,
  intervention_minutes_est numeric not null default 0,
  time_saved_minutes_est numeric not null default 0,
  growth_summary jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint brief_snapshots_singleton check (id = true),
  constraint brief_snapshots_approval_count_nonneg check (approval_count >= 0),
  constraint brief_snapshots_intervention_nonneg check (intervention_minutes_est >= 0),
  constraint brief_snapshots_time_saved_nonneg check (time_saved_minutes_est >= 0)
);

create trigger trg_brief_snapshots_updated_at
before update on public.brief_snapshots
for each row execute function public.set_updated_at();

insert into public.brief_snapshots (id, agent_status) values (true, 'idle');

-- -----------------------------------------------------------------------------
-- 12. outcome_daily (aggregate by date)
-- -----------------------------------------------------------------------------

create table public.outcome_daily (
  date date primary key,
  intervention_minutes_est numeric not null default 0,
  time_saved_minutes_est numeric not null default 0,
  auto_visit_count integer not null default 0,
  auto_like_count integer not null default 0,
  observe_count integer not null default 0,
  waiting_count integer not null default 0,
  approval_pending_count integer not null default 0,
  approval_done_count integer not null default 0,
  temperature_up_count integer not null default 0,
  mutual_reaction_count integer not null default 0,
  lagging_metrics jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint outcome_daily_counts_nonneg check (
    intervention_minutes_est >= 0
    and time_saved_minutes_est >= 0
    and auto_visit_count >= 0
    and auto_like_count >= 0
    and observe_count >= 0
    and waiting_count >= 0
    and approval_pending_count >= 0
    and approval_done_count >= 0
    and temperature_up_count >= 0
    and mutual_reaction_count >= 0
  )
);

create trigger trg_outcome_daily_updated_at
before update on public.outcome_daily
for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 13. channel_identities
-- -----------------------------------------------------------------------------

create table public.channel_identities (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null
    references public.persons (id) on delete cascade,
  channel public.channel_type not null,
  external_key text not null,
  state jsonb not null default '{}'::jsonb,
  profile_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint channel_identities_external_key_nonempty
    check (char_length(trim(external_key)) > 0),
  constraint channel_identities_channel_external_key unique (channel, external_key)
);

create index channel_identities_person_idx
  on public.channel_identities (person_id);

create trigger trg_channel_identities_updated_at
before update on public.channel_identities
for each row execute function public.set_updated_at();

-- =============================================================================
-- Done
-- Soft delete: not used. Delete Person → cascades relationship, workflows,
--   action_jobs, approval_items, channel_identities.
-- Activity / perception / decision keep history via ON DELETE SET NULL where noted.
-- =============================================================================
