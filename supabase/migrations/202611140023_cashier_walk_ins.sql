begin;

-- Keep walk-ins on the existing reservation path for pricing, capacity, and conflicts.
-- The cashier RPC below records payment metadata before the deferred POS trigger runs.
do $$
declare
  definition text := pg_get_functiondef(
    'public.reserve_scheduled_booking_internal(text,date,text,text,integer,integer,integer,integer,boolean,boolean,boolean,text,text,text)'::regprocedure
  );
  staff_check text := 'if p_walk_in and not public.is_staff() then';
  finance_write text := 'if p_walk_in and not p_blocked then perform public.staff_save_booking_finance';
begin
  if strpos(definition, staff_check) = 0 or strpos(definition, finance_write) = 0 then
    raise exception 'Expected scheduled booking authorization was not found.';
  end if;
  definition := replace(definition, staff_check,
    'if p_walk_in and not (public.is_staff() or (not p_blocked and public.club_role() is not distinct from ''cashier'')) then');
  definition := replace(definition, finance_write,
    'if p_walk_in and not p_blocked and public.is_staff() then perform public.staff_save_booking_finance');
  execute definition;
end;
$$;

create table private.pos_walk_in_requests (
  id uuid primary key,
  actor_id uuid not null references auth.users(id),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  request_hash bytea not null
);
alter table private.pos_walk_in_requests enable row level security;
revoke all on private.pos_walk_in_requests from public, anon, authenticated;

create function public.pos_book_walk_in(
  p_key uuid, p_kind text, p_date date, p_name text, p_phone text, p_court int,
  p_start int, p_duration int, p_people int, p_quantity int, p_payment_option text,
  p_method text, p_reference text, p_verified boolean, p_collected_cents int
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  existing private.pos_walk_in_requests%rowtype;
  new_booking_id uuid;
  ref text := nullif(btrim(p_reference), '');
  fingerprint bytea;
begin
  perform private.pos_require_staff();
  if p_key is null or p_verified is distinct from true or p_collected_cents is null or p_collected_cents < 0
    or p_method is null or p_method not in ('cash', 'gcash') then
    raise exception 'POS: Choose cash or GCash and confirm the received payment.';
  end if;
  if p_quantity is null or p_quantity not between 0 and 100 then
    raise exception 'Booking: Choose a valid number of equipment sets.';
  end if;
  if p_method = 'gcash' and ref is null then
    raise exception 'POS: Enter the verified GCash transaction reference.';
  end if;
  if p_method = 'cash' and ref is not null then
    raise exception 'POS: Use a payment reference only for GCash.';
  end if;
  fingerprint := sha256(convert_to(jsonb_build_array(p_kind, p_date, btrim(p_name), p_phone, p_court,
    p_start, p_duration, p_people, p_quantity, p_payment_option, p_method, ref, p_collected_cents)::text, 'UTF8'));
  perform pg_advisory_xact_lock(hashtextextended('rally-walk-in:' || p_key::text, 0));
  select * into existing from private.pos_walk_in_requests where id = p_key;
  if found then
    if existing.actor_id <> auth.uid() or existing.request_hash <> fingerprint then
      raise exception 'POS: This request already recorded a different booking. Check Reservations before retrying.';
    end if;
    return existing.booking_id;
  end if;

  new_booking_id := public.reserve_equipment_booking(p_kind, p_date, p_name, p_phone, p_court,
    p_start, p_duration, p_people, p_quantity > 0, true, false, 'unspecified', '', p_payment_option, p_quantity);
  if not exists(select 1 from public.bookings where id = new_booking_id and paid_amount * 100 = p_collected_cents) then
    raise exception 'POS: The payment amount changed. Refresh the calendar and check the updated price.';
  end if;
  update public.booking_finance f
    set payment_method = p_method, updated_at = now(), updated_by = auth.uid()
    where f.booking_id = new_booking_id;
  if p_method = 'gcash' then
    -- The shared POS trigger validates the reference and rejects reuse across the ledger.
    update public.bookings set payment_reference = ref where id = new_booking_id;
  end if;
  insert into private.pos_walk_in_requests(id, actor_id, booking_id, request_hash)
    values (p_key, auth.uid(), new_booking_id, fingerprint);
  insert into public.pos_audit(actor_id, action, entity_id, detail)
    values (auth.uid(), 'booking.walk_in', new_booking_id, jsonb_build_object('method', p_method));
  return new_booking_id;
end;
$$;

create function public.pos_calendar_reservations(p_date date)
returns table(
  id uuid, reference text, customer_name text, start_hour smallint, duration smallint,
  court_id smallint, booking_type text, participant_count int, status text,
  total_amount numeric, paid_amount numeric, initial_payment_amount numeric, payment_option text,
  payment_reference text, payment_rejected_at timestamptz, equipment_rental boolean,
  equipment_quantity int, equipment_amount numeric, equipment_ball_count int
)
language plpgsql security definer set search_path = '' as $$
begin
  perform private.pos_require_staff();
  if p_date is null or p_date not between date '2000-01-01' and date '2100-12-31' then
    raise exception 'POS: Choose a valid calendar date.';
  end if;
  return query select b.id, b.reference, b.customer_name, b.start_hour, b.duration, b.court_id,
    b.booking_type, b.participant_count::int, b.status, b.total_amount, b.paid_amount,
    b.initial_payment_amount, b.payment_option, b.payment_reference, b.payment_rejected_at,
    b.equipment_rental, b.equipment_quantity, b.equipment_amount, b.equipment_ball_count::int
  from public.bookings b where b.booking_date = p_date order by b.id;
end;
$$;

revoke all on function public.pos_book_walk_in(uuid,text,date,text,text,int,int,int,int,int,text,text,text,boolean,int),
  public.pos_calendar_reservations(date) from public, anon, authenticated;
grant execute on function public.pos_book_walk_in(uuid,text,date,text,text,int,int,int,int,int,text,text,text,boolean,int),
  public.pos_calendar_reservations(date) to authenticated;

notify pgrst, 'reload schema';
commit;
