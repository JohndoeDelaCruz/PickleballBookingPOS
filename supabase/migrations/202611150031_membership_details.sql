begin;

create table public.membership_settings (
  id boolean primary key default true check (id),
  details jsonb,
  revision integer not null default 0 check (revision >= 0)
);
alter table public.membership_settings enable row level security;
revoke all on public.membership_settings from public, anon, authenticated;
grant select on public.membership_settings to anon, authenticated;
create policy "Read published membership details" on public.membership_settings
  for select to anon, authenticated using (true);

-- A null document leaves the plan unpublished until the venue saves its terms.
insert into public.membership_settings default values;

create function public.save_membership_details(p_details jsonb, p_expected_revision integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  saved_revision integer;
begin
  if not public.is_staff() then
    raise exception 'Membership: Manager or owner access is required.';
  end if;

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
  where id and revision = p_expected_revision and details is distinct from p_details
  returning revision into saved_revision;
  if found then return saved_revision; end if;

  select revision into saved_revision from public.membership_settings where id and details = p_details;
  if found then return saved_revision; end if;
  raise exception 'Membership: Someone updated the membership details. Reload this page to review the latest version before saving.';
end;
$$;

revoke all on function public.save_membership_details(jsonb, integer) from public, anon, authenticated;
grant execute on function public.save_membership_details(jsonb, integer) to authenticated;
notify pgrst, 'reload schema';

commit;
