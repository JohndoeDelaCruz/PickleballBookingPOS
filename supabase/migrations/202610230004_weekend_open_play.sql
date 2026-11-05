-- Apply once after 202610230003_evening_rate_200.sql.
-- Existing reservations and payment totals are preserved.
begin;

alter table public.venue_settings
  add column open_play_enabled boolean not null default true,
  add column open_play_start_hour smallint not null default 9,
  add column open_play_end_hour smallint not null default 16,
  add column weekend_court_end_hour smallint not null default 9,
  add column open_play_price numeric(10,2) not null default 50 check (open_play_price > 0 and open_play_price <= 100000),
  add column open_play_capacity int check (open_play_capacity > 0 and open_play_capacity <= 100000),
  add constraint open_play_valid_hours check (
    open_play_start_hour between 0 and 23 and open_play_end_hour between 1 and 24
    and open_play_end_hour > open_play_start_hour
    and weekend_court_end_hour between 0 and open_play_start_hour
    and (not open_play_enabled or (opening_hour is not null and closing_hour is not null
      and weekend_court_end_hour >= opening_hour and open_play_end_hour <= closing_hour))
  );

alter table public.bookings
  alter column court_id drop not null,
  add column booking_type text not null default 'court' check (booking_type in ('court','open_play')),
  add column participant_count smallint not null default 1 check (participant_count between 1 and 20),
  drop constraint bookings_check,
  add constraint booking_kind_valid check (
    (booking_type = 'court' and court_id is not null and duration between 1 and 4 and participant_count = 1)
    or (booking_type = 'open_play' and court_id is null and duration between 1 and 24 and status <> 'blocked')
  ),
  add constraint booking_end_within_day check (start_hour + duration <= 24);

create index bookings_open_play_day on public.bookings(booking_date) where booking_type = 'open_play';

-- These checks also protect the existing online and staff walk-in RPCs.
-- A date lock serializes new passes and maintenance blocks; settings row locks
-- keep schedule/capacity changes consistent with reservations being created.
create function public.enforce_booking_schedule() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v public.venue_settings%rowtype; occupied int;
begin
  if new.status not in ('awaiting_payment','awaiting_verification','confirmed','blocked') then return new; end if;
  if tg_op = 'UPDATE' then
    if old.status in ('awaiting_payment','awaiting_verification','confirmed','blocked')
      and row(new.booking_type,new.court_id,new.booking_date,new.start_hour,new.duration,new.participant_count)
        is not distinct from row(old.booking_type,old.court_id,old.booking_date,old.start_hour,old.duration,old.participant_count)
      then return new;
    end if;
  end if;
  select * into v from public.venue_settings where id = true for share;
  perform pg_advisory_xact_lock(hashtextextended('rally-session:' || new.booking_date::text,0));
  if new.booking_type = 'court' then
    if new.status = 'blocked' then
      if exists(select 1 from public.bookings b where b.booking_date = new.booking_date
        and b.booking_type = 'open_play' and b.id <> new.id
        and b.status in ('awaiting_payment','awaiting_verification','confirmed')
        and (b.status <> 'awaiting_payment' or b.hold_expires_at > now())
        and new.start_hour < b.start_hour + b.duration and new.start_hour + new.duration > b.start_hour)
      then raise exception 'Booking: Cancel the open-play passes for this date before blocking their session.'; end if;
    elsif v.open_play_enabled and extract(isodow from new.booking_date) in (6,7)
      and new.start_hour < v.open_play_end_hour and new.start_hour + new.duration > v.weekend_court_end_hour then
      raise exception 'Booking: This weekend time is reserved for open play. Choose an hourly slot before open play or after it ends.';
    end if;
  else
    if not v.open_play_enabled or extract(isodow from new.booking_date) not in (6,7)
      or new.start_hour <> v.open_play_start_hour or new.start_hour + new.duration <> v.open_play_end_hour
    then raise exception 'Booking: Choose an available Saturday or Sunday open-play session.'; end if;
    if exists(select 1 from public.bookings b where b.booking_date = new.booking_date
      and b.booking_type = 'court' and b.id <> new.id
      and b.status in ('awaiting_payment','awaiting_verification','confirmed','blocked')
      and (b.status <> 'awaiting_payment' or b.hold_expires_at > now())
      and b.start_hour < v.open_play_end_hour and b.start_hour + b.duration > v.open_play_start_hour)
    then raise exception 'Booking: Open play is unavailable on this date because a court is reserved or blocked.'; end if;
    select coalesce(sum(b.participant_count),0)::int into occupied from public.bookings b
      where b.booking_date = new.booking_date and b.booking_type = 'open_play' and b.id <> new.id
      and b.status in ('awaiting_payment','awaiting_verification','confirmed')
      and (b.status <> 'awaiting_payment' or b.hold_expires_at > now());
    if v.open_play_capacity is not null and occupied + new.participant_count > v.open_play_capacity
      then raise exception 'Booking: There are not enough open-play places left. Choose fewer players or another date.'; end if;
  end if;
  return new;
end;
$$;
revoke all on function public.enforce_booking_schedule() from public,anon,authenticated;
create trigger enforce_booking_schedule before insert or update on public.bookings
for each row execute function public.enforce_booking_schedule();

