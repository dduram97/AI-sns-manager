-- Today: neighbors who liked/commented on my blog posts (reply queue)

create table public.reply_queue (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null
    references public.persons (id) on delete cascade,
  reason text not null,
  like_count integer not null default 0
    check (like_count >= 0),
  comment_count integer not null default 0
    check (comment_count >= 0),
  last_activity_at timestamptz not null,
  processed boolean not null default false,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint reply_queue_person_key unique (person_id),
  constraint reply_queue_reason_nonempty
    check (char_length(trim(reason)) > 0),
  constraint reply_queue_processed_at_when_processed
    check (processed = false or processed_at is not null)
);

create index reply_queue_today_idx
  on public.reply_queue (last_activity_at desc)
  where processed = false;

create index reply_queue_person_activity_idx
  on public.reply_queue (person_id, last_activity_at desc);
