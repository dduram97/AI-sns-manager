-- Reply-visit comment drafts (AI assist + human review, not approval_inbox)

create table if not exists public.reply_comment_drafts (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null
    references public.reply_visit_tasks (id) on delete cascade,
  blog_id text not null,
  person_id uuid
    references public.persons (id) on delete set null,
  relation_id uuid
    references public.blog_relations (id) on delete set null,
  post_url text not null,
  post_title text,
  generated_comment text not null default '',
  edited_comment text not null default '',
  status text not null default 'draft'
    check (status in ('draft', 'approved', 'executed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reply_comment_drafts_task_id_key unique (task_id)
);

create index if not exists reply_comment_drafts_status_idx
  on public.reply_comment_drafts (status, updated_at desc);

create index if not exists reply_comment_drafts_blog_idx
  on public.reply_comment_drafts (blog_id);
