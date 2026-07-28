-- Reply queue: relation analysis fields (score / type / interaction)

alter table public.reply_queue
  add column if not exists relation_score integer not null default 0
    check (relation_score >= 0);

alter table public.reply_queue
  add column if not exists relation_type text;

alter table public.reply_queue
  add column if not exists is_interaction boolean not null default false;

create index if not exists reply_queue_score_idx
  on public.reply_queue (relation_score desc, last_activity_at desc)
  where processed = false;
