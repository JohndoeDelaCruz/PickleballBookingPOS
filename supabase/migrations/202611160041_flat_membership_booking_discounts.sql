begin;

alter table public.membership_settings rename column court_discount_cents to court_booking_discount_cents;
alter table public.membership_settings
  drop constraint membership_settings_check,
  add constraint membership_settings_court_discount_min_hours_check check (court_discount_min_hours between 1 and 4);

-- Start the six-month plan with the annual amount and minimum, while retaining
-- whether it offered a court discount. A manually applied 040 may have a daytime cap.
update public.membership_settings as six
set court_discount_enabled = six.court_discount_enabled or (to_jsonb(six)->>'court_daytime_cap_cents') is not null,
  court_booking_discount_cents = annual.court_booking_discount_cents,
  court_discount_min_hours = annual.court_discount_min_hours,
  court_discount_revision = six.court_discount_revision + 1
from public.membership_settings as annual
where not six.id and annual.id
  and (six.court_discount_enabled or (to_jsonb(six)->>'court_daytime_cap_cents') is not null);

drop function if exists public.save_six_month_court_rates(boolean, integer, integer, integer);
alter table public.membership_settings drop column if exists court_daytime_cap_cents;

create function public.save_membership_booking_discount(
  p_plan text, p_enabled boolean, p_amount_cents integer, p_min_hours integer, p_expected_revision integer
) returns integer language plpgsql security definer set search_path = '' as $$
declare
  annual_plan boolean;
  saved_revision integer;
begin
  if not public.is_staff() then raise exception 'Membership: Manager or owner access is required.'; end if;
  if p_plan is null or p_plan not in ('annual', 'six-month') then raise exception 'Membership: Choose a membership plan.'; end if;
  annual_plan := p_plan = 'annual';
  if p_enabled is null or p_amount_cents is null or p_amount_cents not between 1 and 10000000
    or p_min_hours is null or p_min_hours not between 1 and 4 or p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'Membership: Enter a valid court discount and minimum duration.';
  end if;

  update public.membership_settings
    set court_discount_enabled = p_enabled, court_booking_discount_cents = p_amount_cents,
      court_discount_min_hours = p_min_hours, court_discount_revision = court_discount_revision + 1
    where id = annual_plan and court_discount_revision = p_expected_revision
      and (court_discount_enabled, court_booking_discount_cents, court_discount_min_hours)
        is distinct from (p_enabled, p_amount_cents, p_min_hours)
    returning court_discount_revision into saved_revision;
  if found then return saved_revision; end if;

  select court_discount_revision into saved_revision from public.membership_settings
    where id = annual_plan and (court_discount_enabled, court_booking_discount_cents, court_discount_min_hours)
      = (p_enabled, p_amount_cents, p_min_hours);
  if found then return saved_revision; end if;
  raise exception 'Membership: Someone updated this discount. Reload before saving.';
end;
$$;

-- Keep the annual API available. Older tabs cannot save an hourly rate as a booking discount.
create or replace function public.save_membership_court_discount(
  p_plan text, p_enabled boolean, p_amount_cents integer, p_min_hours integer, p_expected_revision integer
) returns integer language plpgsql security invoker set search_path = '' as $$
begin
  if p_plan = 'six-month' then raise exception 'Membership: Reload to edit the six-month booking discount.'; end if;
  return public.save_membership_booking_discount(p_plan, p_enabled, p_amount_cents, p_min_hours, p_expected_revision);
end;
$$;

create or replace function private.private_booking_member_discount(
  p_actor uuid, p_venue public.venue_settings, p_date date, p_start integer, p_duration integer, p_subtotal numeric
) returns numeric language plpgsql stable set search_path = '' as $$
declare
  amount numeric;
begin
  if p_actor is null or p_subtotal is null or p_subtotal <= 0 then return 0; end if;

  select settings.court_booking_discount_cents / 100.0 into amount
    from public.membership_settings settings
    join lateral (
      select application.plan_id from public.membership_applications application
        where application.user_id = p_actor and application.status = 'approved'
          and application.starts_on <= (now() at time zone 'Asia/Manila')::date
          and application.starts_on <= p_date and p_date < application.expires_on
        order by application.starts_on desc, application.reviewed_at desc, application.id desc limit 1
    ) as active on settings.id = (active.plan_id = 'annual')
    where settings.court_discount_enabled and p_duration >= settings.court_discount_min_hours;

  -- Leave at least one centavo of court rental payable.
  return least(coalesce(amount, 0), greatest(p_subtotal - 0.01, 0));
end;
$$;

revoke all on function public.save_membership_booking_discount(text, boolean, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.save_membership_booking_discount(text, boolean, integer, integer, integer) to authenticated;
notify pgrst, 'reload schema';

commit;
