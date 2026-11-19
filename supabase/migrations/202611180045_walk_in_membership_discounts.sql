begin;

-- A linked walk-in appears in My bookings, with its original counter payment method.
alter table public.bookings add column account_linked_walk_in boolean not null default false;

create or replace function public.staff_save_booking_finance(p_booking uuid, p_method text, p_notes text default '')
returns void language plpgsql security definer set search_path = '' as $$
declare booking public.bookings%rowtype;
begin
  if not public.is_staff() then raise exception 'Booking: Staff access is required.'; end if;
  select * into booking from public.bookings where id = p_booking for update;
  if not found or booking.status = 'blocked' then raise exception 'Booking: Choose a reservation.'; end if;
  if p_method is null or p_method not in ('cash','gcash','bank_transfer','card','other','unspecified')
    or p_notes is null or length(p_notes) > 2000 then raise exception 'Booking: Check the payment method and notes.'; end if;
  if booking.user_id is not null and not booking.account_linked_walk_in and p_method <> 'gcash' then
    raise exception 'Booking: Online reservations use GCash.';
  end if;
  insert into public.booking_finance(booking_id, payment_method, notes, updated_by)
    values (p_booking, p_method, trim(p_notes), auth.uid())
    on conflict (booking_id) do update set payment_method = excluded.payment_method,
      notes = excluded.notes, updated_at = now(), updated_by = auth.uid();
end;
$$;

do $$
declare
  definition text := pg_get_functiondef('private.pos_sync_booking(uuid)'::regprocedure);
  online_method text := 'if b.user_id is not null then method:=''gcash'';';
begin
  if strpos(definition, online_method) = 0 then raise exception 'Expected booking payment classification was not found.'; end if;
  execute replace(definition, online_method,
    'if b.user_id is not null and not b.account_linked_walk_in then method:=''gcash'';');
end;
$$;

create function private.require_confirmed_walk_in_customer(p_customer uuid) returns void
language plpgsql stable set search_path = '' as $$
begin
  if not exists (select 1 from auth.users where id = p_customer and email_confirmed_at is not null and nullif(btrim(email), '') is not null) then
    raise exception 'Booking: Choose a customer with a confirmed email address.';
  end if;
end;
$$;

create function public.pos_quote_member_walk_in(p_customer uuid, p_date date, p_start integer, p_duration integer, p_quantity integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  today date := (now() at time zone 'Asia/Manila')::date;
  venue public.venue_settings%rowtype;
  court_amount numeric;
  regular_total numeric;
  discount numeric;
begin
  perform private.pos_require_staff();
  perform private.require_confirmed_walk_in_customer(p_customer);
  if p_date is null or p_date not between today and today + 30 or p_start is null or p_start not between 0 and 23
    or p_duration is null or p_duration not between 1 and 4 or p_quantity is null or p_quantity not between 0 and 100 then
    raise exception 'Booking: Choose a valid court time and equipment quantity.';
  end if;
  select * into venue from public.venue_settings where id;
  court_amount := public.quote_schedule_total(to_jsonb(venue), p_date, p_start, p_duration);
  if court_amount is null then raise exception 'Booking: Choose an available private-booking time.'; end if;
  regular_total := court_amount + p_quantity * venue.equipment_rental_price;
  discount := private.private_booking_member_discount(p_customer, venue, p_date, p_start, p_duration, court_amount);
  return jsonb_build_object('regularCents', round(regular_total * 100)::bigint,
    'discountCents', round(discount * 100)::bigint, 'totalCents', round((regular_total - discount) * 100)::bigint);
end;
$$;

create function public.pos_book_member_walk_in(
  p_key uuid, p_customer uuid, p_date date, p_name text, p_phone text, p_court integer, p_start integer,
  p_duration integer, p_quantity integer, p_payment_option text, p_method text, p_reference text,
  p_verified boolean, p_collected_cents bigint, p_expected_total_cents bigint, p_notes text
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  existing private.pos_walk_in_requests%rowtype;
  booking public.bookings%rowtype;
  venue public.venue_settings%rowtype;
  booking_id uuid;
  gcash_reference text := nullif(btrim(p_reference), '');
  discount numeric;
  fingerprint bytea;
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
  fingerprint := sha256(convert_to(jsonb_build_array('member', p_customer, p_date, btrim(p_name), p_phone, p_court, p_start,
    p_duration, p_quantity, p_payment_option, p_method, gcash_reference, p_collected_cents, p_expected_total_cents, btrim(p_notes))::text, 'UTF8'));
  perform pg_advisory_xact_lock(hashtextextended('rally-walk-in:' || p_key::text, 0));
  select * into existing from private.pos_walk_in_requests where id = p_key;
  if found then
    if existing.actor_id <> auth.uid() or existing.request_hash <> fingerprint then
      raise exception 'POS: This request already recorded a different booking. Check Reservations before retrying.';
    end if;
    return existing.booking_id;
  end if;

  perform private.require_confirmed_walk_in_customer(p_customer);
  booking_id := public.reserve_equipment_booking('court', p_date, p_name, p_phone, p_court, p_start,
    p_duration, 1, p_quantity > 0, true, false, 'unspecified', '', p_payment_option, p_quantity);
  select * into booking from public.bookings where id = booking_id;
  select * into venue from public.venue_settings where id;
  discount := private.private_booking_member_discount(p_customer, venue, booking.booking_date, booking.start_hour,
    booking.duration, booking.total_amount - booking.equipment_amount);
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

revoke all on function private.require_confirmed_walk_in_customer(uuid),
  public.pos_quote_member_walk_in(uuid, date, integer, integer, integer),
  public.pos_book_member_walk_in(uuid, uuid, date, text, text, integer, integer, integer, integer, text, text, text, boolean, bigint, bigint, text)
from public, anon, authenticated;
grant execute on function public.pos_quote_member_walk_in(uuid, date, integer, integer, integer),
  public.pos_book_member_walk_in(uuid, uuid, date, text, text, integer, integer, integer, integer, text, text, text, boolean, bigint, bigint, text)
to authenticated;
notify pgrst, 'reload schema';

commit;
