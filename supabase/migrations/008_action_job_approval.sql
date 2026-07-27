-- Phase 3-4: approval metadata for action_jobs (planned → approved)

alter table public.action_jobs
  add column if not exists approved_at timestamptz,
  add column if not exists approved_by text;

create index if not exists action_jobs_approved_at_idx
  on public.action_jobs (approved_at desc nulls last)
  where approved_at is not null;

comment on column public.action_jobs.approved_at is
  'Phase 3-4: when status moved to approved (CLI / supervisor)';
comment on column public.action_jobs.approved_by is
  'Phase 3-4: approver identity (e.g. cli, cli:user)';
