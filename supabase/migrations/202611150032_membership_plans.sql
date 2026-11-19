begin;

-- Keep both plans and their revisions when this migration is run again.
alter table public.membership_settings drop constraint if exists membership_settings_id_check;
insert into public.membership_settings (id) values (false) on conflict (id) do nothing;

create or replace function public.save_membership_plan(p_plan text, p_details jsonb, p_expected_revision integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  annual_plan boolean;
  saved_revision integer;
begin
  if not public.is_staff() then
    raise exception 'Membership: Manager or owner access is required.';
  end if;
  if p_plan is null or p_plan not in ('annual', 'six-month') then
    raise exception 'Membership: Choose a membership plan.';
  end if;
  annual_plan := p_plan = 'annual';

  if jsonb_typeof(p_details) is distinct from 'object'
    or octet_length(p_details::text) > 90000
    or p_expected_revision is null or p_expected_revision < 0
    or jsonb_typeof(p_details->'price_cents') is distinct from 'number'
    or (p_details->>'price_cents') !~ '^(0|[1-9][0-9]{0,6}|10000000)$'
    or jsonb_typeof(p_details->'benefits') is distinct from 'array'
    or exists (select 1 from (values ('plan_name', 80), ('price_period', 24), ('heading', 80),
      ('introduction', 500), ('validity', 500), ('redemption', 500), ('home_summary', 500)) as fields(key, max_length)
      where jsonb_typeof(p_details->fields.key) is distinct from 'string'
         or p_details->>fields.key !~ '[^[:space:]]'
         or length(p_details->>fields.key) > fields.max_length)
  then
    raise exception 'Membership: Enter valid membership details.';
  end if;

  if jsonb_array_length(p_details->'benefits') > 16
    or exists (select 1 from jsonb_array_elements(p_details->'benefits') as benefits(benefit)
      where not coalesce(benefit->>'icon' in ('trophy', 'wallet', 'users', 'calendar', 'check', 'heart', 'gift', 'coaching'), false)
         or jsonb_typeof(benefit->'title') is distinct from 'string'
         or benefit->>'title' !~ '[^[:space:]]' or length(benefit->>'title') > 80
         or jsonb_typeof(benefit->'description') is distinct from 'string'
         or benefit->>'description' !~ '[^[:space:]]' or length(benefit->>'description') > 500)
  then
    raise exception 'Membership: Enter valid membership benefits.';
  end if;

  update public.membership_settings set details = p_details, revision = revision + 1
  where id = annual_plan and revision = p_expected_revision and details is distinct from p_details
  returning revision into saved_revision;
  if found then return saved_revision; end if;

  select revision into saved_revision from public.membership_settings where id = annual_plan and details = p_details;
  if found then return saved_revision; end if;
  raise exception 'Membership: Someone updated this membership plan. Reload this page to review the latest version before saving.';
end;
$$;

-- Keep the original annual-plan entry point for earlier deployments.
create or replace function public.save_membership_details(p_details jsonb, p_expected_revision integer)
returns integer language sql security invoker set search_path = '' as $$
  select public.save_membership_plan('annual', p_details, p_expected_revision);
$$;

revoke all on function public.save_membership_plan(text, jsonb, integer) from public, anon, authenticated;
grant execute on function public.save_membership_plan(text, jsonb, integer) to authenticated;
notify pgrst, 'reload schema';

commit;
