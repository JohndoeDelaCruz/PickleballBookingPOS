-- Apply after 202610230001_initial.sql. Existing booking totals are preserved.
begin;
set local search_path = public, extensions;

alter table public.venue_settings
  add column evening_hourly_rate numeric(10,2) not null default 150 check (evening_hourly_rate > 0 and evening_hourly_rate <= 100000),
  add column evening_start_hour smallint not null default 16 check (evening_start_hour between 1 and 23),
  add column equipment_rental_price numeric(10,2) not null default 30 check (equipment_rental_price between 0 and 100000);

-- Confirmed Rally rates: 6 AM–4 PM at PHP 100/hour, 4 PM–10 PM at PHP 150/hour.
-- The optional PHP 30 package (1 paddle + 2 balls) is not part of court totals.
update public.venue_settings
set hourly_rate = 100, opening_hour = 6, closing_hour = 22;
alter table public.venue_settings
  add constraint evening_start_within_opening_hours
  check (opening_hour is null or closing_hour is null or (evening_start_hour > opening_hour and evening_start_hour < closing_hour));

create function public.quote_court_total(p_start int, p_duration int)
returns numeric language plpgsql stable security definer set search_path = '' as $$
declare v public.venue_settings%rowtype; total numeric;
begin
  select * into v from public.venue_settings where id = true;
  if v.hourly_rate is null or v.opening_hour is null or v.closing_hour is null
    or p_start is null or p_duration is null or p_duration not between 1 and 4
    or p_start < v.opening_hour or p_start + p_duration > v.closing_hour then
    raise exception 'Booking: Choose a valid time within opening hours.';
  end if;
  select sum(case when h >= v.evening_start_hour then v.evening_hourly_rate else v.hourly_rate end)
  into total from generate_series(p_start, p_start + p_duration - 1) as hours(h);
  return total;
end;
$$;
revoke all on function public.quote_court_total(int,int) from public;
grant execute on function public.quote_court_total(int,int) to authenticated;

create or replace function public.create_booking(p_court int, p_date date, p_start int, p_duration int, p_name text, p_phone text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v public.venue_settings%rowtype; booking_id uuid; uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Booking: Please sign in to reserve a court.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text,0));
  perform public.expire_unpaid_holds();
  select * into v from public.venue_settings where id = true for share;
  if not v.booking_enabled then raise exception 'Booking: Reservations are not open yet.'; end if;
  if p_court is null or p_court not in (1,2) or p_duration is null or p_duration not between 1 and 4 or p_start is null or p_start < v.opening_hour or p_start + p_duration > v.closing_hour then
    raise exception 'Booking: Choose a valid court and a time within opening hours.';
  end if;
  if p_date is null or p_date < (now() at time zone 'Asia/Manila')::date or p_date > (now() at time zone 'Asia/Manila')::date + 30 or (p_date + make_time(p_start,0,0)) at time zone 'Asia/Manila' <= now() then
    raise exception 'Booking: Choose a future time within the next 30 days.';
  end if;
  if p_name is null or length(trim(p_name)) not between 2 and 100 or p_phone is null or p_phone !~ '^(\+63|0)9[0-9]{9}$' then raise exception 'Booking: Enter your name and a valid Philippine mobile number.'; end if;
  if (select count(*) from public.bookings where user_id = uid and status in ('awaiting_payment','awaiting_verification')) >= 2 then
    raise exception 'Booking: You already have two pending reservations. Complete or cancel one first.';
  end if;
  insert into public.bookings (user_id,court_id,booking_date,start_hour,duration,total_amount,hold_expires_at,customer_name,customer_phone)
    values (uid,p_court,p_date,p_start,p_duration,public.quote_court_total(p_start,p_duration),now() + make_interval(mins => v.hold_minutes),trim(p_name),p_phone)
    returning id into booking_id;
  return booking_id;
end;
$$;
revoke all on function public.create_booking(int,date,int,int,text,text) from public;
grant execute on function public.create_booking(int,date,int,int,text,text) to authenticated;

create or replace function public.staff_create_booking(p_court int,p_date date,p_start int,p_duration int,p_name text,p_phone text,p_blocked boolean default false)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v public.venue_settings%rowtype; booking_id uuid;
begin
  if not public.is_staff() then raise exception 'Booking: Staff access is required.'; end if;
  perform public.expire_unpaid_holds();
  select * into v from public.venue_settings where id = true for share;
  if p_court is null or p_court not in (1,2) or p_duration is null or p_duration not between 1 and 4 or p_start is null or p_start < coalesce(v.opening_hour,0) or p_start + p_duration > coalesce(v.closing_hour,24) then raise exception 'Booking: Choose a valid time within opening hours.'; end if;
  if p_date is null or p_date < (now() at time zone 'Asia/Manila')::date or p_date > (now() at time zone 'Asia/Manila')::date + 30 or (p_date + make_time(p_start,0,0)) at time zone 'Asia/Manila' <= now() then raise exception 'Booking: Choose a future time within the next 30 days.'; end if;
  if p_name is null or length(trim(p_name)) not between 2 and 100 then raise exception 'Booking: Enter a customer name or block reason.'; end if;
  if not p_blocked and (v.hourly_rate is null or p_phone is null or p_phone !~ '^(\+63|0)9[0-9]{9}$') then raise exception 'Booking: Set your hourly rate and enter a valid customer mobile number.'; end if;
  insert into public.bookings (court_id,booking_date,start_hour,duration,total_amount,status,customer_name,customer_phone)
  values (p_court,p_date,p_start,p_duration,case when p_blocked then 0 else public.quote_court_total(p_start,p_duration) end,case when p_blocked then 'blocked' else 'confirmed' end,trim(p_name),coalesce(p_phone,'')) returning id into booking_id;
  return booking_id;
end;
$$;
revoke all on function public.staff_create_booking(int,date,int,int,text,text,boolean) from public;
grant execute on function public.staff_create_booking(int,date,int,int,text,text,boolean) to authenticated;

notify pgrst, 'reload schema';
commit;