-- Protect paid and held passes if staff changes the schedule or adds a cap later.
create function public.protect_open_play_settings() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if row(new.open_play_enabled,new.open_play_start_hour,new.open_play_end_hour,new.weekend_court_end_hour,new.opening_hour,new.closing_hour)
    is distinct from row(old.open_play_enabled,old.open_play_start_hour,old.open_play_end_hour,old.weekend_court_end_hour,old.opening_hour,old.closing_hour)
    and exists(select 1 from public.bookings b where b.booking_type = 'open_play'
      and (b.booking_date + make_time(b.start_hour + b.duration,0,0)) at time zone 'Asia/Manila' > now()
      and b.status in ('awaiting_payment','awaiting_verification','confirmed')
      and (b.status <> 'awaiting_payment' or b.hold_expires_at > now()))
  then raise exception 'Booking: Existing open-play passes use this schedule. Cancel those passes before changing session hours.'; end if;
  if new.open_play_capacity is not null and exists(
    select 1 from public.bookings b where b.booking_type = 'open_play'
      and b.booking_date >= (now() at time zone 'Asia/Manila')::date
      and b.status in ('awaiting_payment','awaiting_verification','confirmed')
      and (b.status <> 'awaiting_payment' or b.hold_expires_at > now())
    group by b.booking_date having sum(b.participant_count) > new.open_play_capacity)
  then raise exception 'Booking: The new player limit is lower than the passes already reserved for a session.'; end if;
  return new;
end;
$$;
revoke all on function public.protect_open_play_settings() from public,anon,authenticated;
create trigger protect_open_play_settings before update on public.venue_settings
for each row execute function public.protect_open_play_settings();

create function public.get_open_play_availability(p_date date)
returns table(enabled boolean,start_hour smallint,end_hour smallint,price numeric,capacity int,players int,remaining int,conflict boolean)
language plpgsql security definer set search_path = '' as $$
declare v public.venue_settings%rowtype; occupied int;
begin
  if p_date is null or p_date < (now() at time zone 'Asia/Manila')::date or p_date > (now() at time zone 'Asia/Manila')::date + 30
    then raise exception 'Booking: Choose a date within the next 30 days.'; end if;
  perform public.expire_unpaid_holds();
  select * into v from public.venue_settings where id = true;
  select coalesce(sum(b.participant_count),0)::int into occupied from public.bookings b
    where b.booking_date = p_date and b.booking_type = 'open_play'
    and b.status in ('awaiting_payment','awaiting_verification','confirmed');
  return query select v.open_play_enabled and extract(isodow from p_date) in (6,7),
    v.open_play_start_hour,v.open_play_end_hour,v.open_play_price,v.open_play_capacity,occupied,
    case when v.open_play_capacity is null then null::int else greatest(0,v.open_play_capacity-occupied) end,
    exists(select 1 from public.bookings b where b.booking_date = p_date and b.booking_type = 'court'
      and b.status in ('awaiting_payment','awaiting_verification','confirmed','blocked')
      and b.start_hour < v.open_play_end_hour and b.start_hour + b.duration > v.open_play_start_hour);
end;
$$;
revoke all on function public.get_open_play_availability(date) from public;
grant execute on function public.get_open_play_availability(date) to anon,authenticated;

create function public.create_open_play_booking(p_date date,p_people int,p_name text,p_phone text,p_walk_in boolean default false)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v public.venue_settings%rowtype; booking_id uuid; uid uuid := auth.uid(); session_end timestamptz;
begin
  if uid is null then raise exception 'Booking: Please sign in to reserve open-play passes.'; end if;
  if p_walk_in is null then raise exception 'Booking: Choose a valid reservation type.'; end if;
  if p_walk_in and not public.is_staff() then raise exception 'Booking: Staff access is required.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text,0));
  perform public.expire_unpaid_holds();
  select * into v from public.venue_settings where id = true for share;
  if not p_walk_in and not v.booking_enabled then raise exception 'Booking: Reservations are not open yet.'; end if;
  if p_date is null or p_date < (now() at time zone 'Asia/Manila')::date or p_date > (now() at time zone 'Asia/Manila')::date + 30
    then raise exception 'Booking: Choose a date within the next 30 days.'; end if;
  session_end := (p_date + make_time(v.open_play_end_hour,0,0)) at time zone 'Asia/Manila';
  if session_end <= now() then raise exception 'Booking: This open-play session has ended.'; end if;
  if p_people is null or p_people not between 1 and 20 then raise exception 'Booking: Choose between 1 and 20 players per reservation.'; end if;
  if p_name is null or length(trim(p_name)) not between 2 and 100 or p_phone is null or p_phone !~ '^(\+63|0)9[0-9]{9}$'
    then raise exception 'Booking: Enter your name and a valid Philippine mobile number.'; end if;
  if not p_walk_in and (select count(*) from public.bookings where user_id = uid and status in ('awaiting_payment','awaiting_verification')) >= 2
    then raise exception 'Booking: You already have two pending reservations. Complete or cancel one first.'; end if;
  insert into public.bookings(user_id,court_id,booking_type,participant_count,booking_date,start_hour,duration,total_amount,status,hold_expires_at,customer_name,customer_phone)
  values(case when p_walk_in then null else uid end,null,'open_play',p_people,p_date,v.open_play_start_hour,v.open_play_end_hour-v.open_play_start_hour,
    v.open_play_price*p_people,case when p_walk_in then 'confirmed' else 'awaiting_payment' end,
    case when p_walk_in then null else least(now()+make_interval(mins=>v.hold_minutes),session_end) end,trim(p_name),p_phone)
  returning id into booking_id;
  return booking_id;
end;
$$;
revoke all on function public.create_open_play_booking(date,int,text,text,boolean) from public;
grant execute on function public.create_open_play_booking(date,int,text,text,boolean) to authenticated;

notify pgrst, 'reload schema';
commit;
