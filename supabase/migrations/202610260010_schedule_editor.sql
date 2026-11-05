-- Weekly time blocks and dated overrides. NULL preserves the existing schedule.
-- No reservations, prices, payments, or live schedule settings are rewritten.
begin;
alter table public.venue_settings add column schedule_config jsonb;

create function public.validate_schedule_blocks(p_blocks jsonb) returns void
language plpgsql set search_path='' as $$
declare b jsonb; d jsonb;
begin
  if jsonb_typeof(p_blocks) is distinct from 'array' or jsonb_array_length(p_blocks)>100 then
    raise exception 'Booking: Supply at most 100 time blocks.'; end if;
  for b in select value from jsonb_array_elements(p_blocks) loop
    if jsonb_typeof(b) is distinct from 'object' or coalesce(b->>'id','') !~ '^[a-zA-Z0-9_-]{1,64}$'
      or coalesce(b->>'kind','') not in ('court','open_play')
      or jsonb_typeof(b->'days') is distinct from 'array'
      or jsonb_typeof(b->'start') is distinct from 'number' or jsonb_typeof(b->'end') is distinct from 'number'
      or jsonb_typeof(b->'rate') is distinct from 'number'
      then raise exception 'Booking: Check the days, times, type, and rate for each block.'; end if;
    if b->>'start' !~ '^\d+$' or b->>'end' !~ '^\d+$'
      or (b->>'start')::int not between 0 and 23 or (b->>'end')::int not between 1 and 24
      or (b->>'end')::int <= (b->>'start')::int or (b->>'rate')::numeric not between 0.01 and 100000
      or round((b->>'rate')::numeric,2)<>(b->>'rate')::numeric
      then raise exception 'Booking: Use whole-hour times and a positive rate with at most two decimals.'; end if;
    if jsonb_array_length(b->'days') not between 1 and 7 then raise exception 'Booking: Choose at least one day.'; end if;
    for d in select value from jsonb_array_elements(b->'days') loop
      if jsonb_typeof(d) is distinct from 'number' or d::text !~ '^[1-7]$' then raise exception 'Booking: Choose valid weekdays.'; end if;
    end loop;
    if (select count(distinct value) from jsonb_array_elements_text(b->'days'))<>jsonb_array_length(b->'days') then
      raise exception 'Booking: Choose each weekday once.'; end if;
    if not (b ? 'capacity') or (b->'capacity'<>'null'::jsonb and
      (jsonb_typeof(b->'capacity') is distinct from 'number' or b->>'capacity' !~ '^\d+$')) then
      raise exception 'Booking: Enter a whole-number player limit.'; end if;
    if b->'capacity'<>'null'::jsonb and (b->>'capacity')::int not between 1 and 100000 then
      raise exception 'Booking: The player limit must be positive.'; end if;
    if b->>'kind'='court' and ((b->>'capacity') is null or (b->>'capacity')::int>100) then
      raise exception 'Booking: Private courts need a player limit between 1 and 100.'; end if;
  end loop;
  if (select count(distinct value->>'id') from jsonb_array_elements(p_blocks))<>jsonb_array_length(p_blocks) then
    raise exception 'Booking: Time-block identifiers must be unique.'; end if;
  if exists(select 1 from jsonb_array_elements(p_blocks) with ordinality a(b,i)
    join jsonb_array_elements(p_blocks) with ordinality c(b,i) on c.i>a.i
    where (a.b->>'start')::int<(c.b->>'end')::int and (a.b->>'end')::int>(c.b->>'start')::int
      and exists(select 1 from jsonb_array_elements_text(a.b->'days') ad
        join jsonb_array_elements_text(c.b->'days') cd on ad.value=cd.value)) then
    raise exception 'Booking: Time blocks overlap on the same day.'; end if;
end;
$$;

