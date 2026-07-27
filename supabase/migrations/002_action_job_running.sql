-- ActionJob live execution: planned/approved → running → executed | failed
do $$
begin
  if not exists (
    select 1
    from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = 'action_job_status'
      and e.enumlabel = 'running'
  ) then
    alter type public.action_job_status add value 'running';
  end if;
end $$;
