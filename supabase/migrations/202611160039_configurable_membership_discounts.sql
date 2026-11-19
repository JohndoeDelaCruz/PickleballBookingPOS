begin;

alter table public.membership_settings
  add column court_discount_enabled boolean not null default false,
  add column court_discount_cents integer not null default 1 check (court_discount_cents between 1 and 10000000),
  add column court_discount_min_hours integer not null default 1
    check (court_discount_min_hours between 1 and 4 and (id or court_discount_min_hours = 1)),
  add column court_discount_revision integer not null default 0 check (court_discount_revision >= 0);

create function public.save_membership_court_discount(
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
    or p_min_hours is null or p_min_hours not between 1 and 4 or (not annual_plan and p_min_hours <> 1)
    or p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'Membership: Enter a valid court discount and minimum duration.';
  end if;

  update public.membership_settings
    set court_discount_enabled = p_enabled, court_discount_cents = p_amount_cents,
      court_discount_min_hours = p_min_hours, court_discount_revision = court_discount_revision + 1
    where id = annual_plan and court_discount_revision = p_expected_revision
      and (court_discount_enabled, court_discount_cents, court_discount_min_hours)
        is distinct from (p_enabled, p_amount_cents, p_min_hours)
    returning court_discount_revision into saved_revision;
  if found then return saved_revision; end if;

  select court_discount_revision into saved_revision from public.membership_settings
    where id = annual_plan and (court_discount_enabled, court_discount_cents, court_discount_min_hours)
      = (p_enabled, p_amount_cents, p_min_hours);
  if found then return saved_revision; end if;
  raise exception 'Membership: Someone updated this discount. Reload before saving.';
end;
$$;

create or replace function private.private_booking_member_discount(
  p_actor uuid, p_venue public.venue_settings, p_date date, p_start integer, p_duration integer, p_subtotal numeric
) returns numeric language plpgsql stable set search_path = '' as $$
declare
  plan text;
  enabled boolean;
  amount numeric;
  min_hours integer;
  discount numeric;
begin
  if p_actor is null or p_subtotal is null or p_subtotal <= 0 then return 0; end if;
  select plan_id into plan from public.membership_applications
    where user_id = p_actor and status = 'approved'
      and starts_on <= (now() at time zone 'Asia/Manila')::date
      and starts_on <= p_date and p_date < expires_on
    order by starts_on desc, reviewed_at desc, id desc limit 1;
  if not found then return 0; end if;

  select court_discount_enabled, court_discount_cents / 100.0, court_discount_min_hours
    into enabled, amount, min_hours from public.membership_settings where id = (plan = 'annual');
  if not coalesce(enabled, false) then return 0; end if;

  if plan = 'annual' then
    if p_duration >= min_hours then
      return least(amount, greatest(p_subtotal - 0.01, 0));
    end if;
    return 0;
  end if;

  select coalesce(sum(greatest(block.rate - amount, 0) *
    greatest(least(block.end_hour, p_start + p_duration) -
      greatest(block.start_hour, p_start, p_venue.evening_start_hour), 0)), 0)
    into discount
    from public.resolve_schedule_blocks(to_jsonb(p_venue), p_date) block
    where block.kind = 'court' and block.start_hour < p_start + p_duration and block.end_hour > p_start;
  return discount;
end;
$$;

revoke all on function public.save_membership_court_discount(text, boolean, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.save_membership_court_discount(text, boolean, integer, integer, integer) to authenticated;
notify pgrst, 'reload schema';

commit;
