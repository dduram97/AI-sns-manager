-- Daily blog relation analysis snapshots + sync run log

create table if not exists public.blog_relations (
  id uuid primary key default gen_random_uuid(),
  person_id uuid
    references public.persons (id) on delete set null,
  user_id text not null,
  blog_id text not null,
  nickname text,
  profile_user_id text,
  has_comment boolean not null default false,
  comment_count integer not null default 0
    check (comment_count >= 0),
  has_like boolean not null default false,
  like_count integer not null default 0
    check (like_count >= 0),
  relation_type text,
  activity_class text not null
    check (activity_class in ('interaction', 'comment_only', 'like_only')),
  relation_score integer not null default 0
    check (relation_score >= 0),
  last_interaction_at timestamptz,
  analyzed_at timestamptz not null default now(),
  latest_post_title text,
  latest_post_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint blog_relations_blog_id_key unique (blog_id)
);

create index if not exists blog_relations_score_idx
  on public.blog_relations (relation_score desc, last_interaction_at desc nulls last);

create index if not exists blog_relations_person_idx
  on public.blog_relations (person_id)
  where person_id is not null;

create index if not exists blog_relations_analyzed_idx
  on public.blog_relations (analyzed_at desc);

create table if not exists public.relation_sync_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null
    check (status in ('running', 'success', 'failed', 'skipped')),
  source text not null default 'cron'
    check (source in ('cron', 'manual')),
  rows_upserted integer not null default 0
    check (rows_upserted >= 0),
  error text,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists relation_sync_runs_started_idx
  on public.relation_sync_runs (started_at desc);

create index if not exists relation_sync_runs_status_idx
  on public.relation_sync_runs (status, started_at desc);