-- The resolver is shared by public availability, booking enforcement, and edit validation.
create function public.resolve_schedule_blocks(p_venue jsonb,p_date date)
returns table(block_id text,start_hour int,end_hour int,kind text,rate numeric,capacity int)
language plpgsql immutable set search_path='' as $$
declare cfg jsonb := p_venue->'schedule_config'; period jsonb; rows jsonb; day int := extract(isodow from p_date); h int; legacy_open boolean;
begin
  if cfg is null or cfg='null'::jsonb then
    if (p_venue->>'opening_hour') is null or (p_venue->>'closing_hour') is null or (p_venue->>'hourly_rate') is null then return; end if;
    legacy_open := coalesce((p_venue->>'open_play_enabled')::boolean,false) and day in (6,7);
    for h in (p_venue->>'opening_hour')::int..((p_venue->>'closing_hour')::int-1) loop
      if legacy_open and h >= (p_venue->>'weekend_court_end_hour')::int and h < (p_venue->>'open_play_end_hour')::int then continue; end if;
      block_id := 'legacy-'||day||'-'||h; start_hour:=h; end_hour:=h+1; kind:='court';
      rate:=case when h<(p_venue->>'evening_start_hour')::int then (p_venue->>'hourly_rate')::numeric else (p_venue->>'evening_hourly_rate')::numeric end;
      capacity:=coalesce((p_venue->>'private_court_capacity')::int,8); return next;
    end loop;
    if legacy_open then
      block_id:='legacy-open-'||day; start_hour:=(p_venue->>'open_play_start_hour')::int; end_hour:=(p_venue->>'open_play_end_hour')::int;
      kind:='open_play'; rate:=(p_venue->>'open_play_price')::numeric; capacity:=(p_venue->>'open_play_capacity')::int; return next;
    end if;
    return;
  end if;
  select value into period from jsonb_array_elements(cfg->'overrides')
    where p_date between (value->>'start_date')::date and (value->>'end_date')::date limit 1;
  rows:=case when period is null then cfg->'weekly' else period->'blocks' end;
  return query select b->>'id',(b->>'start')::int,(b->>'end')::int,b->>'kind',(b->>'rate')::numeric,(b->>'capacity')::int
    from jsonb_array_elements(rows) b where (b->'days') @> to_jsonb(array[day]) order by (b->>'start')::int;
end;
$$;

create function public.quote_schedule_total(p_venue jsonb,p_date date,p_start int,p_duration int) returns numeric
language sql immutable set search_path='' as $$
  select case when p_start between 0 and 23 and p_duration between 1 and 4 and count(*)=p_duration then sum(b.rate) else null end
  from generate_series(p_start,p_start+p_duration-1) h
  join public.resolve_schedule_blocks(p_venue,p_date) b on b.kind='court' and h>=b.start_hour and h<b.end_hour;
$$;

create function public.protect_schedule_config() returns trigger
language plpgsql security definer set search_path='' as $$
declare cfg jsonb:=new.schedule_config; p jsonb; previous_end date; first_date date; last_date date; b record; limit_people int;
begin
  if cfg is not null then
    if jsonb_typeof(cfg) is distinct from 'object' or length(cfg::text)>100000
      or jsonb_typeof(cfg->'overrides') is distinct from 'array' or jsonb_array_length(cfg->'overrides')>30 then
      raise exception 'Booking: Supply a valid weekly schedule and temporary overrides.'; end if;
    perform public.validate_schedule_blocks(cfg->'weekly');
    if (select count(distinct value->>'id') from jsonb_array_elements(cfg->'overrides'))<>jsonb_array_length(cfg->'overrides') then
      raise exception 'Booking: Temporary schedule identifiers must be unique.'; end if;
    for p in select value from jsonb_array_elements(cfg->'overrides') order by value->>'start_date' loop
      if coalesce(p->>'id','') !~ '^[a-zA-Z0-9_-]{1,64}$' or length(trim(coalesce(p->>'name',''))) not between 1 and 100
        or coalesce(p->>'start_date','') !~ '^\d{4}-\d{2}-\d{2}$' or coalesce(p->>'end_date','') !~ '^\d{4}-\d{2}-\d{2}$' then
        raise exception 'Booking: Name each temporary schedule and set its first and last dates.'; end if;
      first_date:=(p->>'start_date')::date; last_date:=(p->>'end_date')::date;
      if first_date<date '2000-01-01' or last_date>date '2100-12-31' or last_date<first_date then
        raise exception 'Booking: Check the temporary schedule dates.'; end if;
      if previous_end is not null and first_date<=previous_end then raise exception 'Booking: Temporary date ranges overlap.'; end if;
      previous_end:=last_date;
      perform public.validate_schedule_blocks(p->'blocks');
    end loop;
  end if;
  for b in select * from public.bookings where status in ('awaiting_payment','awaiting_verification','confirmed')
    and (status<>'awaiting_payment' or hold_expires_at>now())
    and (booking_date + (start_hour+duration)*interval '1 hour') at time zone 'Asia/Manila'>now() loop
    if b.booking_type='court' then
      if public.quote_schedule_total(to_jsonb(new),b.booking_date,b.start_hour,b.duration) is null then
        raise exception 'Booking: Schedule conflicts with reservation % on %. Resolve it before saving.',b.reference,b.booking_date; end if;
    else
      select s.capacity into limit_people from public.resolve_schedule_blocks(to_jsonb(new),b.booking_date) s
        where s.kind='open_play' and s.start_hour=b.start_hour and s.end_hour=b.start_hour+b.duration;
      if not found then raise exception 'Booking: Schedule conflicts with open-play reservation % on %. Resolve it before saving.',b.reference,b.booking_date; end if;
      if limit_people is not null and (select coalesce(sum(x.participant_count),0) from public.bookings x
        where x.booking_date=b.booking_date and x.booking_type='open_play' and x.start_hour=b.start_hour and x.duration=b.duration
          and x.status in ('awaiting_payment','awaiting_verification','confirmed')
          and (x.status<>'awaiting_payment' or x.hold_expires_at>now()))>limit_people then
        raise exception 'Booking: The player limit is lower than the passes already reserved on %.',b.booking_date; end if;
    end if;
  end loop;
  return new;
