-- Phase 3-1: keyword candidate discovery → neighbor_request jobs
-- Stores discovered blog candidates before / alongside action_job creation.

create table if not exists public.discovery_candidates (
  id uuid primary key default gen_random_uuid(),
  blog_id text not null,
  blog_url text not null,
  post_url text,
  last_active_at timestamptz,
  keyword text not null,
  blog_name text,
  snippet text,
  post_title text,
  status text not null default 'new'
    check (status in ('new', 'skipped', 'job_created')),
  skip_reason text,
  action_job_id uuid references public.action_jobs (id) on delete set null,
  person_id uuid references public.persons (id) on delete set null,
  meta jsonb not null default '{}'::jsonb,
  discovered_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint discovery_candidates_blog_id_unique unique (blog_id)
);

create index if not exists discovery_candidates_status_idx
  on public.discovery_candidates (status, discovered_at desc);

create index if not exists discovery_candidates_keyword_idx
  on public.discovery_candidates (keyword, discovered_at desc);

create index if not exists discovery_candidates_last_active_idx
  on public.discovery_candidates (last_active_at desc nulls last);

comment on table public.discovery_candidates is
  'Phase 3-1: keyword-discovered blog candidates for planned neighbor_request jobs';
