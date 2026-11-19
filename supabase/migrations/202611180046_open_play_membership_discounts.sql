begin;

alter table public.membership_settings
  add column open_play_discount_enabled boolean not null default false,
  add column open_play_discount_cents integer not null default 1 check (open_play_discount_cents between 1 and 10000000),
  add column open_play_member_floor_cents integer not null default 1 check (open_play_member_floor_cents between 1 and 10000000),
  add column open_play_discount_revision integer not null default 0;

-- Replace the former court-only check while preserving saved discount amounts.
do $$
declare constraint_name text;
begin
  select conname into strict constraint_name from pg_constraint
  where conrelid = 'public.bookings'::regclass and contype = 'c'
    and pg_get_constraintdef(oid) like '%membership_discount_amount%'
    and pg_get_constraintdef(oid) like '%booking_type%';
  execute format('alter table public.bookings drop constraint %I', constraint_name);
end;
$$;
alter table public.bookings add constraint bookings_membership_discount_nonnegative check (membership_discount_amount >= 0);
create index bookings_open_play_member_discount_idx on public.bookings(user_id, booking_date, start_hour)
  where booking_type = 'open_play' and membership_discount_amount > 0
    and status in ('awaiting_payment', 'awaiting_verification', 'confirmed');

create function public.save_membership_open_play_discount(
  p_plan text, p_enabled boolean, p_amount_cents integer, p_floor_cents integer, p_expected_revision integer
) returns integer language plpgsql security definer set search_path = '' as $$
declare saved_revision integer;
begin
  if not public.is_staff() then raise exception 'Membership: Manager or owner access is required.'; end if;
  if p_plan is null or p_plan not in ('annual', 'six-month') then raise exception 'Membership: Choose a membership plan.'; end if;
  if p_enabled is null or p_amount_cents is null or p_amount_cents not between 1 and 10000000
    or p_floor_cents is null or p_floor_cents not between 1 and 10000000
    or p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'Membership: Enter a valid open-play discount and minimum discounted price.';
  end if;
  update public.membership_settings
    set open_play_discount_enabled = p_enabled, open_play_discount_cents = p_amount_cents,
      open_play_member_floor_cents = p_floor_cents, open_play_discount_revision = open_play_discount_revision + 1
    where id = (p_plan = 'annual') and open_play_discount_revision = p_expected_revision
      and (open_play_discount_enabled, open_play_discount_cents, open_play_member_floor_cents)
        is distinct from (p_enabled, p_amount_cents, p_floor_cents)
    returning open_play_discount_revision into saved_revision;
  if found then return saved_revision; end if;

  select open_play_discount_revision into saved_revision from public.membership_settings
    where id = (p_plan = 'annual') and (open_play_discount_enabled, open_play_discount_cents, open_play_member_floor_cents)
      = (p_enabled, p_amount_cents, p_floor_cents);
  if found then return saved_revision; end if;
  raise exception 'Membership: Someone updated this discount. Reload before saving.';
end;
$$;

create function private.open_play_member_discount(p_customer uuid, p_date date, p_start integer, p_price numeric)
returns numeric language sql stable set search_path = '' as $$
  select coalesce((
    select least(settings.open_play_discount_cents / 100.0, greatest(p_price - settings.open_play_member_floor_cents / 100.0, 0))
    from public.membership_settings settings
    join lateral (
      select application.plan_id from public.membership_applications application
      where application.user_id = p_customer and application.status = 'approved'
        and application.starts_on <= (now() at time zone 'Asia/Manila')::date
        and application.starts_on <= p_date and p_date < application.expires_on
      order by application.starts_on desc, application.reviewed_at desc, application.id desc limit 1
    ) as member on settings.id = (member.plan_id = 'annual')
    where settings.open_play_discount_enabled and not exists (
      select 1 from public.bookings b
      where b.user_id = p_customer and b.booking_type = 'open_play' and b.booking_date = p_date and b.start_hour = p_start
        and b.membership_discount_amount > 0 and b.status in ('awaiting_payment', 'awaiting_verification', 'confirmed')
        and (b.status <> 'awaiting_payment' or b.hold_expires_at > now())
    )
  ), 0);
$$;

create function private.quote_member_open_play(
  p_customer uuid, p_date date, p_start integer, p_people integer, p_quantity integer
) returns jsonb language plpgsql stable set search_path = '' as $$
declare
  today date := (now() at time zone 'Asia/Manila')::date;
  venue public.venue_settings%rowtype;
  session record;
  regular_total numeric;
  discount numeric;