end;
$$;
create trigger protect_schedule_config before update on public.venue_settings
for each row when (new.schedule_config is distinct from old.schedule_config) execute function public.protect_schedule_config();

create function public.save_booking_schedule(p_config jsonb,p_expected jsonb default null) returns void
language plpgsql security definer set search_path='' as $$
declare current_config jsonb;
begin
  if not public.is_staff() then raise exception 'Booking: Staff access is required.'; end if;
  if p_config is null then raise exception 'Booking: Supply the complete schedule.'; end if;
  select schedule_config into current_config from public.venue_settings where id=true for update;
  if current_config is distinct from p_expected then raise exception 'Booking: Another staff member changed the schedule. Reload before saving.'; end if;
  update public.venue_settings set schedule_config=p_config where id=true;
end;
$$;

-- Keep legacy RPCs safe during rollout; configured schedules use their own checks.
create function public.uses_legacy_schedule() returns boolean
language sql stable security definer set search_path='' as $$ select schedule_config is null from public.venue_settings where id=true; $$;
drop trigger enforce_booking_schedule on public.bookings;
create trigger enforce_booking_schedule before insert or update on public.bookings
for each row when (public.uses_legacy_schedule()) execute function public.enforce_booking_schedule();
drop trigger protect_open_play_settings on public.venue_settings;
create trigger protect_open_play_settings before update on public.venue_settings
for each row when (new.schedule_config is null) execute function public.protect_open_play_settings();

create function public.enforce_configured_schedule() returns trigger
language plpgsql security definer set search_path='' as $$
declare v public.venue_settings%rowtype; s record; occupied int; base numeric;
begin
  if new.status not in ('awaiting_payment','awaiting_verification','confirmed','blocked') then return new; end if;
  if tg_op='UPDATE' then
    if old.status in ('awaiting_payment','awaiting_verification','confirmed','blocked')
      and row(new.booking_type,new.court_id,new.booking_date,new.start_hour,new.duration,new.participant_count)
        is not distinct from row(old.booking_type,old.court_id,old.booking_date,old.start_hour,old.duration,old.participant_count) then return new; end if;
  end if;
  select * into v from public.venue_settings where id=true for share;
  perform pg_advisory_xact_lock(hashtextextended('rally-session:'||new.booking_date::text,0));
  if new.booking_type='court' then
    if new.status='blocked' then
      if exists(select 1 from public.bookings b where b.booking_date=new.booking_date and b.booking_type='open_play' and b.id<>new.id
        and b.status in ('awaiting_payment','awaiting_verification','confirmed') and (b.status<>'awaiting_payment' or b.hold_expires_at>now())
        and new.start_hour<b.start_hour+b.duration and new.start_hour+new.duration>b.start_hour) then
        raise exception 'Booking: Resolve open-play passes before blocking their session.'; end if;
      base:=0;
    else
      base:=public.quote_schedule_total(to_jsonb(v),new.booking_date,new.start_hour,new.duration);
      if base is null then raise exception 'Booking: This time is closed or reserved for open play. Choose an available private-booking time.'; end if;
    end if;
  else
    select * into s from public.resolve_schedule_blocks(to_jsonb(v),new.booking_date)
      where kind='open_play' and start_hour=new.start_hour and end_hour=new.start_hour+new.duration;
    if not found then raise exception 'Booking: Choose an available open-play session.'; end if;
    if exists(select 1 from public.bookings b where b.booking_date=new.booking_date and b.booking_type='court' and b.id<>new.id
      and b.status in ('awaiting_payment','awaiting_verification','confirmed','blocked') and (b.status<>'awaiting_payment' or b.hold_expires_at>now())
      and b.start_hour<s.end_hour and b.start_hour+b.duration>s.start_hour) then
      raise exception 'Booking: Open play is unavailable because a court is reserved or blocked.'; end if;
    select coalesce(sum(b.participant_count),0)::int into occupied from public.bookings b where b.booking_date=new.booking_date
      and b.booking_type='open_play' and b.id<>new.id and b.start_hour=s.start_hour and b.start_hour+b.duration=s.end_hour
      and b.status in ('awaiting_payment','awaiting_verification','confirmed') and (b.status<>'awaiting_payment' or b.hold_expires_at>now());
    if s.capacity is not null and occupied+new.participant_count>s.capacity then raise exception 'Booking: There are not enough open-play places left in this session.'; end if;
    base:=s.rate*new.participant_count;
  end if;
  if tg_op='INSERT' then new.total_amount:=base+new.equipment_amount; end if;
  return new;
