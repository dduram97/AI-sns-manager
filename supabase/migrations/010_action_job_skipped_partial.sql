-- Ops outcomes: skipped / excluded / partial_success
do $$
begin
  if not exists (
    select 1
    from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = 'action_job_status'
      and e.enumlabel = 'skipped'
  ) then
    alter type public.action_job_status add value 'skipped';
  end if;

  if not exists (
    select 1
    from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = 'action_job_status'
      and e.enumlabel = 'excluded'
  ) then
    alter type public.action_job_status add value 'excluded';
  end if;

  if not exists (
    select 1
    from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = 'action_job_status'
      and e.enumlabel = 'partial_success'
  ) then
    alter type public.action_job_status add value 'partial_success';
  end if;
end $$;
