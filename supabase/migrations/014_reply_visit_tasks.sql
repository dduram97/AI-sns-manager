-- Reply-visit workflow status (separate from blog_relations snapshot)

create table if not exists public.reply_visit_tasks (
  id uuid primary key default gen_random_uuid(),
  relation_id uuid
    references public.blog_relations (id) on delete set null,
  person_id uuid
    references public.persons (id) on delete set null,
  user_id text not null,
  blog_id text not null,
  status text not null default 'pending'
    check (status in ('pending', 'completed', 'snoozed')),
  completed_at timestamptz,
  snoozed_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reply_visit_tasks_blog_id_key unique (blog_id),
  constraint reply_visit_tasks_completed_at_chk
    check (status <> 'completed' or completed_at is not null),
  constraint reply_visit_tasks_snoozed_until_chk
    check (status <> 'snoozed' or snoozed_until is not null)
);

create index if not exists reply_visit_tasks_status_idx
  on public.reply_visit_tasks (status, updated_at desc);

create index if not exists reply_visit_tasks_snoozed_until_idx
  on public.reply_visit_tasks (snoozed_until)
  where status = 'snoozed';

create index if not exists reply_visit_tasks_relation_idx
  on public.reply_visit_tasks (relation_id)
  where relation_id is not null;

create index if not exists reply_visit_tasks_person_idx
  on public.reply_visit_tasks (person_id)
  where person_id is not null;
