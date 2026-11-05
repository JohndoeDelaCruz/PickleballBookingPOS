-- FRESH DATABASE ONLY. Run once in this client project. Never run against Ascent.
-- Migration: 202610230001_initial.sql
-- Apply once in the Supabase SQL Editor. No service-role key is used by the app.
begin;
set local search_path = public, extensions;
create extension if not exists btree_gist with schema extensions;

create table public.staff_members (
  user_id uuid primary key references auth.users(id) on delete cascade
);
alter table public.staff_members enable row level security;
create policy "Staff can see their membership" on public.staff_members for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.staff_members from anon, authenticated;
grant select on public.staff_members to authenticated;

create function public.is_staff() returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.staff_members where user_id = (select auth.uid()));
$$;
revoke all on function public.is_staff() from public;
grant execute on function public.is_staff() to authenticated;

create table public.venue_settings (
  id boolean primary key default true check (id = true),
  name text not null default 'Rally Club',
  tagline text not null default 'Good games. Great company. Higher together.',
  address text not null default '', city text not null default '',
  phone text not null default '', email text not null default '', facebook_url text not null default '',
  hourly_rate numeric(10,2) check (hourly_rate > 0 and hourly_rate <= 100000),
  opening_hour smallint check (opening_hour between 0 and 23),
  closing_hour smallint check (closing_hour between 1 and 24),
  hold_minutes smallint not null default 30 check (hold_minutes between 15 and 120),
  booking_enabled boolean not null default false,
  gcash_name text not null default '', gcash_number text not null default '', gcash_qr_url text not null default '',
  cancellation_policy text not null default 'Cancellation and refund details will be announced before reservations open.',
  check ((opening_hour is null and closing_hour is null) or (opening_hour is not null and closing_hour is not null and closing_hour > opening_hour)),
  check (not booking_enabled or (hourly_rate is not null and opening_hour is not null and closing_hour is not null and length(trim(gcash_name)) > 0 and gcash_qr_url like 'https://%'))
);
insert into public.venue_settings (id) values (true);
alter table public.venue_settings enable row level security;
revoke all on public.venue_settings from anon, authenticated;
grant select on public.venue_settings to anon, authenticated;
grant update on public.venue_settings to authenticated;
create policy "Public venue details" on public.venue_settings for select to anon, authenticated using (true);
create policy "Staff edit settings" on public.venue_settings for update to authenticated using ((select public.is_staff())) with check ((select public.is_staff()));

create table public.courts (
  id smallint primary key check (id in (1,2)),
  name text not null
);
insert into public.courts values (1,'Court 1'), (2,'Court 2');
alter table public.courts enable row level security;
revoke all on public.courts from anon, authenticated;
grant select on public.courts to anon, authenticated;
create policy "Public court names" on public.courts for select to anon, authenticated using (true);

create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique default ('AP-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,10))),
  user_id uuid references auth.users(id) on delete set null,
  court_id smallint not null references public.courts(id),
  booking_date date not null,
  start_hour smallint not null check (start_hour between 0 and 23),
  duration smallint not null check (duration between 1 and 4 and start_hour + duration <= 24),
  total_amount numeric(10,2) not null check (total_amount >= 0),
  status text not null default 'awaiting_payment' check (status in ('awaiting_payment','awaiting_verification','confirmed','cancelled','expired','blocked')),
  hold_expires_at timestamptz,
  payment_reference text,
  customer_name text not null check (length(customer_name) between 2 and 100),
  customer_phone text not null,
  notes text,
  created_at timestamptz not null default now(),
  constraint no_overlapping_court_bookings exclude using gist (
    court_id with =, booking_date with =, (int4range(start_hour::int,start_hour::int + duration::int,'[)')) with &&
  ) where (status in ('awaiting_payment','awaiting_verification','confirmed','blocked'))
);
create index bookings_user_date on public.bookings (user_id, booking_date);
create index bookings_calendar on public.bookings (booking_date, court_id);
create unique index payment_reference_once on public.bookings (lower(regexp_replace(payment_reference,'[^a-zA-Z0-9]','','g'))) where payment_reference is not null;
alter table public.bookings enable row level security;
revoke all on public.bookings from anon, authenticated;
grant select on public.bookings to authenticated;
create policy "Players see own bookings; staff see all" on public.bookings for select to authenticated using (user_id = (select auth.uid()) or (select public.is_staff()));

-- Expiration is enforced on the database clock whenever availability is read or a booking is created.
-- Submitted payments remain held for staff review; they are never silently expired.
create function public.expire_unpaid_holds() returns void language sql security definer set search_path = '' as $$
  update public.bookings set status = 'expired' where status = 'awaiting_payment' and hold_expires_at <= now();
$$;
revoke all on function public.expire_unpaid_holds() from public;
grant execute on function public.expire_unpaid_holds() to anon, authenticated;

create function public.get_availability(p_date date)
returns table (court_id smallint, start_hour smallint, duration smallint, status text)
language plpgsql security definer set search_path = '' as $$
begin
  if p_date < (now() at time zone 'Asia/Manila')::date or p_date > (now() at time zone 'Asia/Manila')::date + 30 then
    raise exception 'Booking: Choose a date within the next 30 days.';
  end if;
  perform public.expire_unpaid_holds();
  return query select b.court_id, b.start_hour, b.duration, b.status from public.bookings b
    where b.booking_date = p_date and b.status in ('awaiting_payment','awaiting_verification','confirmed','blocked');
end;
$$;
revoke all on function public.get_availability(date) from public;
grant execute on function public.get_availability(date) to anon, authenticated;

create function public.create_booking(p_court int, p_date date, p_start int, p_duration int, p_name text, p_phone text)
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
    values (uid,p_court,p_date,p_start,p_duration,v.hourly_rate * p_duration,now() + make_interval(mins => v.hold_minutes),trim(p_name),p_phone)
    returning id into booking_id;
  return booking_id;
end;
$$;
revoke all on function public.create_booking(int,date,int,int,text,text) from public;
grant execute on function public.create_booking(int,date,int,int,text,text) to authenticated;

create function public.submit_payment_reference(p_booking uuid, p_reference text)
returns void language plpgsql security definer set search_path = '' as $$
declare b public.bookings%rowtype;
begin
  select * into b from public.bookings where id = p_booking for update;
  if b.id is null or b.user_id is distinct from auth.uid() or auth.uid() is null then raise exception 'Booking: Reservation not found.'; end if;
  if b.status <> 'awaiting_payment' then raise exception 'Booking: This reservation is no longer awaiting payment.'; end if;
  if b.hold_expires_at <= now() then raise exception 'Booking: Your hold expired. Please contact the venue if you already paid.'; end if;
  if p_reference is null or p_reference !~ '^[a-zA-Z0-9 -]{6,40}$' then raise exception 'Booking: Enter a valid GCash reference number.'; end if;
  update public.bookings set payment_reference = trim(p_reference), status = 'awaiting_verification' where id = p_booking;
exception when unique_violation then raise exception 'Booking: This payment reference has already been submitted. Please check it or contact the venue.';
end;
$$;
revoke all on function public.submit_payment_reference(uuid,text) from public;
grant execute on function public.submit_payment_reference(uuid,text) to authenticated;