begin
  if p_date is null or p_date not between today and today + 30 or p_start is null or p_start not between 0 and 23
    or p_people is null or p_people not between 1 and 20 or p_quantity is null or p_quantity not between 0 and p_people then
    raise exception 'Booking: Choose a valid open-play session, group size, and equipment quantity.';
  end if;
  select * into venue from public.venue_settings where id;
  select s.rate, s.end_hour into session from public.resolve_schedule_blocks(to_jsonb(venue), p_date) s
    where s.kind = 'open_play' and s.start_hour = p_start;
  if not found or (p_date + session.end_hour * interval '1 hour') at time zone 'Asia/Manila' <= now() then
    raise exception 'Booking: Choose an available open-play session.';
  end if;
  regular_total := session.rate * p_people + p_quantity * venue.equipment_rental_price;
  discount := private.open_play_member_discount(p_customer, p_date, p_start, session.rate);
  return jsonb_build_object('regularCents', round(regular_total * 100)::bigint, 'discountCents', round(discount * 100)::bigint,
    'totalCents', round((regular_total - discount) * 100)::bigint);
end;
$$;

create function public.get_open_play_member_discount(p_date date, p_start integer)
returns integer language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Booking: Sign in to see your member price.'; end if;
  return (private.quote_member_open_play(auth.uid(), p_date, p_start, 1, 0)->>'discountCents')::integer;
end;
$$;

