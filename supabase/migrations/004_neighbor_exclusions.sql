-- Neighbor blog exclusions (permanent exclude from 서로이웃 candidates).
-- No change to action_jobs / approval_items / execute path.

create table if not exists public.neighbor_exclusions (
  blog_id text primary key,
  blog_name text,
  blog_url text,
  note text,
  excluded_at timestamptz not null default now()
);

create index if not exists neighbor_exclusions_excluded_at_idx
  on public.neighbor_exclusions (excluded_at desc);

comment on table public.neighbor_exclusions is
  'Supervisor-excluded blogs for neighbor_request candidate listing';