create function public.cancel_booking(p_booking uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.bookings set status = 'cancelled' where id = p_booking and user_id = auth.uid() and status = 'awaiting_payment';
  if not found then raise exception 'Booking: Only unpaid reservations can be cancelled here. Contact the venue about a paid or confirmed booking.'; end if;
end;
$$;
revoke all on function public.cancel_booking(uuid) from public;
grant execute on function public.cancel_booking(uuid) to authenticated;

create function public.staff_update_booking(p_booking uuid, p_status text)
returns void language plpgsql security definer set search_path = '' as $$
declare b public.bookings%rowtype;
begin
  if not public.is_staff() then raise exception 'Booking: Staff access is required.'; end if;
  if p_status not in ('confirmed','cancelled') then raise exception 'Booking: Invalid status.'; end if;
  perform public.expire_unpaid_holds();
  select * into b from public.bookings where id = p_booking for update;
  if b.id is null then raise exception 'Booking: Reservation not found.'; end if;
  if p_status = 'confirmed' and b.status not in ('awaiting_payment','awaiting_verification') then raise exception 'Booking: Only active pending reservations can be confirmed.'; end if;
  if p_status = 'cancelled' and b.status not in ('awaiting_payment','awaiting_verification','confirmed','blocked') then raise exception 'Booking: This reservation is already closed.'; end if;
  update public.bookings set status = p_status where id = p_booking;
end;
$$;
revoke all on function public.staff_update_booking(uuid,text) from public;
grant execute on function public.staff_update_booking(uuid,text) to authenticated;

create function public.staff_create_booking(p_court int,p_date date,p_start int,p_duration int,p_name text,p_phone text,p_blocked boolean default false)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v public.venue_settings%rowtype; booking_id uuid;
begin
  if not public.is_staff() then raise exception 'Booking: Staff access is required.'; end if;
  perform public.expire_unpaid_holds();
  select * into v from public.venue_settings where id = true;
  if p_court is null or p_court not in (1,2) or p_duration is null or p_duration not between 1 and 4 or p_start is null or p_start < coalesce(v.opening_hour,0) or p_start + p_duration > coalesce(v.closing_hour,24) then raise exception 'Booking: Choose a valid time within opening hours.'; end if;
  if p_date is null or p_date < (now() at time zone 'Asia/Manila')::date or p_date > (now() at time zone 'Asia/Manila')::date + 30 or (p_date + make_time(p_start,0,0)) at time zone 'Asia/Manila' <= now() then raise exception 'Booking: Choose a future time within the next 30 days.'; end if;
  if p_name is null or length(trim(p_name)) not between 2 and 100 then raise exception 'Booking: Enter a customer name or block reason.'; end if;
  if not p_blocked and (v.hourly_rate is null or p_phone is null or p_phone !~ '^(\+63|0)9[0-9]{9}$') then raise exception 'Booking: Set your hourly rate and enter a valid customer mobile number.'; end if;
  insert into public.bookings (court_id,booking_date,start_hour,duration,total_amount,status,customer_name,customer_phone)
  values (p_court,p_date,p_start,p_duration,case when p_blocked then 0 else v.hourly_rate * p_duration end,case when p_blocked then 'blocked' else 'confirmed' end,trim(p_name),coalesce(p_phone,'')) returning id into booking_id;
  return booking_id;
end;
$$;
revoke all on function public.staff_create_booking(int,date,int,int,text,text,boolean) from public;
grant execute on function public.staff_create_booking(int,date,int,int,text,text,boolean) to authenticated;

-- Public QR assets, with writes restricted to verified staff membership.
insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
values ('venue-assets','venue-assets',true,2097152,array['image/png','image/jpeg','image/webp']);
create policy "Staff upload venue QR" on storage.objects for insert to authenticated with check (bucket_id = 'venue-assets' and (select public.is_staff()));
create policy "Staff replace venue QR" on storage.objects for update to authenticated using (bucket_id = 'venue-assets' and (select public.is_staff())) with check (bucket_id = 'venue-assets' and (select public.is_staff()));
create policy "Public venue images" on storage.objects for select to public using (bucket_id = 'venue-assets');

notify pgrst, 'reload schema';
commit;


-- Migration: 202610230002_time_based_rates.sql
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


-- Migration: 202610230003_evening_rate_200.sql
-- Apply after 202610230002_time_based_rates.sql.
-- Update the original evening rate; existing booking totals and custom rates stay intact.
begin;

alter table public.venue_settings
  alter column evening_hourly_rate set default 200;

update public.venue_settings
set evening_hourly_rate = 200
where id = true and evening_hourly_rate = 150;

commit;


-- Migration: 202610230004_weekend_open_play.sql
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


-- Migration: 202610230005_finance.sql
-- Staff finance reports use saved booking totals and the Philippine play date.
-- Existing reservations and payment totals are unchanged.
begin;

create table public.booking_finance (
  booking_id uuid primary key references public.bookings(id) on delete cascade,
  payment_method text not null check (payment_method in ('cash','gcash','bank_transfer','card','other','unspecified')),
  notes text not null default '' check (length(notes) <= 2000),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);
create table public.finance_day_notes (
  report_date date primary key check (report_date between date '2000-01-01' and date '2100-12-31'),
  worker_on_duty text not null default '' check (length(worker_on_duty) <= 200),
  manager_notes text not null default '' check (length(manager_notes) <= 4000),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);
alter table public.booking_finance enable row level security;
alter table public.finance_day_notes enable row level security;
revoke all on public.booking_finance, public.finance_day_notes from anon,authenticated;
grant select on public.booking_finance, public.finance_day_notes to authenticated;
create policy staff_read_booking_finance on public.booking_finance for select to authenticated using (public.is_staff());
create policy staff_read_finance_day_notes on public.finance_day_notes for select to authenticated using (public.is_staff());

-- Keep the original payment classification if a customer account is deleted.
insert into public.booking_finance(booking_id,payment_method)
select id,case when user_id is not null then 'gcash' else 'unspecified' end
from public.bookings where status<>'blocked';
create function public.record_booking_finance() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status<>'blocked' then
    insert into public.booking_finance(booking_id,payment_method)
      values(new.id,case when new.user_id is not null then 'gcash' else 'unspecified' end);
  end if;
  return new;
end;
$$;
revoke all on function public.record_booking_finance() from public,anon,authenticated;
create trigger record_booking_finance after insert on public.bookings
for each row execute function public.record_booking_finance();

create function public.staff_save_booking_finance(p_booking uuid,p_method text,p_notes text default '')
returns void language plpgsql security definer set search_path = '' as $$
declare b public.bookings%rowtype;
begin
  if not public.is_staff() then raise exception 'Booking: Staff access is required.'; end if;
  select * into b from public.bookings where id=p_booking for update;
  if not found or b.status='blocked' then raise exception 'Booking: Choose a reservation.'; end if;
  if p_method is null or p_method not in ('cash','gcash','bank_transfer','card','other','unspecified')
    or p_notes is null or length(p_notes)>2000 then raise exception 'Booking: Check the payment method and notes.'; end if;
  if b.user_id is not null and p_method<>'gcash' then raise exception 'Booking: Online reservations use GCash.'; end if;
  insert into public.booking_finance(booking_id,payment_method,notes,updated_by)
    values(p_booking,p_method,trim(p_notes),auth.uid())
    on conflict(booking_id) do update set payment_method=excluded.payment_method,notes=excluded.notes,updated_at=now(),updated_by=auth.uid();
end;
$$;
revoke all on function public.staff_save_booking_finance(uuid,text,text) from public;
grant execute on function public.staff_save_booking_finance(uuid,text,text) to authenticated;

-- Reuse the existing reservation functions, including schedule/capacity locks.
-- Payment classification and the walk-in are saved in the same transaction.
create function public.staff_record_booking(p_kind text,p_date date,p_name text,p_phone text,
  p_court int default null,p_start int default null,p_duration int default 1,
  p_people int default 1,p_blocked boolean default false,p_method text default 'cash',p_notes text default '')
returns uuid language plpgsql security definer set search_path = '' as $$
declare booking_id uuid;
begin
  if not public.is_staff() then raise exception 'Booking: Staff access is required.'; end if;
  if p_kind is null or p_kind not in ('court','open_play') or p_blocked is null
    or (p_kind='open_play' and p_blocked) then raise exception 'Booking: Choose a valid reservation type.'; end if;
  if p_kind='open_play' then
    booking_id := public.create_open_play_booking(p_date,p_people,p_name,p_phone,true);
  else
    booking_id := public.staff_create_booking(p_court,p_date,p_start,p_duration,p_name,p_phone,p_blocked);
  end if;
  if not p_blocked then perform public.staff_save_booking_finance(booking_id,p_method,p_notes); end if;
  return booking_id;
end;
$$;
revoke all on function public.staff_record_booking(text,date,text,text,int,int,int,int,boolean,text,text) from public;
grant execute on function public.staff_record_booking(text,date,text,text,int,int,int,int,boolean,text,text) to authenticated;

create function public.staff_save_finance_day(p_date date,p_worker text,p_notes text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_staff() then raise exception 'Booking: Staff access is required.'; end if;
  if p_date is null or p_date not between date '2000-01-01' and date '2100-12-31'
    or p_worker is null or length(p_worker)>200 or p_notes is null or length(p_notes)>4000
    then raise exception 'Booking: Check the date, worker name, and notes.'; end if;
  insert into public.finance_day_notes(report_date,worker_on_duty,manager_notes,updated_by)
    values(p_date,trim(p_worker),trim(p_notes),auth.uid())
    on conflict(report_date) do update set worker_on_duty=excluded.worker_on_duty,manager_notes=excluded.manager_notes,updated_at=now(),updated_by=auth.uid();
end;
$$;
revoke all on function public.staff_save_finance_day(date,text,text) from public;
grant execute on function public.staff_save_finance_day(date,text,text) to authenticated;

create function public.get_finance_month(p_month date)
returns table(report_date date,court_1_sales numeric,court_2_sales numeric,open_play_sales numeric,
  total_sales numeric,court_1_hours bigint,court_2_hours bigint,open_play_players bigint,
  cash_sales numeric,gcash_sales numeric,bank_transfer_sales numeric,card_sales numeric,other_sales numeric,unspecified_sales numeric,
  pending_value numeric,confirmed_bookings bigint)
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_staff() then raise exception 'Booking: Staff access is required.'; end if;
  if p_month is null or p_month not between date '2000-01-01' and date '2100-12-01' or extract(day from p_month)<>1
    then raise exception 'Booking: Choose a valid report month.'; end if;
  perform public.expire_unpaid_holds();
  return query
  with sales as (
    select b.*,coalesce(f.payment_method,case when b.user_id is not null then 'gcash' else 'unspecified' end) as method
    from public.bookings b left join public.booking_finance f on f.booking_id=b.id
    where b.booking_date >= p_month and b.booking_date < p_month+interval '1 month'
      and b.status in ('confirmed','awaiting_payment','awaiting_verification')
  )
  select d::date,
    coalesce(sum(s.total_amount) filter(where s.status='confirmed' and s.court_id=1),0),
    coalesce(sum(s.total_amount) filter(where s.status='confirmed' and s.court_id=2),0),
    coalesce(sum(s.total_amount) filter(where s.status='confirmed' and s.booking_type='open_play'),0),
    coalesce(sum(s.total_amount) filter(where s.status='confirmed'),0),
    coalesce(sum(s.duration) filter(where s.status='confirmed' and s.court_id=1),0),
    coalesce(sum(s.duration) filter(where s.status='confirmed' and s.court_id=2),0),
    coalesce(sum(s.participant_count) filter(where s.status='confirmed' and s.booking_type='open_play'),0),
    coalesce(sum(s.total_amount) filter(where s.status='confirmed' and s.method='cash'),0),
    coalesce(sum(s.total_amount) filter(where s.status='confirmed' and s.method='gcash'),0),
    coalesce(sum(s.total_amount) filter(where s.status='confirmed' and s.method='bank_transfer'),0),
    coalesce(sum(s.total_amount) filter(where s.status='confirmed' and s.method='card'),0),
    coalesce(sum(s.total_amount) filter(where s.status='confirmed' and s.method='other'),0),
    coalesce(sum(s.total_amount) filter(where s.status='confirmed' and s.method='unspecified'),0),
    coalesce(sum(s.total_amount) filter(where s.status in ('awaiting_payment','awaiting_verification')),0),
    count(s.id) filter(where s.status='confirmed')
  from generate_series(p_month::timestamp,p_month+interval '1 month'-interval '1 day',interval '1 day') d
  left join sales s on s.booking_date=d::date
  group by d order by d;
end;
$$;
revoke all on function public.get_finance_month(date) from public;
grant execute on function public.get_finance_month(date) to authenticated;

notify pgrst,'reload schema';
commit;


-- Migration: 202610230006_equipment_rental.sql
-- One optional equipment set per reservation, charged once at the saved rate.
-- Existing bookings keep their original totals and have no equipment charge.
begin;

alter table public.bookings
  add column equipment_rental boolean not null default false,
  add column equipment_amount numeric(10,2) not null default 0,
  add constraint booking_equipment_valid check (
    equipment_amount >= 0 and equipment_amount <= total_amount
    and (equipment_rental or equipment_amount=0)
    and (status<>'blocked' or (not equipment_rental and equipment_amount=0))
  );

-- Reuse the existing booking/payment/schedule rules. The equipment selection
-- and its price are committed with the reservation in the same transaction.
create function public.reserve_with_equipment(p_kind text,p_date date,p_name text,p_phone text,
  p_court int default null,p_start int default null,p_duration int default 1,p_people int default 1,
  p_rental boolean default false,p_walk_in boolean default false,p_blocked boolean default false,
  p_method text default 'cash',p_notes text default '')
returns uuid language plpgsql security definer set search_path = '' as $$
declare booking_id uuid; equipment_price numeric;
begin
  if auth.uid() is null then raise exception 'Booking: Please sign in before reserving.'; end if;
  if p_kind is null or p_kind not in ('court','open_play') or p_rental is null or p_walk_in is null or p_blocked is null
    or (p_blocked and (not p_walk_in or p_kind<>'court' or p_rental))
    then raise exception 'Booking: Choose a valid reservation and equipment option.'; end if;
  if p_walk_in then
    if not public.is_staff() then raise exception 'Booking: Staff access is required.'; end if;
    booking_id := public.staff_record_booking(p_kind,p_date,p_name,p_phone,p_court,p_start,p_duration,p_people,p_blocked,p_method,p_notes);
  elsif p_kind='open_play' then
    booking_id := public.create_open_play_booking(p_date,p_people,p_name,p_phone,false);
  else
    booking_id := public.create_booking(p_court,p_date,p_start,p_duration,p_name,p_phone);
  end if;
  if p_rental then
    -- The booking function already holds a shared venue lock; rates cannot
    -- change between its base quote and this equipment charge.
    select equipment_rental_price into equipment_price from public.venue_settings where id=true for share;
    update public.bookings set equipment_rental=true,equipment_amount=equipment_price,
      total_amount=total_amount+equipment_price where id=booking_id;
  end if;
  return booking_id;
end;
$$;
revoke all on function public.reserve_with_equipment(text,date,text,text,int,int,int,int,boolean,boolean,boolean,text,text) from public;
grant execute on function public.reserve_with_equipment(text,date,text,text,int,int,int,int,boolean,boolean,boolean,text,text) to authenticated;

-- Court/pass sales exclude rental; total and payment-method sales include it.
-- Snapshot amounts ensure rate changes never rewrite historical sales.
drop function public.get_finance_month(date);
create function public.get_finance_month(p_month date)
returns table(report_date date,court_1_sales numeric,court_2_sales numeric,open_play_sales numeric,
  total_sales numeric,court_1_hours bigint,court_2_hours bigint,open_play_players bigint,
  cash_sales numeric,gcash_sales numeric,bank_transfer_sales numeric,card_sales numeric,other_sales numeric,unspecified_sales numeric,
  pending_value numeric,confirmed_bookings bigint,equipment_sales numeric)
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_staff() then raise exception 'Booking: Staff access is required.'; end if;
  if p_month is null or p_month not between date '2000-01-01' and date '2100-12-01' or extract(day from p_month)<>1
    then raise exception 'Booking: Choose a valid report month.'; end if;
  perform public.expire_unpaid_holds();
  return query
  with sales as (
    select b.*,coalesce(f.payment_method,case when b.user_id is not null then 'gcash' else 'unspecified' end) as method
    from public.bookings b left join public.booking_finance f on f.booking_id=b.id
    where b.booking_date >= p_month and b.booking_date < p_month+interval '1 month'
      and b.status in ('confirmed','awaiting_payment','awaiting_verification')
  )
  select d::date,
    coalesce(sum(s.total_amount-s.equipment_amount) filter(where s.status='confirmed' and s.court_id=1),0),
    coalesce(sum(s.total_amount-s.equipment_amount) filter(where s.status='confirmed' and s.court_id=2),0),
    coalesce(sum(s.total_amount-s.equipment_amount) filter(where s.status='confirmed' and s.booking_type='open_play'),0),
    coalesce(sum(s.total_amount) filter(where s.status='confirmed'),0),
    coalesce(sum(s.duration) filter(where s.status='confirmed' and s.court_id=1),0),
    coalesce(sum(s.duration) filter(where s.status='confirmed' and s.court_id=2),0),
    coalesce(sum(s.participant_count) filter(where s.status='confirmed' and s.booking_type='open_play'),0),
    coalesce(sum(s.total_amount) filter(where s.status='confirmed' and s.method='cash'),0),
    coalesce(sum(s.total_amount) filter(where s.status='confirmed' and s.method='gcash'),0),
    coalesce(sum(s.total_amount) filter(where s.status='confirmed' and s.method='bank_transfer'),0),
    coalesce(sum(s.total_amount) filter(where s.status='confirmed' and s.method='card'),0),
    coalesce(sum(s.total_amount) filter(where s.status='confirmed' and s.method='other'),0),
    coalesce(sum(s.total_amount) filter(where s.status='confirmed' and s.method='unspecified'),0),
    coalesce(sum(s.total_amount) filter(where s.status in ('awaiting_payment','awaiting_verification')),0),
    count(s.id) filter(where s.status='confirmed'),
    coalesce(sum(s.equipment_amount) filter(where s.status='confirmed'),0)
  from generate_series(p_month::timestamp,p_month+interval '1 month'-interval '1 day',interval '1 day') d
  left join sales s on s.booking_date=d::date
  group by d order by d;
end;
$$;
revoke all on function public.get_finance_month(date) from public;
grant execute on function public.get_finance_month(date) to authenticated;

notify pgrst,'reload schema';
commit;


-- Migration: 202610240007_payment_options.sql
-- A reservation fee is 50% of the saved total, including equipment.
-- Existing bookings keep full-payment terms and their historical totals.
begin;

alter table public.bookings
  add column payment_option text not null default 'full' check (payment_option in ('full','reservation_fee')),
  add column initial_payment_amount numeric(10,2) generated always as
    (case when payment_option='reservation_fee' then round(total_amount/2,2) else total_amount end) stored,
  add column paid_amount numeric(10,2) not null default 0 check (paid_amount>=0 and paid_amount<=total_amount),
  add column balance_payment_method text check (balance_payment_method in ('cash','gcash','bank_transfer','card','other')),
  add column balance_payment_reference text,
  add column balance_paid_at timestamptz,
  add column balance_received_by uuid references auth.users(id) on delete set null,
  add constraint booking_balance_receipt_valid check (
    (balance_paid_at is null and balance_payment_method is null and balance_payment_reference is null)
    or (balance_paid_at is not null and balance_payment_method is not null and payment_option='reservation_fee' and paid_amount=total_amount)
  );
update public.bookings set paid_amount=total_amount where status='confirmed';
create unique index balance_payment_reference_once on public.bookings
  (lower(regexp_replace(balance_payment_reference,'[^a-zA-Z0-9]','','g')))
  where balance_payment_reference is not null;

-- Preserve legacy booking entry points, including equipment being added in
-- the same transaction. Only verified/collected money becomes paid_amount.
create function public.snapshot_verified_booking_payment() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.status='confirmed' then
    if tg_op='INSERT' then
      new.paid_amount := case when new.payment_option='reservation_fee' then round(new.total_amount/2,2) else new.total_amount end;
    elsif old.status<>'confirmed' or new.total_amount is distinct from old.total_amount
      or new.payment_option is distinct from old.payment_option then
      if old.balance_paid_at is not null then raise exception 'Booking: Settled payment terms cannot be changed.'; end if;
      new.paid_amount := case when new.payment_option='reservation_fee' then round(new.total_amount/2,2) else new.total_amount end;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.snapshot_verified_booking_payment() from public,anon,authenticated;
create trigger snapshot_verified_booking_payment before insert or update on public.bookings
  for each row execute function public.snapshot_verified_booking_payment();

create function public.reserve_with_payment(p_kind text,p_date date,p_name text,p_phone text,
  p_court int default null,p_start int default null,p_duration int default 1,p_people int default 1,
  p_rental boolean default false,p_walk_in boolean default false,p_blocked boolean default false,
  p_method text default 'cash',p_notes text default '',p_payment_option text default 'full')
returns uuid language plpgsql security definer set search_path='' as $$
declare booking_id uuid;
begin
  if p_payment_option is null or p_payment_option not in ('full','reservation_fee')
    or (p_blocked and p_payment_option<>'full') then raise exception 'Booking: Choose reservation fee or full payment.'; end if;
  booking_id := public.reserve_with_equipment(p_kind,p_date,p_name,p_phone,p_court,p_start,p_duration,p_people,p_rental,p_walk_in,p_blocked,p_method,p_notes);
  update public.bookings set payment_option=p_payment_option where id=booking_id;
  return booking_id;
end;
$$;
revoke all on function public.reserve_with_payment(text,date,text,text,int,int,int,int,boolean,boolean,boolean,text,text,text) from public,anon;
grant execute on function public.reserve_with_payment(text,date,text,text,int,int,int,int,boolean,boolean,boolean,text,text,text) to authenticated;

-- Both GCash reference entry points use the same lock, preventing a reference
-- being reused for an initial payment and a later balance payment concurrently.
create or replace function public.submit_payment_reference(p_booking uuid,p_reference text)
returns void language plpgsql security definer set search_path='' as $$
declare b public.bookings%rowtype; normalized text;
begin
  select * into b from public.bookings where id=p_booking for update;
  if b.id is null or b.user_id is distinct from auth.uid() or auth.uid() is null then raise exception 'Booking: Reservation not found.'; end if;
  if b.status<>'awaiting_payment' then raise exception 'Booking: This reservation is no longer awaiting payment.'; end if;
  if b.hold_expires_at<=now() then raise exception 'Booking: Your hold expired. Please contact the venue if you already paid.'; end if;
  if p_reference is null or p_reference !~ '^[a-zA-Z0-9 -]{6,40}$'
    or length(regexp_replace(p_reference,'[^a-zA-Z0-9]','','g'))<6 then raise exception 'Booking: Enter a valid GCash reference number.'; end if;
  normalized := lower(regexp_replace(p_reference,'[^a-zA-Z0-9]','','g'));
  perform pg_advisory_xact_lock(hashtextextended('rally-payment:'||normalized,0));
  if exists(select 1 from public.bookings where lower(regexp_replace(balance_payment_reference,'[^a-zA-Z0-9]','','g'))=normalized)
    then raise exception 'Booking: This payment reference has already been submitted. Please check it or contact the venue.'; end if;
  update public.bookings set payment_reference=trim(p_reference),status='awaiting_verification' where id=p_booking;
exception when unique_violation then raise exception 'Booking: This payment reference has already been submitted. Please check it or contact the venue.';
end;
$$;

-- Staff records the exact outstanding balance after checking receipt of money.
-- No amount comes from the browser, and a locked row prevents double collection.
create function public.staff_record_balance(p_booking uuid,p_method text,p_reference text default '')
returns void language plpgsql security definer set search_path='' as $$
declare b public.bookings%rowtype; normalized text; ref text;
begin
  if not public.is_staff() then raise exception 'Booking: Staff access is required.'; end if;
  select * into b from public.bookings where id=p_booking for update;
  if not found then raise exception 'Booking: Reservation not found.'; end if;
  if b.status<>'confirmed' or b.paid_amount>=b.total_amount or b.balance_paid_at is not null
    then raise exception 'Booking: Only a confirmed reservation with an unpaid balance can be settled.'; end if;
  if p_method is null or p_method not in ('cash','gcash','bank_transfer','card','other')
    then raise exception 'Booking: Choose the balance payment method.'; end if;
  ref := nullif(trim(coalesce(p_reference,'')),'');
  if (p_method='gcash' and ref is null) or (ref is not null and
    (ref !~ '^[a-zA-Z0-9 -]{6,40}$' or length(regexp_replace(ref,'[^a-zA-Z0-9]','','g'))<6))
    then raise exception 'Booking: Enter a valid payment reference (6–40 letters or numbers).'; end if;
  if ref is not null then
    normalized := lower(regexp_replace(ref,'[^a-zA-Z0-9]','','g'));
    perform pg_advisory_xact_lock(hashtextextended('rally-payment:'||normalized,0));
    if exists(select 1 from public.bookings where lower(regexp_replace(payment_reference,'[^a-zA-Z0-9]','','g'))=normalized
      or lower(regexp_replace(balance_payment_reference,'[^a-zA-Z0-9]','','g'))=normalized)
      then raise exception 'Booking: This payment reference has already been submitted. Please check it or contact the venue.'; end if;
  end if;
  update public.bookings set paid_amount=total_amount,balance_payment_method=p_method,
    balance_payment_reference=ref,balance_paid_at=now(),balance_received_by=auth.uid() where id=p_booking;
end;
$$;
revoke all on function public.staff_record_balance(uuid,text,text) from public,anon;
grant execute on function public.staff_record_balance(uuid,text,text) to authenticated;

-- Finance reports collected money, with booking value and outstanding balances
-- separately. Equipment is allocated proportionally, rounded to the centavo;
-- court/pass amounts receive the remainder so all columns reconcile exactly.
drop function public.get_finance_month(date);
create function public.get_finance_month(p_month date)
returns table(report_date date,court_1_sales numeric,court_2_sales numeric,open_play_sales numeric,
  total_sales numeric,court_1_hours bigint,court_2_hours bigint,open_play_players bigint,
  cash_sales numeric,gcash_sales numeric,bank_transfer_sales numeric,card_sales numeric,other_sales numeric,unspecified_sales numeric,
  pending_value numeric,confirmed_bookings bigint,equipment_sales numeric,booking_value numeric,balance_due numeric)
language plpgsql security definer set search_path='' as $$
begin
  if not public.is_staff() then raise exception 'Booking: Staff access is required.'; end if;
  if p_month is null or p_month not between date '2000-01-01' and date '2100-12-01' or extract(day from p_month)<>1
    then raise exception 'Booking: Choose a valid report month.'; end if;
  perform public.expire_unpaid_holds();
  return query
  with receipts as (
    select b.*,coalesce(f.payment_method,case when b.user_id is not null then 'gcash' else 'unspecified' end) as method,
      case when b.total_amount>0 then round(b.equipment_amount*b.paid_amount/b.total_amount,2) else 0 end as equipment_collected,
      case when b.balance_paid_at is not null then b.initial_payment_amount else b.paid_amount end as initial_collected,
      case when b.balance_paid_at is not null then b.total_amount-b.initial_payment_amount else 0 end as balance_collected
    from public.bookings b left join public.booking_finance f on f.booking_id=b.id
    where b.booking_date>=p_month and b.booking_date<p_month+interval '1 month'
      and b.status in ('confirmed','awaiting_payment','awaiting_verification')
  )
  select d::date,
    coalesce(sum(s.paid_amount-s.equipment_collected) filter(where s.status='confirmed' and s.court_id=1),0),
    coalesce(sum(s.paid_amount-s.equipment_collected) filter(where s.status='confirmed' and s.court_id=2),0),
    coalesce(sum(s.paid_amount-s.equipment_collected) filter(where s.status='confirmed' and s.booking_type='open_play'),0),
    coalesce(sum(s.paid_amount) filter(where s.status='confirmed'),0),
    coalesce(sum(s.duration) filter(where s.status='confirmed' and s.court_id=1),0),
    coalesce(sum(s.duration) filter(where s.status='confirmed' and s.court_id=2),0),
    coalesce(sum(s.participant_count) filter(where s.status='confirmed' and s.booking_type='open_play'),0),
    coalesce(sum((case when s.method='cash' then s.initial_collected else 0 end)+(case when s.balance_payment_method='cash' then s.balance_collected else 0 end)) filter(where s.status='confirmed'),0),
    coalesce(sum((case when s.method='gcash' then s.initial_collected else 0 end)+(case when s.balance_payment_method='gcash' then s.balance_collected else 0 end)) filter(where s.status='confirmed'),0),
    coalesce(sum((case when s.method='bank_transfer' then s.initial_collected else 0 end)+(case when s.balance_payment_method='bank_transfer' then s.balance_collected else 0 end)) filter(where s.status='confirmed'),0),
    coalesce(sum((case when s.method='card' then s.initial_collected else 0 end)+(case when s.balance_payment_method='card' then s.balance_collected else 0 end)) filter(where s.status='confirmed'),0),
    coalesce(sum((case when s.method='other' then s.initial_collected else 0 end)+(case when s.balance_payment_method='other' then s.balance_collected else 0 end)) filter(where s.status='confirmed'),0),
    coalesce(sum(s.initial_collected) filter(where s.status='confirmed' and s.method='unspecified'),0),
    coalesce(sum(s.total_amount) filter(where s.status in ('awaiting_payment','awaiting_verification')),0),
    count(s.id) filter(where s.status='confirmed'),
    coalesce(sum(s.equipment_collected) filter(where s.status='confirmed'),0),
    coalesce(sum(s.total_amount) filter(where s.status='confirmed'),0),
    coalesce(sum(s.total_amount-s.paid_amount) filter(where s.status='confirmed'),0)
  from generate_series(p_month::timestamp,p_month+interval '1 month'-interval '1 day',interval '1 day') d
  left join receipts s on s.booking_date=d::date
  group by d order by d;
end;
$$;
revoke all on function public.get_finance_month(date) from public,anon;
grant execute on function public.get_finance_month(date) to authenticated;
notify pgrst,'reload schema';
commit;


-- Migration: 202610240008_open_play_capacity.sql
-- Twelve rotating open-play participants per court, across two shared courts.
alter table public.venue_settings alter column open_play_capacity set default 24;
update public.venue_settings set open_play_capacity = 24 where id = true;


-- Migration: 202610260009_venue_rules.sql
-- Editable private-court capacity and rental inclusions.
-- Keep the ball count promised on existing rental bookings unchanged.
begin;

alter table public.venue_settings
  add column private_court_capacity int not null default 8
    check (private_court_capacity between 1 and 100),
  add column equipment_ball_count int not null default 1
    check (equipment_ball_count between 1 and 20);

alter table public.bookings
  add column equipment_ball_count int not null default 0;
update public.bookings set equipment_ball_count = 2 where equipment_rental;
alter table public.bookings
  add constraint booking_equipment_balls_valid check (
    (equipment_rental and equipment_ball_count between 1 and 20)
    or (not equipment_rental and equipment_ball_count = 0)
  );

create function public.snapshot_equipment_inclusions() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not new.equipment_rental then
    new.equipment_ball_count := 0;
  elsif tg_op = 'INSERT' or not old.equipment_rental then
    select v.equipment_ball_count into new.equipment_ball_count
      from public.venue_settings v where v.id = true for share;
  end if;
  return new;
end;
$$;
revoke all on function public.snapshot_equipment_inclusions() from public,anon,authenticated;
create trigger snapshot_equipment_inclusions
  before insert or update of equipment_rental on public.bookings
  for each row execute function public.snapshot_equipment_inclusions();

notify pgrst, 'reload schema';
commit;


-- Migration: 202610260010_schedule_editor.sql
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


-- Migration: 202610270011_booking_rate_limits.sql
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


-- Migration: 202610270012_equipment_quantity.sql
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


-- Migration: 202611040013_pos.sql
-- Booking + retail share one sales/payment ledger. Money is integer centavos.
begin;
create schema if not exists private;
alter table public.staff_members add column role text not null default 'manager' check(role in ('owner','manager','cashier'));
create function public.club_role() returns text language sql stable security definer set search_path='' as $$ select role from public.staff_members where user_id=auth.uid(); $$;
create function public.is_club_staff() returns boolean language sql stable security definer set search_path='' as $$ select exists(select 1 from public.staff_members where user_id=auth.uid()); $$;
-- Legacy settings/calendar mutations are manager-only. Cashiers use dedicated POS functions.
create or replace function public.is_staff() returns boolean language sql stable security definer set search_path='' as $$ select exists(select 1 from public.staff_members where user_id=auth.uid() and role in ('owner','manager')); $$;
revoke all on function public.club_role(),public.is_club_staff() from public,anon;
grant execute on function public.club_role(),public.is_club_staff() to authenticated;
create policy "Cashier booking operations" on public.bookings for select to authenticated using((select public.is_club_staff()));

create table public.pos_products(
 id uuid primary key default gen_random_uuid(), name text not null check(length(trim(name)) between 2 and 100),
 sku text not null check(length(trim(sku)) between 2 and 40), barcode text not null default '' check(length(barcode)<=50),
 category text not null check(length(trim(category)) between 1 and 40), price_cents integer not null check(price_cents between 1 and 100000000),
 cost_cents integer not null default 0 check(cost_cents between 0 and 100000000),stock integer not null default 0 check(stock>=0),
 reorder_level integer not null default 5 check(reorder_level between 0 and 100000),active boolean not null default true,
 revision integer not null default 0,created_at timestamptz not null default now()
);
create unique index pos_sku_unique on public.pos_products(lower(sku));
create unique index pos_barcode_unique on public.pos_products(barcode) where barcode<>'';
create table public.pos_registers(id uuid primary key default gen_random_uuid(), name text not null);
insert into public.pos_registers(id,name) values('00000000-0000-4000-a000-000000000001','Front desk');
create table public.pos_shifts(
 id uuid primary key default gen_random_uuid(),register_id uuid not null references public.pos_registers(id),
 cashier_id uuid not null references auth.users(id),opening_cents integer not null check(opening_cents between 0 and 100000000),
 opened_at timestamptz not null default now(),closed_at timestamptz,counted_cents integer check(counted_cents between 0 and 100000000),expected_cents bigint,
 check((closed_at is null and counted_cents is null) or (closed_at is not null and counted_cents is not null))
);
create unique index pos_one_open_cashier on public.pos_shifts(cashier_id) where closed_at is null;
create unique index pos_one_open_register on public.pos_shifts(register_id) where closed_at is null;
create sequence private.pos_sale_number;
create table public.pos_sales(
 id uuid primary key default gen_random_uuid(),number text not null unique default ('RC-'||lpad(nextval('private.pos_sale_number')::text,8,'0')),
 kind text not null check(kind in ('retail','booking')),booking_id uuid unique references public.bookings(id),customer_name text not null,
 total_cents integer not null check(total_cents>=0),paid_cents integer not null default 0 check(paid_cents>=0),refunded_cents integer not null default 0 check(refunded_cents>=0),
 status text not null default 'completed' check(status in ('completed','refunded')),cashier_id uuid references auth.users(id),
 request jsonb,created_at timestamptz not null default now(),check(paid_cents<=total_cents and refunded_cents<=paid_cents),
 check((kind='booking' and booking_id is not null) or (kind='retail' and booking_id is null))
);
create table public.pos_sale_items(
 id uuid primary key default gen_random_uuid(),sale_id uuid not null references public.pos_sales(id),product_id uuid references public.pos_products(id),
 name text not null,quantity integer not null check(quantity>0),price_cents integer not null check(price_cents>=0),cost_cents integer not null check(cost_cents>=0)
);
create table public.pos_payments(
 id uuid primary key default gen_random_uuid(),sale_id uuid not null references public.pos_sales(id),amount_cents integer not null check(amount_cents>0),
 method text not null check(method in ('cash','gcash','bank_transfer','card','other','unspecified')),reference text,
 shift_id uuid references public.pos_shifts(id),actor_id uuid references auth.users(id),created_at timestamptz not null default now(),
 check(method<>'cash' or shift_id is not null), check(method<>'gcash' or (reference is not null and length(reference)>=6))
);
create unique index pos_gcash_reference on public.pos_payments(lower(regexp_replace(reference,'[^a-zA-Z0-9]','','g'))) where method='gcash';
create table public.pos_refunds(
 id uuid primary key default gen_random_uuid(),sale_id uuid not null unique references public.pos_sales(id),amount_cents integer not null check(amount_cents>0),
 method text not null check(method in ('cash','gcash')),reason text not null check(length(trim(reason)) between 3 and 200),
 restock boolean not null,shift_id uuid not null references public.pos_shifts(id),actor_id uuid not null references auth.users(id),created_at timestamptz not null default now()
);
create table public.pos_stock_movements(
 id uuid primary key default gen_random_uuid(),product_id uuid not null references public.pos_products(id),quantity integer not null check(quantity<>0),
 reason text not null, sale_id uuid references public.pos_sales(id),actor_id uuid not null references auth.users(id),created_at timestamptz not null default now()
);
create table public.pos_audit(
 id uuid primary key default gen_random_uuid(),actor_id uuid references auth.users(id),action text not null,entity_id uuid,detail jsonb,created_at timestamptz not null default now()
);
create index pos_payment_day on public.pos_payments(created_at);
create index pos_refund_day on public.pos_refunds(created_at);
create index pos_sales_day on public.pos_sales(created_at);
create index pos_items_sale on public.pos_sale_items(sale_id);
create index pos_payment_sale on public.pos_payments(sale_id);
create index pos_stock_product on public.pos_stock_movements(product_id,created_at);
do $$ declare t text; begin
 foreach t in array array['pos_products','pos_registers','pos_shifts','pos_sales','pos_sale_items','pos_payments','pos_refunds','pos_stock_movements','pos_audit'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
  execute format('create policy "Staff read ledger" on public.%I for select to authenticated using ((select public.is_club_staff()))',t);
 end loop;
end $$;

create function private.pos_require_staff(p_manager boolean default false) returns void language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not public.is_club_staff() then raise exception 'POS: Authorized staff access is required.';end if;
 if p_manager and public.club_role() not in ('owner','manager') then raise exception 'POS: Manager authorization is required.';end if;
end;$$;
create function private.pos_open_shift_lock() returns uuid language plpgsql security definer set search_path='' as $$
declare sid uuid;begin
 select id into sid from public.pos_shifts where cashier_id=auth.uid() and closed_at is null for update;
 if sid is null then raise exception 'POS: Open your cashier shift before collecting payments.';end if;return sid;
end;$$;
create function private.pos_check_reference(p_reference text,p_booking uuid default null) returns void language plpgsql security definer set search_path='' as $$
declare normalized text;begin
 if p_reference is null or p_reference !~ '^[a-zA-Z0-9 -]{6,40}$' then raise exception 'POS: Enter a valid GCash reference (6–40 characters).';end if;
 normalized:=lower(regexp_replace(p_reference,'[^a-zA-Z0-9]','','g'));
 if length(normalized)<6 then raise exception 'POS: Enter a valid GCash reference.';end if;
 perform pg_advisory_xact_lock(hashtextextended('rally-payment:'||normalized,0));
 if exists(select 1 from public.pos_payments where method='gcash' and lower(regexp_replace(reference,'[^a-zA-Z0-9]','','g'))=normalized)
 or exists(select 1 from public.bookings where (p_booking is null or id<>p_booking) and
 (lower(regexp_replace(payment_reference,'[^a-zA-Z0-9]','','g'))=normalized or lower(regexp_replace(balance_payment_reference,'[^a-zA-Z0-9]','','g'))=normalized))
 then raise exception 'POS: This GCash reference is already recorded or submitted.';end if;
end;$$;
create function private.pos_add_payment(p_sale uuid,p_amount integer,p_method text,p_ref text,p_shift uuid,p_booking uuid default null) returns void language plpgsql security definer set search_path='' as $$
begin
 if p_amount<=0 then raise exception 'POS: Payment must be greater than zero.';end if;
 if p_method='gcash' then perform private.pos_check_reference(p_ref,p_booking);end if;
 insert into public.pos_payments(sale_id,amount_cents,method,reference,shift_id,actor_id) values(p_sale,p_amount,p_method,nullif(trim(p_ref),''),p_shift,auth.uid());
 update public.pos_sales set paid_cents=paid_cents+p_amount where id=p_sale;
end;$$;
create function private.pos_receipt(p_sale uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select to_jsonb(s)-'request' || jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(i) order by i.name) from public.pos_sale_items i where i.sale_id=s.id),'[]'::jsonb)) from public.pos_sales s where s.id=p_sale;
$$;