end;
$$;
create trigger enforce_configured_schedule before insert or update on public.bookings
for each row when (not public.uses_legacy_schedule()) execute function public.enforce_configured_schedule();

create function public.get_booking_schedule(p_date date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v public.venue_settings%rowtype; blocks jsonb; period jsonb;
begin
  if p_date is null or p_date<(now() at time zone 'Asia/Manila')::date or p_date>(now() at time zone 'Asia/Manila')::date+30 then
    raise exception 'Booking: Choose a date within the next 30 days.'; end if;
  select * into v from public.venue_settings where id=true;
  select coalesce(jsonb_agg(jsonb_build_object('id',s.block_id,'days',jsonb_build_array(extract(isodow from p_date)::int),
    'start',s.start_hour,'end',s.end_hour,'kind',s.kind,'rate',s.rate,'capacity',s.capacity) order by s.start_hour),'[]'::jsonb)
    into blocks from public.resolve_schedule_blocks(to_jsonb(v),p_date) s;
  select value-'blocks' into period from jsonb_array_elements(v.schedule_config->'overrides')
    where p_date between (value->>'start_date')::date and (value->>'end_date')::date limit 1;
  return jsonb_build_object('blocks',blocks,'override',period);
end;
$$;

create function public.get_open_play_sessions(p_date date)
returns table(enabled boolean,start_hour int,end_hour int,price numeric,capacity int,players int,remaining int,conflict boolean)
language plpgsql security definer set search_path='' as $$
declare v public.venue_settings%rowtype;
begin
  if p_date is null or p_date<(now() at time zone 'Asia/Manila')::date or p_date>(now() at time zone 'Asia/Manila')::date+30 then
    raise exception 'Booking: Choose a date within the next 30 days.'; end if;
  perform public.expire_unpaid_holds();
  select * into v from public.venue_settings where id=true;
  return query select v.booking_enabled,s.start_hour,s.end_hour,s.rate,s.capacity,c.occupied,
    case when s.capacity is null then null::int else greatest(0,s.capacity-c.occupied) end,
    exists(select 1 from public.bookings b where b.booking_date=p_date and b.booking_type='court'
      and b.status in ('awaiting_payment','awaiting_verification','confirmed','blocked')
      and b.start_hour<s.end_hour and b.start_hour+b.duration>s.start_hour)
    from public.resolve_schedule_blocks(to_jsonb(v),p_date) s cross join lateral (
      select coalesce(sum(b.participant_count),0)::int occupied from public.bookings b where b.booking_date=p_date and b.booking_type='open_play'
        and b.start_hour=s.start_hour and b.start_hour+b.duration=s.end_hour and b.status in ('awaiting_payment','awaiting_verification','confirmed')
    ) c where s.kind='open_play' order by s.start_hour;
end;
$$;

create function public.reserve_scheduled_booking(p_kind text,p_date date,p_name text,p_phone text,
  p_court int default null,p_start int default null,p_duration int default 1,p_people int default 1,
  p_rental boolean default false,p_walk_in boolean default false,p_blocked boolean default false,
  p_method text default 'cash',p_notes text default '',p_payment_option text default 'full')
returns uuid language plpgsql security definer set search_path='' as $$
declare v public.venue_settings%rowtype; uid uuid:=auth.uid(); booking_id uuid; base numeric; session_end int; end_at timestamptz;
begin
  if uid is null then raise exception 'Booking: Please sign in before reserving.'; end if;
  if p_kind is null or p_kind not in ('court','open_play') or p_walk_in is null or p_blocked is null or p_rental is null
    or p_payment_option is null or p_payment_option not in ('full','reservation_fee') or (p_blocked and (not p_walk_in or p_kind<>'court' or p_rental or p_payment_option<>'full')) then
    raise exception 'Booking: Choose a valid reservation and payment option.'; end if;
  if p_walk_in and not public.is_staff() then raise exception 'Booking: Staff access is required.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text,0));
  perform public.expire_unpaid_holds();
  select * into v from public.venue_settings where id=true for share;
  if not p_walk_in and not v.booking_enabled then raise exception 'Booking: Reservations are not open yet.'; end if;
  if p_date is null or p_date<(now() at time zone 'Asia/Manila')::date or p_date>(now() at time zone 'Asia/Manila')::date+30 then
    raise exception 'Booking: Choose a date within the next 30 days.'; end if;
  if p_name is null or length(trim(p_name)) not between 2 and 100 or (not p_blocked and (p_phone is null or p_phone !~ '^(\+63|0)9[0-9]{9}$')) then
    raise exception 'Booking: Enter a name and valid Philippine mobile number.'; end if;
  if not p_walk_in and (select count(*) from public.bookings where user_id=uid and status in ('awaiting_payment','awaiting_verification'))>=2 then
    raise exception 'Booking: You already have two pending reservations. Complete or cancel one first.'; end if;
  if p_start is null or p_start not between 0 and 23 then raise exception 'Booking: Choose a start time.'; end if;
  if p_kind='open_play' then
    if p_people is null or p_people not between 1 and 20 then raise exception 'Booking: Choose between 1 and 20 players per reservation.'; end if;
    select s.rate*p_people,s.end_hour into base,session_end from public.resolve_schedule_blocks(to_jsonb(v),p_date) s where s.kind='open_play' and s.start_hour=p_start;
    if not found then raise exception 'Booking: Choose an available open-play session.'; end if;
    p_duration:=session_end-p_start; p_court:=null;
  else
    if p_court is null or p_court not in (1,2) or p_duration is null or p_duration not between 1 and 4 or p_start+p_duration>24 then
      raise exception 'Booking: Choose a valid court and duration.'; end if;
    base:=case when p_blocked then 0 else public.quote_schedule_total(to_jsonb(v),p_date,p_start,p_duration) end;
    if base is null then raise exception 'Booking: Choose an available private-booking time.'; end if;
    p_people:=1;
  end if;
  end_at:=(p_date+(p_start+p_duration)*interval '1 hour') at time zone 'Asia/Manila';
  if (p_kind='court' and (p_date+p_start*interval '1 hour') at time zone 'Asia/Manila'<=now()) or end_at<=now() then
    raise exception 'Booking: Choose a future court time or an open-play session that has not ended.'; end if;
  insert into public.bookings(user_id,court_id,booking_type,booking_date,start_hour,duration,participant_count,
    total_amount,payment_option,status,hold_expires_at,customer_name,customer_phone,equipment_rental,equipment_amount)
  values(case when p_walk_in then null else uid end,p_court,p_kind,p_date,p_start,p_duration,p_people,
    base+case when p_rental then v.equipment_rental_price else 0 end,p_payment_option,
    case when p_blocked then 'blocked' when p_walk_in then 'confirmed' else 'awaiting_payment' end,
    case when p_walk_in then null else least(now()+make_interval(mins=>v.hold_minutes),end_at) end,
    trim(p_name),coalesce(p_phone,''),p_rental,case when p_rental then v.equipment_rental_price else 0 end)
  returning id into booking_id;
  if p_walk_in and not p_blocked then perform public.staff_save_booking_finance(booking_id,p_method,p_notes); end if;
  return booking_id;
end;
$$;

revoke all on function public.validate_schedule_blocks(jsonb),public.resolve_schedule_blocks(jsonb,date),public.quote_schedule_total(jsonb,date,int,int),
  public.protect_schedule_config(),public.uses_legacy_schedule(),public.enforce_configured_schedule(),
  public.save_booking_schedule(jsonb,jsonb),public.get_booking_schedule(date),public.get_open_play_sessions(date),
  public.reserve_scheduled_booking(text,date,text,text,int,int,int,int,boolean,boolean,boolean,text,text,text) from public,anon,authenticated;
grant execute on function public.save_booking_schedule(jsonb,jsonb),public.reserve_scheduled_booking(text,date,text,text,int,int,int,int,boolean,boolean,boolean,text,text,text) to authenticated;
grant execute on function public.get_booking_schedule(date),public.get_open_play_sessions(date) to anon,authenticated;
notify pgrst,'reload schema';
commit;