create function public.pos_quote_member_open_play_walk_in(p_customer uuid, p_date date, p_start integer, p_people integer, p_quantity integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.pos_require_staff();
  perform private.require_confirmed_walk_in_customer(p_customer);
  return private.quote_member_open_play(p_customer, p_date, p_start, p_people, p_quantity);
end;
$$;

create function private.price_online_member_open_play() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.user_id is distinct from auth.uid() then return new; end if;
  -- The schedule trigger already serializes writes by play date.
  new.membership_discount_amount := private.open_play_member_discount(new.user_id, new.booking_date, new.start_hour,
    (new.total_amount - new.equipment_amount) / new.participant_count);
  new.total_amount := new.total_amount - new.membership_discount_amount;
  return new;
end;
$$;
create trigger price_online_member_open_play before insert on public.bookings
for each row when (new.booking_type = 'open_play' and new.status = 'awaiting_payment' and new.user_id is not null)
execute function private.price_online_member_open_play();

-- Validate open-play totals inside the same rate-limited reservation gateway.
do $$
declare
  definition text := pg_get_functiondef('public.request_customer_booking(text,jsonb)'::regprocedure);
  court_only text := 'if p_action = ''reserve_court'' and p_input->>''expected_total_cents'' is not null';
begin
  if strpos(definition, court_only) = 0 then raise exception 'Expected booking quote check was not found.'; end if;
  execute replace(definition, court_only, 'if p_input->>''expected_total_cents'' is not null');
end;
$$;

create function private.book_member_walk_in(
  p_key uuid, p_customer uuid, p_date date, p_name text, p_phone text, p_court integer, p_start integer,
  p_duration integer, p_kind text, p_people integer, p_quantity integer, p_payment_option text, p_method text, p_reference text,
  p_verified boolean, p_collected_cents bigint, p_expected_total_cents bigint, p_notes text
)
returns uuid language plpgsql set search_path = '' as $$
declare
  existing private.pos_walk_in_requests%rowtype;
  booking public.bookings%rowtype;
  venue public.venue_settings%rowtype;
  booking_id uuid;
  gcash_reference text := nullif(btrim(p_reference), '');
  discount numeric;
  fingerprint bytea;
  request_fields jsonb;
begin
  perform private.pos_require_staff();
  if p_key is null or p_verified is distinct from true or p_collected_cents is null or p_collected_cents < 0
    or p_expected_total_cents is null or p_expected_total_cents < 0 or p_method is null
    or (p_method not in ('cash', 'gcash') and (not public.is_staff() or p_method not in ('card', 'bank_transfer', 'other')))
    or p_notes is null or length(p_notes) > 2000 or (not public.is_staff() and btrim(p_notes) <> '') then
    raise exception 'POS: Check the booking total and confirm the received payment.';
  end if;
  if (p_method = 'gcash') is distinct from (gcash_reference is not null) then
    raise exception 'POS: Enter a verified transaction reference for GCash payments only.';
  end if;
  if p_quantity is null or p_quantity not between 0 and 100 then
    raise exception 'Booking: Choose a valid number of equipment sets.';
  end if;
  request_fields := jsonb_build_array('member', p_customer, p_date, btrim(p_name), p_phone, p_court, p_start,
    p_duration, p_quantity, p_payment_option, p_method, gcash_reference, p_collected_cents, p_expected_total_cents, btrim(p_notes));
  -- Keep existing court retries compatible with migration 045.
  if p_kind = 'open_play' then request_fields := request_fields || jsonb_build_array(p_kind, p_people); end if;
  fingerprint := sha256(convert_to(request_fields::text, 'UTF8'));
  perform pg_advisory_xact_lock(hashtextextended('rally-walk-in:' || p_key::text, 0));
  select * into existing from private.pos_walk_in_requests where id = p_key;
  if found then
    if existing.actor_id <> auth.uid() or existing.request_hash <> fingerprint then
      raise exception 'POS: This request already recorded a different booking. Check Reservations before retrying.';
    end if;
    return existing.booking_id;
  end if;

  perform private.require_confirmed_walk_in_customer(p_customer);
  booking_id := public.reserve_equipment_booking(p_kind, p_date, p_name, p_phone, p_court, p_start,
    p_duration, p_people, p_quantity > 0, true, false, 'unspecified', '', p_payment_option, p_quantity);
  select * into booking from public.bookings where id = booking_id;
  if p_kind = 'open_play' then
    discount := private.open_play_member_discount(p_customer, booking.booking_date, booking.start_hour,
      (booking.total_amount - booking.equipment_amount) / booking.participant_count);
  else
    select * into venue from public.venue_settings where id;
    discount := private.private_booking_member_discount(p_customer, venue, booking.booking_date, booking.start_hour,
      booking.duration, booking.total_amount - booking.equipment_amount);
  end if;
  if round((booking.total_amount - discount) * 100) <> p_expected_total_cents then
    raise exception 'Booking: The price or membership changed. Go back and review the updated total.';
  end if;

  update public.bookings set user_id = p_customer, account_linked_walk_in = true,
    membership_discount_amount = discount, total_amount = total_amount - discount, payment_reference = gcash_reference
    where id = booking_id returning * into booking;
  if round(booking.paid_amount * 100) <> p_collected_cents then
    raise exception 'POS: The amount to collect changed. Go back and review the updated total.';
  end if;
  update public.booking_finance set payment_method = p_method, notes = btrim(p_notes), updated_at = now(), updated_by = auth.uid()
    where booking_finance.booking_id = booking.id;
  insert into private.pos_walk_in_requests(id, actor_id, booking_id, request_hash)
    values (p_key, auth.uid(), booking.id, fingerprint);
  insert into public.pos_audit(actor_id, action, entity_id, detail)
    values (auth.uid(), 'booking.walk_in', booking.id, jsonb_build_object('method', p_method, 'membership_discount', discount));
  return booking.id;
end;
$$;

create or replace function public.pos_book_member_walk_in(
  p_key uuid, p_customer uuid, p_date date, p_name text, p_phone text, p_court integer, p_start integer,
  p_duration integer, p_quantity integer, p_payment_option text, p_method text, p_reference text,
  p_verified boolean, p_collected_cents bigint, p_expected_total_cents bigint, p_notes text
) returns uuid language sql security definer set search_path = '' as $$
  select private.book_member_walk_in(p_key, p_customer, p_date, p_name, p_phone, p_court, p_start, p_duration,
    'court', 1, p_quantity, p_payment_option, p_method, p_reference, p_verified, p_collected_cents, p_expected_total_cents, p_notes);
$$;

create function public.pos_book_member_open_play_walk_in(
  p_key uuid, p_customer uuid, p_date date, p_name text, p_phone text, p_start integer,
  p_people integer, p_quantity integer, p_payment_option text, p_method text, p_reference text,
  p_verified boolean, p_collected_cents bigint, p_expected_total_cents bigint, p_notes text
) returns uuid language sql security definer set search_path = '' as $$
  select private.book_member_walk_in(p_key, p_customer, p_date, p_name, p_phone, null, p_start, 1,
    'open_play', p_people, p_quantity, p_payment_option, p_method, p_reference, p_verified, p_collected_cents, p_expected_total_cents, p_notes);
$$;

revoke all on function private.open_play_member_discount(uuid, date, integer, numeric),
  private.quote_member_open_play(uuid, date, integer, integer, integer), private.price_online_member_open_play(),
  private.book_member_walk_in(uuid, uuid, date, text, text, integer, integer, integer, text, integer, integer, text, text, text, boolean, bigint, bigint, text),
  public.save_membership_open_play_discount(text, boolean, integer, integer, integer),
  public.get_open_play_member_discount(date, integer),
  public.pos_quote_member_open_play_walk_in(uuid, date, integer, integer, integer),
  public.pos_book_member_open_play_walk_in(uuid, uuid, date, text, text, integer, integer, integer, text, text, text, boolean, bigint, bigint, text)
from public, anon, authenticated;
grant execute on function public.save_membership_open_play_discount(text, boolean, integer, integer, integer),
  public.get_open_play_member_discount(date, integer),
  public.pos_quote_member_open_play_walk_in(uuid, date, integer, integer, integer),
  public.pos_book_member_open_play_walk_in(uuid, uuid, date, text, text, integer, integer, integer, text, text, text, boolean, bigint, bigint, text)
to authenticated;
notify pgrst, 'reload schema';

commit;