create function public.pos_open_shift(p_opening integer) returns uuid language plpgsql security definer set search_path='' as $$
declare sid uuid;begin
 perform private.pos_require_staff();
 if p_opening is null or p_opening not between 0 and 100000000 then raise exception 'POS: Enter a valid opening cash amount.';end if;
 insert into public.pos_shifts(register_id,cashier_id,opening_cents) values('00000000-0000-4000-a000-000000000001',auth.uid(),p_opening) returning id into sid;
 insert into public.pos_audit(actor_id,action,entity_id,detail) values(auth.uid(),'shift.open',sid,jsonb_build_object('opening_cents',p_opening));return sid;
exception when unique_violation then raise exception 'POS: This register or cashier already has an open shift.';end;$$;
create function public.pos_close_shift(p_shift uuid,p_counted integer) returns void language plpgsql security definer set search_path='' as $$
declare s public.pos_shifts%rowtype;expected bigint;begin
 perform private.pos_require_staff();select * into s from public.pos_shifts where id=p_shift for update;
 if s.id is null or s.cashier_id<>auth.uid() or s.closed_at is not null then raise exception 'POS: Only your active shift can be closed.';end if;
 if p_counted is null or p_counted not between 0 and 100000000 then raise exception 'POS: Enter the cash counted in the drawer.';end if;
 select s.opening_cents+coalesce((select sum(amount_cents) from public.pos_payments where shift_id=s.id and method='cash'),0)-coalesce((select sum(amount_cents) from public.pos_refunds where shift_id=s.id and method='cash'),0) into expected;
 update public.pos_shifts set expected_cents=expected,counted_cents=p_counted,closed_at=now() where id=s.id;
 insert into public.pos_audit(actor_id,action,entity_id,detail) values(auth.uid(),'shift.close',s.id,jsonb_build_object('expected',expected,'counted',p_counted,'variance',p_counted-expected));
