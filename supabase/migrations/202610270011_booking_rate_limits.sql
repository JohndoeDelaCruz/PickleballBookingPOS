-- One authenticated gateway for customer mutations. Returning an error value
-- (rather than raising it) commits the attempt even when the mutation fails.
-- Deploy the matching app before applying this migration; old customer RPCs
-- deliberately lose direct EXECUTE permission. Existing bookings are untouched.
begin;

create schema if not exists private;
create table private.booking_request_limits (
  user_id uuid not null references auth.users(id) on delete cascade,
  action text not null check (action in ('reserve','cancel','payment')),
  attempts timestamptz[] not null default '{}',
  primary key (user_id,action),
  check (cardinality(attempts)<=5)
);
alter table private.booking_request_limits enable row level security;
revoke all on private.booking_request_limits from public,anon,authenticated;

-- Keep the existing, tested price/capacity/payment implementation internal.
alter function public.reserve_scheduled_booking(text,date,text,text,int,int,int,int,boolean,boolean,boolean,text,text,text)
  rename to reserve_scheduled_booking_internal;

-- Staff calendar calls keep their signature and their staff authorization.
create function public.reserve_scheduled_booking(p_kind text,p_date date,p_name text,p_phone text,
  p_court int default null,p_start int default null,p_duration int default 1,p_people int default 1,
  p_rental boolean default false,p_walk_in boolean default false,p_blocked boolean default false,
  p_method text default 'cash',p_notes text default '',p_payment_option text default 'full')
returns uuid language plpgsql security definer set search_path='' as $$
begin
  if not public.is_staff() then raise exception 'Booking: Staff access is required.'; end if;
  return public.reserve_scheduled_booking_internal(p_kind,p_date,p_name,p_phone,p_court,p_start,p_duration,p_people,
    p_rental,p_walk_in,p_blocked,p_method,p_notes,p_payment_option);
end;
$$;

create function public.request_customer_booking(p_action text,p_input jsonb default null)
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
      booking_id:=public.reserve_scheduled_booking_internal(
        p_kind=>case when p_action='reserve_court' then 'court' else 'open_play' end,
        p_date=>(p_input->>'booking_date')::date,
        p_name=>p_input->>'customer_name',p_phone=>trim(p_input->>'customer_phone'),
        p_court=>(p_input->>'court_id')::int,p_start=>(p_input->>'start_hour')::int,
        p_duration=>coalesce((p_input->>'duration')::int,1),p_people=>coalesce((p_input->>'participant_count')::int,1),
        p_rental=>coalesce((p_input->>'equipment_rental')::boolean,false),
        p_walk_in=>false,p_blocked=>false,p_payment_option=>coalesce(p_input->>'payment_option','full'));
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

-- Closing every older customer entry point prevents calling around the limit.
-- Definer functions can still call these helpers; authenticated API clients cannot.
revoke all on function public.create_booking(int,date,int,int,text,text),
  public.create_open_play_booking(date,int,text,text,boolean),
  public.reserve_with_equipment(text,date,text,text,int,int,int,int,boolean,boolean,boolean,text,text),
  public.reserve_with_payment(text,date,text,text,int,int,int,int,boolean,boolean,boolean,text,text,text),
  public.reserve_scheduled_booking_internal(text,date,text,text,int,int,int,int,boolean,boolean,boolean,text,text,text),
  public.submit_payment_reference(uuid,text),public.cancel_booking(uuid),
  public.reserve_scheduled_booking(text,date,text,text,int,int,int,int,boolean,boolean,boolean,text,text,text),
  public.request_customer_booking(text,jsonb) from public,anon,authenticated;
grant execute on function public.request_customer_booking(text,jsonb),
  public.reserve_scheduled_booking(text,date,text,text,int,int,int,int,boolean,boolean,boolean,text,text,text) to authenticated;

notify pgrst,'reload schema';
commit;
