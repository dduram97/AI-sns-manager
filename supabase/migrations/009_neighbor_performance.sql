-- Phase 4-1: neighbor request performance tracking

create table if not exists public.neighbor_performance (
  id uuid primary key default gen_random_uuid(),
  action_job_id uuid not null
    references public.action_jobs (id) on delete cascade,
  blog_id text not null,
  blog_url text,

  request_status text not null default 'unknown'
    check (request_status in ('requested', 'accepted', 'rejected', 'unknown')),

  requested_at timestamptz,
  accepted_at timestamptz,
  last_checked_at timestamptz,

  profile_visit_count integer not null default 0
    check (profile_visit_count >= 0),
  post_visit_count integer not null default 0
    check (post_visit_count >= 0),
  interaction_count integer not null default 0
    check (interaction_count >= 0),

  -- Denormalized for admin / future candidate_score learning
  candidate_score integer,
  discovery_candidate_id uuid
    references public.discovery_candidates (id) on delete set null,
  outcome_label text,
  meta jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint neighbor_performance_action_job_unique unique (action_job_id)
);

create index if not exists neighbor_performance_blog_id_idx
  on public.neighbor_performance (blog_id);

create index if not exists neighbor_performance_status_idx
  on public.neighbor_performance (request_status, requested_at desc nulls last);

create index if not exists neighbor_performance_score_idx
  on public.neighbor_performance (candidate_score desc nulls last);

create index if not exists neighbor_performance_visits_idx
  on public.neighbor_performance (
    profile_visit_count desc,
    post_visit_count desc,
    interaction_count desc
  );

comment on table public.neighbor_performance is
  'Phase 4-1: track neighbor_request outcomes for score learning';
comment on column public.neighbor_performance.outcome_label is
  'Future scoring labels: good_accepted | good_engagement | bad_rejected | stale_no_response';
