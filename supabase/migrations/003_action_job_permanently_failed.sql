-- ActionJob ops: permanently_failed (retry exhausted)
do $$
begin
  if not exists (
    select 1
    from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = 'action_job_status'
      and e.enumlabel = 'permanently_failed'
  ) then
    alter type public.action_job_status add value 'permanently_failed';
  end if;
end $$;
