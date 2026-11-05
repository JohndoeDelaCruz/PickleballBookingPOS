-- Multiple rental sets, with historical unit prices/inclusions preserved.
-- Apply after migration 011. Old one-set clients remain compatible; the new
-- app uses a versioned gateway so missing migration 012 cannot undercharge it.
begin;

alter table public.bookings
  add column equipment_quantity int not null default 0,
  add column equipment_unit_price numeric(10,2) not null default 0;
update public.bookings set equipment_quantity=1,equipment_unit_price=equipment_amount where equipment_rental;
alter table public.bookings add constraint booking_equipment_quantity_valid check (
  equipment_quantity between 0 and 100 and equipment_unit_price>=0
  and equipment_rental=(equipment_quantity>0)
  and equipment_amount=equipment_unit_price*equipment_quantity
);

create function public.snapshot_equipment_quantity() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if not new.equipment_rental then
    new.equipment_quantity:=0; new.equipment_unit_price:=0;
  elsif tg_op='INSERT' or not old.equipment_rental then
    -- Existing boolean entry points always buy exactly one set.
    new.equipment_quantity:=1; new.equipment_unit_price:=new.equipment_amount;
  else
    new.equipment_unit_price:=old.equipment_unit_price;
  end if;
  return new;
end;
$$;
create trigger snapshot_equipment_quantity before insert or update of equipment_rental,equipment_quantity,equipment_unit_price on public.bookings
  for each row execute function public.snapshot_equipment_quantity();

create function public.reserve_equipment_booking(p_kind text,p_date date,p_name text,p_phone text,
  p_court int default null,p_start int default null,p_duration int default 1,p_people int default 1,
  p_rental boolean default false,p_walk_in boolean default false,p_blocked boolean default false,
  p_method text default 'cash',p_notes text default '',p_payment_option text default 'full',p_quantity int default null)
returns uuid language plpgsql security definer set search_path='' as $$
declare v public.venue_settings%rowtype; booking_id uuid; quantity int; player_limit int;
begin
  if auth.uid() is null then raise exception 'Booking: Please sign in before reserving.'; end if;
  quantity:=coalesce(p_quantity,case when p_rental then 1 else 0 end);
  if quantity not between 0 and 100 or (p_blocked and quantity>0) then
    raise exception 'Booking: Choose a valid number of equipment sets.'; end if;
  -- Reuse the existing user/booking/venue lock order. Any later validation
  -- failure rolls back the whole booking inside the gateway's subtransaction.
  booking_id:=public.reserve_scheduled_booking_internal(p_kind,p_date,p_name,p_phone,p_court,p_start,p_duration,p_people,
    quantity>0,p_walk_in,p_blocked,p_method,p_notes,p_payment_option);
  select * into v from public.venue_settings where id=true for share;
  if p_kind='open_play' then player_limit:=p_people;
  else
    select min(coalesce(s.capacity,v.private_court_capacity)) into player_limit
      from public.resolve_schedule_blocks(to_jsonb(v),p_date) s
      where s.kind='court' and s.start_hour<p_start+p_duration and s.end_hour>p_start;
    player_limit:=coalesce(player_limit,v.private_court_capacity);
  end if;
  if quantity>player_limit then raise exception 'Booking: Equipment sets cannot exceed the number of players allowed in this booking.'; end if;
  if quantity>1 then
    update public.bookings set
      total_amount=total_amount-equipment_amount+equipment_unit_price*quantity,
      equipment_amount=equipment_unit_price*quantity,equipment_quantity=quantity where id=booking_id;
  end if;
  return booking_id;
end;
$$;

-- Staff retains its own authorized path, without customer request allowances.
create function public.reserve_staff_equipment_booking(p_kind text,p_date date,p_name text,p_phone text,
  p_court int default null,p_start int default null,p_duration int default 1,p_people int default 1,
  p_rental boolean default false,p_blocked boolean default false,
  p_method text default 'cash',p_notes text default '',p_payment_option text default 'full',p_quantity int default null)
returns uuid language plpgsql security definer set search_path='' as $$
begin
  if not public.is_staff() then raise exception 'Booking: Staff access is required.'; end if;
  return public.reserve_equipment_booking(p_kind,p_date,p_name,p_phone,p_court,p_start,p_duration,p_people,
    p_rental,true,p_blocked,p_method,p_notes,p_payment_option,p_quantity);
end;
$$;

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


-- No second counter: both versions use the same authenticated sliding window.
create function public.request_customer_booking_v2(p_action text,p_input jsonb default null)
returns jsonb language sql security definer set search_path='' as $$
  select public.request_customer_booking(p_action,p_input);
$$;

revoke all on function public.snapshot_equipment_quantity(),
  public.reserve_equipment_booking(text,date,text,text,int,int,int,int,boolean,boolean,boolean,text,text,text,int),
  public.reserve_staff_equipment_booking(text,date,text,text,int,int,int,int,boolean,boolean,text,text,text,int),
  public.request_customer_booking_v2(text,jsonb) from public,anon,authenticated;
grant execute on function public.reserve_staff_equipment_booking(text,date,text,text,int,int,int,int,boolean,boolean,text,text,text,int),
  public.request_customer_booking_v2(text,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
