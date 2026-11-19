begin;

alter table public.bookings add column membership_discount_amount numeric(10,2) not null default 0
  check (membership_discount_amount >= 0 and (booking_type = 'court' or membership_discount_amount = 0));

-- Install the quote and booking hooks before configurable discounts are added.
create function private.private_booking_member_discount(
  p_actor uuid, p_venue public.venue_settings, p_date date, p_start integer, p_duration integer, p_subtotal numeric
) returns numeric language sql stable set search_path = '' as $$
  select 0::numeric;
$$;

create function public.get_private_booking_member_discount(p_date date, p_start integer, p_duration integer)
returns numeric language plpgsql stable security definer set search_path = '' as $$
declare
  venue public.venue_settings%rowtype;
  today date := (now() at time zone 'Asia/Manila')::date;
begin
  if auth.uid() is null then raise exception 'Booking: Sign in to see your member price.'; end if;
  if p_date is null or p_date not between today and today + 30 or p_start is null or p_start not between 0 and 23
    or p_duration is null or p_duration not between 1 and 4
  then raise exception 'Booking: Choose a valid court time.'; end if;

  select * into venue from public.venue_settings where id;
  return private.private_booking_member_discount(auth.uid(), venue, p_date, p_start, p_duration,
    public.quote_schedule_total(to_jsonb(venue), p_date, p_start, p_duration));
end;
$$;

create function private.price_online_member_booking() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  venue public.venue_settings%rowtype;
begin
  if new.user_id is distinct from auth.uid() then return new; end if;
  select * into venue from public.venue_settings where id for share;
  new.membership_discount_amount := private.private_booking_member_discount(
    new.user_id, venue, new.booking_date, new.start_hour, new.duration, new.total_amount - new.equipment_amount
  );
  new.total_amount := new.total_amount - new.membership_discount_amount;
  return new;
end;
$$;

-- BEFORE triggers run alphabetically. Apply the discount after the schedule
-- sets the regular amount, and before the payment terms are saved.
create trigger price_online_member_booking before insert on public.bookings
for each row when (new.booking_type = 'court' and new.status = 'awaiting_payment' and new.user_id is not null)
execute function private.price_online_member_booking();

-- The existing rate-limited booking gateway rejects a stale quote in the
-- subtransaction that creates the booking, keeping the request count.
create or replace function public.request_customer_booking(p_action text,p_input jsonb default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  uid uuid:=auth.uid(); bucket text; request_at timestamptz; recent timestamptz[];
  retry_seconds int; booking_id uuid; error_message text; error_code text;
begin
  if uid is null then return jsonb_build_object('error','Please sign in before continuing.','code','AUTH_REQUIRED'); end if;
  bucket:=case p_action when 'reserve_court' then 'reserve' when 'reserve_open_play' then 'reserve'
    when 'cancel' then 'cancel' when 'payment' then 'payment' end;
  if bucket is null then return jsonb_build_object('error','Choose a valid booking action.','code','INVALID_INPUT'); end if;

  insert into private.booking_request_limits(user_id,action) values(uid,bucket) on conflict do nothing;
  -- Serialize the check and append. Separate browser tabs/servers cannot spend
  -- the same allowance concurrently. At most three rows/five times per account.
  select attempts into recent from private.booking_request_limits where user_id=uid and action=bucket for update;
  request_at:=clock_timestamp();
  select coalesce(array_agg(attempt order by attempt),'{}'::timestamptz[]) into recent
    from unnest(recent) attempt where attempt>request_at-interval '10 minutes';
  if cardinality(recent)>=5 then
    retry_seconds:=greatest(1,ceil(extract(epoch from recent[1]+interval '10 minutes'-request_at))::int);
    return jsonb_build_object('error','Too many requests. Please try again in '||ceil(retry_seconds/60.0)::int||
      case when retry_seconds<=60 then ' minute.' else ' minutes.' end,
      'code','RATE_LIMITED','retry_after_seconds',retry_seconds);
  end if;
  update private.booking_request_limits set attempts=array_append(recent,request_at) where user_id=uid and action=bucket;

  -- Only business writes roll back on failure. The counter above stays outside
  -- this exception subtransaction, so malformed/conflicting requests count too.
  begin
    if p_input is null or jsonb_typeof(p_input)<>'object' then
      return jsonb_build_object('error','Check the booking details and try again.','code','INVALID_INPUT');
    end if;
    if bucket='reserve' then
      -- Identity, price, status, staff flags and finance fields never come from
      -- the caller. Courts and open play deliberately share one allowance.
      booking_id:=public.reserve_equipment_booking(
        p_kind=>case when p_action='reserve_court' then 'court' else 'open_play' end,
        p_date=>(p_input->>'booking_date')::date,
        p_name=>p_input->>'customer_name',p_phone=>trim(p_input->>'customer_phone'),
        p_court=>(p_input->>'court_id')::int,p_start=>(p_input->>'start_hour')::int,
        p_duration=>coalesce((p_input->>'duration')::int,1),p_people=>coalesce((p_input->>'participant_count')::int,1),
        p_rental=>coalesce((p_input->>'equipment_rental')::boolean,false),
        p_walk_in=>false,p_blocked=>false,p_payment_option=>coalesce(p_input->>'payment_option','full'),
        p_quantity=>(p_input->>'equipment_quantity')::int);
      if p_action = 'reserve_court' and p_input->>'expected_total_cents' is not null
        and (p_input->>'expected_total_cents')::bigint is distinct from
          (select (total_amount * 100)::bigint from public.bookings where id = booking_id)
      then
        raise exception 'Booking: Your booking price changed. Review the updated total and try again.';
      end if;
      return jsonb_build_object('id',booking_id);
    elsif bucket='payment' then
      perform public.submit_payment_reference((p_input->>'booking_id')::uuid,trim(p_input->>'reference'));
    else
      perform public.cancel_booking((p_input->>'booking_id')::uuid);
    end if;
    return jsonb_build_object('success',true);
  exception when others then
    get stacked diagnostics error_message=message_text,error_code=returned_sqlstate;
    if error_code='23P01' then error_message:='That time was just reserved. Please choose another slot.';
    elsif left(error_message,9)='Booking: ' then error_message:=substr(error_message,10);
    elsif error_code like '22%' then error_message:='Check the booking details and try again.';
    else error_message:='We couldn’t complete that request. Please refresh and try again.';
    end if;
    return jsonb_build_object('error',error_message,'code','REQUEST_REJECTED');
  end;
end;
$$;

revoke all on function private.private_booking_member_discount(uuid, public.venue_settings, date, integer, integer, numeric),
  private.price_online_member_booking(), public.get_private_booking_member_discount(date, integer, integer)
  from public, anon, authenticated;
grant execute on function public.get_private_booking_member_discount(date, integer, integer) to authenticated;
notify pgrst, 'reload schema';
commit;
