-- Query performance indexes (Supervisor page hot paths)

-- Neighbor executed-today count + blog id lookup
create index if not exists action_jobs_neighbor_executed_idx
  on public.action_jobs (action_type, status, executed_at desc)
  where action_type = 'neighbor_request' and status = 'executed';

create index if not exists action_jobs_neighbor_target_ref_idx
  on public.action_jobs (action_type, status)
  where action_type = 'neighbor_request';

-- Open approvals by person (CRM badge counts)
create index if not exists approval_items_open_person_idx
  on public.approval_items (person_id)
  where resolved_at is null;

-- Blog identity lookup
create index if not exists channel_identities_blog_key_idx
  on public.channel_identities (channel, external_key)
  where channel = 'blog';

-- Workflow stage/state aggregates (Agent Brief relationship KPI)
create index if not exists workflows_stage_state_idx
  on public.workflows (current_stage, current_state);

-- Activity by day (Brief activity section)
create index if not exists activity_items_created_kind_idx
  on public.activity_items (created_at desc, kind);