end;$$;
create function public.pos_shift_summary() returns setof public.pos_shifts language sql stable security definer set search_path='' as $$
 select s.id,s.register_id,s.cashier_id,s.opening_cents,s.opened_at,s.closed_at,s.counted_cents,
 case when s.closed_at is null then s.opening_cents+coalesce((select sum(amount_cents) from public.pos_payments where shift_id=s.id and method='cash'),0)-coalesce((select sum(amount_cents) from public.pos_refunds where shift_id=s.id and method='cash'),0) else s.expected_cents end
 from public.pos_shifts s where s.cashier_id=auth.uid() and public.is_club_staff() order by s.opened_at desc limit 30;
$$;

create function public.pos_save_product(p_product jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare pid uuid;rev integer;begin
 perform private.pos_require_staff(true);
 if p_product->>'id' is not null then
  pid:=(p_product->>'id')::uuid;select revision into rev from public.pos_products where id=pid for update;
  if rev is null or rev<>(p_product->>'revision')::integer then raise exception 'POS: This product changed. Reload before saving.';end if;
  update public.pos_products set name=trim(p_product->>'name'),sku=trim(p_product->>'sku'),barcode=trim(coalesce(p_product->>'barcode','')),category=trim(p_product->>'category'),price_cents=(p_product->>'price_cents')::integer,cost_cents=(p_product->>'cost_cents')::integer,reorder_level=(p_product->>'reorder_level')::integer,active=(p_product->>'active')::boolean,revision=revision+1 where id=pid;
 else
  insert into public.pos_products(name,sku,barcode,category,price_cents,cost_cents,reorder_level,active)
  values(trim(p_product->>'name'),trim(p_product->>'sku'),trim(coalesce(p_product->>'barcode','')),trim(p_product->>'category'),(p_product->>'price_cents')::integer,(p_product->>'cost_cents')::integer,(p_product->>'reorder_level')::integer,coalesce((p_product->>'active')::boolean,true)) returning id into pid;
 end if;
 insert into public.pos_audit(actor_id,action,entity_id,detail) values(auth.uid(),'product.save',pid,p_product);return pid;
exception when unique_violation then raise exception 'POS: This SKU or barcode already belongs to another product.';end;$$;
create function public.pos_adjust_stock(p_product uuid,p_quantity integer,p_reason text) returns void language plpgsql security definer set search_path='' as $$
declare p public.pos_products%rowtype;begin
 perform private.pos_require_staff(true);
 if p_quantity is null or p_quantity=0 or p_quantity not between -100000 and 100000 or p_reason is null or length(trim(p_reason)) not between 3 and 200 then raise exception 'POS: Enter a quantity change and a reason.';end if;
 select * into p from public.pos_products where id=p_product for update;
 if p.id is null or p.stock+p_quantity<0 then raise exception 'POS: Stock cannot fall below zero.';end if;
 update public.pos_products set stock=stock+p_quantity where id=p.id;
 insert into public.pos_stock_movements(product_id,quantity,reason,actor_id) values(p.id,p_quantity,trim(p_reason),auth.uid());
 insert into public.pos_audit(actor_id,action,entity_id,detail) values(auth.uid(),'stock.adjust',p.id,jsonb_build_object('quantity',p_quantity,'reason',p_reason));
end;$$;

create function public.pos_checkout(p_request jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare sid uuid;pid uuid;old_request jsonb;item jsonb;p public.pos_products%rowtype;qty integer;total bigint:=0;method text;ref text;begin
 perform private.pos_require_staff();pid:=(p_request->>'key')::uuid;
 if pid is null or jsonb_typeof(p_request->'items')<>'array' or jsonb_array_length(p_request->'items') not between 1 and 100 or (p_request->>'verified')::boolean is distinct from true then raise exception 'POS: Enter cart items and confirm the received payment.';end if;
 perform pg_advisory_xact_lock(hashtextextended('rally-checkout:'||pid::text,0));
 select request into old_request from public.pos_sales where id=pid;
 if found then
  if old_request is distinct from p_request then raise exception 'POS: This checkout key was already used with another cart. Review Transactions before starting another sale.';end if;
  return private.pos_receipt(pid);
 end if;
 sid:=private.pos_open_shift_lock();method:=p_request->>'method';ref:=p_request->>'reference';
 if method is null or method not in ('cash','gcash') then raise exception 'POS: Choose cash or GCash.';end if;
 if (select count(distinct value->>'product_id') from jsonb_array_elements(p_request->'items'))<>jsonb_array_length(p_request->'items') then raise exception 'POS: Duplicate product in cart.';end if;
 -- Lock inventory in a deterministic order, before validating or deducting any item.
 perform id from public.pos_products where id in(select (value->>'product_id')::uuid from jsonb_array_elements(p_request->'items')) order by id for update;
 for item in select value from jsonb_array_elements(p_request->'items') loop
  qty:=(item->>'quantity')::integer;select * into p from public.pos_products where id=(item->>'product_id')::uuid;
  if p.id is null or not p.active or qty is null or qty not between 1 and 999 or p.stock<qty then raise exception 'POS: A product is unavailable or has insufficient stock.';end if;
  if (item->>'price_cents')::integer is distinct from p.price_cents then raise exception 'POS: A product price changed. Refresh the cart.';end if;
  total:=total+p.price_cents::bigint*qty;
 end loop;
 if total<=0 or total>100000000 then raise exception 'POS: Cart total is outside the supported range.';end if;
 if method='cash' and ((p_request->>'tendered_cents')::bigint is null or (p_request->>'tendered_cents')::bigint<total) then raise exception 'POS: Cash received must cover the total.';end if;
 if method='gcash' then perform private.pos_check_reference(ref);end if;
 insert into public.pos_sales(id,kind,customer_name,total_cents,cashier_id,request) values(pid,'retail',coalesce(nullif(trim(p_request->>'customer_name'),''),'Walk-in customer'),total::integer,auth.uid(),p_request);
 for item in select value from jsonb_array_elements(p_request->'items') loop
  qty:=(item->>'quantity')::integer;select * into p from public.pos_products where id=(item->>'product_id')::uuid;
  insert into public.pos_sale_items(sale_id,product_id,name,quantity,price_cents,cost_cents) values(pid,p.id,p.name,qty,p.price_cents,p.cost_cents);
  update public.pos_products set stock=stock-qty where id=p.id;
  insert into public.pos_stock_movements(product_id,quantity,reason,sale_id,actor_id) values(p.id,-qty,'Retail sale',pid,auth.uid());
 end loop;
 perform private.pos_add_payment(pid,total::integer,method,case when method='gcash' then ref else null end,sid);
 insert into public.pos_audit(actor_id,action,entity_id,detail) values(auth.uid(),'sale.complete',pid,jsonb_build_object('total_cents',total,'method',method));
 return private.pos_receipt(pid);
end;$$;

-- Protect references shared between manual booking payments and retail payments.
create function private.pos_booking_reference_guard() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if (tg_op='INSERT' or new.payment_reference is distinct from old.payment_reference) and new.payment_reference is not null then perform private.pos_check_reference(new.payment_reference,new.id);end if;
 if (tg_op='INSERT' or new.balance_payment_reference is distinct from old.balance_payment_reference) and new.balance_payment_reference is not null and new.balance_payment_method='gcash' then perform private.pos_check_reference(new.balance_payment_reference,new.id);end if;
 return new;
end;$$;
create trigger pos_booking_reference_guard before insert or update on public.bookings for each row execute function private.pos_booking_reference_guard();

create function private.pos_sync_booking(p_booking uuid) returns void language plpgsql security definer set search_path='' as $$
declare b public.bookings%rowtype;s public.pos_sales%rowtype;method text;sid uuid;initial integer;amount integer;begin
 select * into b from public.bookings where id=p_booking;
 if b.status<>'confirmed' or b.paid_amount<=0 then return;end if;
 select * into s from public.pos_sales where booking_id=b.id for update;
 if s.id is null then
  insert into public.pos_sales(kind,booking_id,customer_name,total_cents,cashier_id) values('booking',b.id,b.customer_name,round(b.total_amount*100)::integer,auth.uid()) returning * into s;
  insert into public.pos_sale_items(sale_id,name,quantity,price_cents,cost_cents) values(s.id,b.reference||' · '||case when b.booking_type='open_play' then 'Open play' else 'Court '||b.court_id::text end,1,s.total_cents,0);
 elsif s.total_cents<>round(b.total_amount*100)::integer then raise exception 'POS: A collected booking total cannot be changed.';end if;
 initial:=round((case when b.balance_paid_at is not null then b.initial_payment_amount else b.paid_amount end)*100)::integer;
 if s.paid_cents<initial then
  if b.user_id is not null then method:='gcash';else select payment_method into method from public.booking_finance where booking_id=b.id;end if;
  if method is null or method='unspecified' then return;end if;
  if method='gcash' and b.payment_reference is null then raise exception 'POS: A GCash payment needs a verified transaction reference. Use the online reservation and reference-review flow for this booking.';end if;
  sid:=null;if method='cash' then sid:=private.pos_open_shift_lock();end if;
  perform private.pos_add_payment(s.id,initial-s.paid_cents,method,b.payment_reference,sid,b.id);s.paid_cents:=initial;
 end if;
 amount:=round(b.paid_amount*100)::integer-s.paid_cents;
 if amount>0 and b.balance_paid_at is not null then
  sid:=null;
  if b.balance_payment_method='cash' then sid:=private.pos_open_shift_lock();
  else select id into sid from public.pos_shifts where cashier_id=auth.uid() and closed_at is null for update;end if;
  perform private.pos_add_payment(s.id,amount,b.balance_payment_method,b.balance_payment_reference,sid,b.id);
 end if;
end;$$;
create function private.pos_booking_sync_trigger() returns trigger language plpgsql security definer set search_path='' as $$begin perform private.pos_sync_booking(new.id);return new;end;$$;
create trigger pos_booking_sync after insert or update on public.bookings for each row execute function private.pos_booking_sync_trigger();
create function private.pos_finance_sync_trigger() returns trigger language plpgsql security definer set search_path='' as $$begin perform private.pos_sync_booking(new.booking_id);return new;end;$$;
create trigger pos_finance_sync after insert or update on public.booking_finance for each row execute function private.pos_finance_sync_trigger();
create function private.pos_finance_method_guard() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.payment_method is distinct from old.payment_method and exists(select 1 from public.pos_payments p join public.pos_sales s on s.id=p.sale_id where s.booking_id=new.booking_id) then raise exception 'POS: A collected payment method cannot be edited. Preserve the original ledger record.';end if;
 return new;
end;$$;
create trigger pos_finance_method_guard before update on public.booking_finance for each row execute function private.pos_finance_method_guard();

create function public.pos_verify_booking(p_booking uuid) returns void language plpgsql security definer set search_path='' as $$
declare b public.bookings%rowtype;begin
 perform private.pos_require_staff();select * into b from public.bookings where id=p_booking for update;
 if b.id is null or b.status<>'awaiting_verification' or b.payment_reference is null then raise exception 'POS: Only a submitted GCash payment can be verified.';end if;
 update public.bookings set status='confirmed' where id=b.id;
 insert into public.pos_audit(actor_id,action,entity_id,detail) values(auth.uid(),'booking.verify',b.id,jsonb_build_object('reference',b.payment_reference,'amount',b.initial_payment_amount));
end;$$;
create or replace function public.staff_update_booking(p_booking uuid,p_status text) returns void language plpgsql security definer set search_path='' as $$
declare b public.bookings%rowtype;begin
 perform private.pos_require_staff(true);
 if p_status='confirmed' then perform public.pos_verify_booking(p_booking);return;end if;
 if p_status is distinct from 'cancelled' then raise exception 'Booking: Invalid status.';end if;
 select * into b from public.bookings where id=p_booking for update;
 if b.id is null or b.status not in ('awaiting_payment','awaiting_verification','confirmed','blocked') then raise exception 'Booking: This reservation is already closed.';end if;
 update public.bookings set status='cancelled' where id=b.id;
 insert into public.pos_audit(actor_id,action,entity_id,detail) values(auth.uid(),'booking.cancel',b.id,jsonb_build_object('paid_amount',b.paid_amount));
end;$$;
create function public.pos_collect_balance(p_booking uuid,p_method text,p_reference text default '') returns void language plpgsql security definer set search_path='' as $$
declare b public.bookings%rowtype;sid uuid;begin
 perform private.pos_require_staff();
 if p_method is null or p_method not in ('cash','gcash') then raise exception 'POS: Choose cash or GCash.';end if;
 if p_method='cash' then sid:=private.pos_open_shift_lock();else select id into sid from public.pos_shifts where cashier_id=auth.uid() and closed_at is null for update;end if;
 select * into b from public.bookings where id=p_booking for update;
 if b.id is null or b.status<>'confirmed' or b.paid_amount>=b.total_amount or b.balance_paid_at is not null then raise exception 'POS: This booking has no collectible balance.';end if;
 if p_method='gcash' then perform private.pos_check_reference(p_reference,b.id);end if;
 update public.bookings set paid_amount=total_amount,balance_payment_method=p_method,balance_payment_reference=case when p_method='gcash' then trim(p_reference) else null end,balance_paid_at=now(),balance_received_by=auth.uid() where id=b.id;
 insert into public.pos_audit(actor_id,action,entity_id,detail) values(auth.uid(),'booking.balance',b.id,jsonb_build_object('method',p_method,'amount',b.total_amount-b.paid_amount));
end;$$;
-- Route the legacy balance UI through the same cash-drawer and reference guards.
create or replace function public.staff_record_balance(p_booking uuid,p_method text,p_reference text default '') returns void language plpgsql security definer set search_path='' as $$begin perform public.pos_collect_balance(p_booking,p_method,p_reference);end;$$;

create function public.pos_refund(p_sale uuid,p_method text,p_reason text,p_restock boolean) returns void language plpgsql security definer set search_path='' as $$
declare s public.pos_sales%rowtype;sid uuid;i record;begin
 perform private.pos_require_staff(true);sid:=private.pos_open_shift_lock();
 -- Booking first, then sale: same lock ordering as balance collection.
 perform b.id from public.bookings b join public.pos_sales s2 on s2.booking_id=b.id where s2.id=p_sale for update of b;
 select * into s from public.pos_sales where id=p_sale for update;
 if s.id is null or s.paid_cents<=0 or s.refunded_cents<>0 or s.status='refunded' then raise exception 'POS: This sale cannot be refunded again.';end if;
 if p_method is null or p_method not in ('cash','gcash') or p_reason is null or length(trim(p_reason)) not between 3 and 200 or p_restock is null then raise exception 'POS: Enter the refund method and reason.';end if;
 if p_restock and s.kind='retail' then
  perform p.id from public.pos_products p join public.pos_sale_items si on si.product_id=p.id where si.sale_id=s.id order by p.id for update of p;
  for i in select * from public.pos_sale_items where sale_id=s.id and product_id is not null loop
   update public.pos_products set stock=stock+i.quantity where id=i.product_id;
   insert into public.pos_stock_movements(product_id,quantity,reason,sale_id,actor_id) values(i.product_id,i.quantity,'Return: '||trim(p_reason),s.id,auth.uid());
  end loop;
 end if;
 insert into public.pos_refunds(sale_id,amount_cents,method,reason,restock,shift_id,actor_id) values(s.id,s.paid_cents,p_method,trim(p_reason),p_restock,sid,auth.uid());
 update public.pos_sales set refunded_cents=paid_cents,status='refunded' where id=s.id;
 if s.booking_id is not null then update public.bookings set status='cancelled' where id=s.booking_id;end if;
 insert into public.pos_audit(actor_id,action,entity_id,detail) values(auth.uid(),'sale.refund',s.id,jsonb_build_object('amount_cents',s.paid_cents,'method',p_method,'reason',p_reason,'restock',p_restock));
end;$$;

-- Never inherit Supabase's permissive default function grants.
do $$ declare f record;begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname like 'pos_%' loop execute format('revoke all on function %s from public,anon,authenticated',f.signature);end loop;
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'pos_%' loop execute format('revoke all on function %s from public,anon,authenticated',f.signature);execute format('grant execute on function %s to authenticated',f.signature);end loop;
end $$;
notify pgrst,'reload schema';
commit;


-- Migration: 202611050014_court_management.sql
-- Apply once after migration 013. Existing court IDs and bookings are preserved.
begin;
alter table public.courts drop constraint courts_id_check;
alter table public.courts add constraint courts_id_check check (id > 0);
alter table public.courts add column active boolean not null default true;
alter table public.courts add column revision integer not null default 0 check (revision >= 0);
alter table public.courts add constraint court_name_length check (length(trim(name)) between 1 and 60);
create unique index courts_unique_name on public.courts (lower(trim(name)));
revoke insert,update,delete on public.courts from anon,authenticated;

create function public.save_court(p_id integer,p_name text,p_active boolean,p_revision integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.courts%rowtype; next_id integer;
begin
  if not public.is_staff() then raise exception 'Booking: Manager access is required to edit courts.'; end if;
  if p_name is null or length(trim(p_name)) not between 1 and 60 or p_active is null then
    raise exception 'Booking: Enter a court name of up to 60 characters and an active status.'; end if;
  -- The same venue lock is acquired by booking creation and schedule changes.
  -- This serializes court deactivation with new reservations.
  perform 1 from public.venue_settings where id=true for update;
  if p_id is null then
    if p_revision is not null then raise exception 'Booking: Reload the courts before adding a new one.'; end if;
    if (select count(*) from public.courts)>=100 then raise exception 'Booking: This venue supports up to 100 court records.'; end if;
    select coalesce(max(id),0)+1 into next_id from public.courts;
    if next_id>32767 then raise exception 'Booking: No more court identifiers are available.'; end if;
    insert into public.courts(id,name,active) values(next_id,trim(p_name),p_active) returning * into c;
  else
    select * into c from public.courts where id=p_id for update;
    if not found or p_revision is null or c.revision<>p_revision then
      raise exception 'Booking: Another manager changed this court. Reload before saving.'; end if;
    if c.active and not p_active then
      if (select count(*) from public.courts where active)=1 and
        (select booking_enabled from public.venue_settings where id=true) then
        raise exception 'Booking: Pause online reservations before deactivating the last court.'; end if;
      if exists(select 1 from public.bookings b where (b.court_id=p_id or b.booking_type='open_play')
        and b.status in ('awaiting_payment','awaiting_verification','confirmed','blocked')
        and (b.status<>'awaiting_payment' or b.hold_expires_at>now())
        and (b.booking_date+(b.start_hour+b.duration)*interval '1 hour') at time zone 'Asia/Manila'>now()) then
        raise exception 'Booking: This court has upcoming reservations, blocks, or shared open-play sessions. Resolve them before deactivating it.'; end if;
    end if;
    update public.courts set name=trim(p_name),active=p_active,revision=revision+1 where id=p_id returning * into c;
  end if;
  return to_jsonb(c);
exception when unique_violation then
  raise exception 'Booking: A court with that name already exists.';
end;
$$;
revoke all on function public.save_court(integer,text,boolean,integer) from public,anon,authenticated;
grant execute on function public.save_court(integer,text,boolean,integer) to authenticated;

create function private.require_active_court() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.status not in ('awaiting_payment','awaiting_verification','confirmed','blocked') then return new; end if;
  if tg_op='UPDATE' then
    if old.status in ('awaiting_payment','awaiting_verification','confirmed','blocked')
      and (old.status<>'awaiting_payment' or old.hold_expires_at>now())
      and row(new.booking_type,new.court_id,new.booking_date,new.start_hour,new.duration,new.participant_count)
      is not distinct from row(old.booking_type,old.court_id,old.booking_date,old.start_hour,old.duration,old.participant_count)
      then return new; end if;
  end if;
  perform 1 from public.venue_settings where id=true for share;
  if new.booking_type='court' then
    perform 1 from public.courts where id=new.court_id and active for share;
    if not found then raise exception 'Booking: This court is inactive or no longer available. Choose an active court.'; end if;
  elsif not exists(select 1 from public.courts where active) then
    raise exception 'Booking: No active courts are available for open play.';
  end if;
  return new;
end;
$$;
create trigger aa_require_active_court before insert or update on public.bookings
for each row execute function private.require_active_court();

create function private.require_courts_for_reservations() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.booking_enabled and not exists(select 1 from public.courts where active) then
    raise exception 'Booking: Activate a court before opening online reservations.'; end if;
  return new;
end;
$$;
create trigger require_courts_for_reservations before update on public.venue_settings
for each row execute function private.require_courts_for_reservations();
revoke all on function private.require_active_court(),private.require_courts_for_reservations() from public,anon,authenticated;

-- Preserve every existing signature and payment/scheduling rule while widening
-- the three legacy court checks. The shared trigger protects every write path.
do $$
declare f regprocedure; definition text;
begin
  foreach f in array array[
    'public.create_booking(integer,date,integer,integer,text,text)'::regprocedure,
    'public.staff_create_booking(integer,date,integer,integer,text,text,boolean)'::regprocedure,
    'public.reserve_scheduled_booking_internal(text,date,text,text,integer,integer,integer,integer,boolean,boolean,boolean,text,text,text)'::regprocedure
  ] loop
    definition:=pg_get_functiondef(f);
    if position('p_court not in (1,2)' in definition)=0 then
      raise exception 'Expected legacy court validation was not found in %',f; end if;
    definition:=replace(definition,'p_court not in (1,2)',
      'not exists (select 1 from public.courts c where c.id=p_court and c.active)');
    execute definition;
  end loop;
end;
$$;

-- Dynamic per-court figures complement the unchanged aggregate report RPC.
-- Inactive courts remain in reports and existing collection semantics stay intact.
create function public.get_court_finance_month(p_month date)
returns table(report_date date,court_id smallint,sales numeric,hours bigint)
language plpgsql security definer set search_path='' as $$
begin
  if not public.is_staff() then raise exception 'Booking: Staff access is required.'; end if;
  if p_month is null or p_month not between date '2000-01-01' and date '2100-12-01' or extract(day from p_month)<>1 then
    raise exception 'Booking: Choose a valid report month.'; end if;
  perform public.expire_unpaid_holds();
  return query
    select d::date,c.id,
      coalesce(sum(b.paid_amount-case when b.total_amount>0 then round(b.equipment_amount*b.paid_amount/b.total_amount,2) else 0 end),0),
      coalesce(sum(b.duration),0)::bigint
    from generate_series(p_month::timestamp,p_month+interval '1 month'-interval '1 day',interval '1 day') d
    cross join public.courts c
    left join public.bookings b on b.booking_date=d::date and b.court_id=c.id and b.booking_type='court' and b.status='confirmed'
    group by d,c.id order by d,c.id;
end;
$$;
revoke all on function public.get_court_finance_month(date) from public,anon,authenticated;
grant execute on function public.get_court_finance_month(date) to authenticated;

-- New counter slips use the configured court name; saved slips keep their snapshot.
do $$
declare definition text;
begin
  definition:=pg_get_functiondef('private.pos_sync_booking(uuid)'::regprocedure);
  definition:=replace(definition,'''Court ''||b.court_id::text',
    'coalesce((select c.name from public.courts c where c.id=b.court_id),''Court ''||b.court_id::text)');
  execute definition;
end;
$$;
notify pgrst,'reload schema';
commit;
