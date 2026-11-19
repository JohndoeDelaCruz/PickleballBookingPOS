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

-- Migration: 202611070015_court_deletion.sql
-- Apply once after migration 014. No existing courts or bookings are deleted.
begin;

-- Never reuse a removed court ID: a stale manager tab must not edit a new court.
create sequence private.court_id_seq as integer minvalue 1;
select pg_catalog.setval('private.court_id_seq',
  greatest(coalesce(max(id),0),1), coalesce(max(id),0)>0) from public.courts;
revoke all on sequence private.court_id_seq from public,anon,authenticated;

do $$
declare definition text;
begin
  definition:=pg_get_functiondef('public.save_court(integer,text,boolean,integer)'::regprocedure);
  if position('select coalesce(max(id),0)+1 into next_id from public.courts;' in definition)=0 then
    raise exception 'Expected court ID allocation was not found. Apply migration 014 before 015.';
  end if;
  definition:=replace(definition,
    'select coalesce(max(id),0)+1 into next_id from public.courts;',
    'select nextval(''private.court_id_seq'') into next_id;');
  execute definition;
end;
$$;

create function public.delete_court(p_id integer,p_revision integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.courts%rowtype;
begin
  if not public.is_staff() then
    raise exception 'Booking: Manager access is required to delete courts.';
  end if;
  -- Match booking creation and court updates so availability cannot change mid-booking.
  perform 1 from public.venue_settings where id=true for update;
  select * into c from public.courts where id=p_id for update;
  if not found or p_revision is null or c.revision<>p_revision then
    raise exception 'Booking: Another manager changed or removed this court. Reload before deleting.';
  end if;
  if exists(select 1 from public.bookings where court_id=p_id) then
    raise exception 'Booking: This court has booking or block history. Deactivate it instead of deleting it.';
  end if;
  if c.active then
    if (select count(*) from public.courts where active)=1 and
      (select booking_enabled from public.venue_settings where id=true) then
      raise exception 'Booking: Pause online reservations before deleting the last active court.';
    end if;
    if exists(select 1 from public.bookings b where b.booking_type='open_play'
      and b.status in ('awaiting_payment','awaiting_verification','confirmed')
      and (b.status<>'awaiting_payment' or b.hold_expires_at>now())
      and (b.booking_date+(b.start_hour+b.duration)*interval '1 hour') at time zone 'Asia/Manila'>now()) then
      raise exception 'Booking: Upcoming shared open-play reservations use the active courts. Resolve them before deleting this court.';
    end if;
  end if;
  delete from public.courts where id=p_id;
  return to_jsonb(c);
exception when foreign_key_violation then
  raise exception 'Booking: This court has linked records. Deactivate it instead of deleting it.';
end;
$$;
revoke all on function public.delete_court(integer,integer) from public,anon,authenticated;
grant execute on function public.delete_court(integer,integer) to authenticated;

notify pgrst,'reload schema';
commit;

-- Bring the original Rally POS schema up to the interface used by the new staff tools.
begin;

lock table public.bookings, public.booking_finance, public.pos_sales in share row exclusive mode;

drop policy if exists "Cashier booking operations" on public.bookings;

create table private.pos_booking_baselines (
  booking_id uuid primary key references public.bookings(id) on delete cascade,
  paid_cents bigint not null check (paid_cents > 0)
);
alter table private.pos_booking_baselines enable row level security;
revoke all on private.pos_booking_baselines from public, anon, authenticated;

-- Preserve pre-ledger collections. Existing POS sales already track their paid balances.
insert into private.pos_booking_baselines(booking_id, paid_cents)
select b.id, round(b.paid_amount * 100)::bigint
from public.bookings b
where b.paid_amount > 0
  and not exists (select 1 from public.pos_sales s where s.booking_id = b.id);

create function public.pos_reservations(p_date date)
returns table(id uuid,reference text,customer_name text,booking_date date,start_hour smallint,duration smallint,
 court_id smallint,booking_type text,status text,total_amount numeric,paid_amount numeric,
 initial_payment_amount numeric,payment_reference text,payment_option text)
language plpgsql security definer set search_path='' as $$
begin
 perform private.pos_require_staff();
 if p_date is null or p_date not between date '2000-01-01' and date '2100-12-31' then
  raise exception 'POS: Choose a valid reservation date.';
 end if;
 perform public.expire_unpaid_holds();
 return query
  select b.id,b.reference,b.customer_name,b.booking_date,b.start_hour,b.duration,
   b.court_id,b.booking_type,b.status,b.total_amount,b.paid_amount,
   b.initial_payment_amount,b.payment_reference,b.payment_option
  from public.bookings b where b.booking_date between p_date and p_date+30
  order by b.booking_date,b.start_hour,b.id;
end;$$;
revoke all on function public.pos_reservations(date) from public, anon, authenticated;
grant execute on function public.pos_reservations(date) to authenticated;

create or replace function private.pos_sync_booking(p_booking uuid) returns void language plpgsql security definer set search_path='' as $$
declare b public.bookings%rowtype;s public.pos_sales%rowtype;method text;sid uuid;initial integer;amount integer;baseline bigint;begin
 select * into b from public.bookings where id=p_booking;
 if b.status<>'confirmed' or b.paid_amount<=0 then return;end if;
 select coalesce((select paid_cents from private.pos_booking_baselines where booking_id=b.id),0) into baseline;
 -- Earlier collections are already in Booking finance and must not hit a POS shift.
 if round(b.paid_amount*100)<=baseline then return;end if;
 select * into s from public.pos_sales where booking_id=b.id for update;
 if s.id is null then
  insert into public.pos_sales(kind,booking_id,customer_name,total_cents,paid_cents,cashier_id)
  values('booking',b.id,b.customer_name,round(b.total_amount*100)::integer,baseline::integer,auth.uid()) returning * into s;
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

-- Finalize equipment quantities and finance methods before posting the sale.
drop trigger pos_booking_sync on public.bookings;
drop trigger pos_finance_sync on public.booking_finance;
create constraint trigger pos_booking_sync after insert or update on public.bookings
deferrable initially deferred for each row execute function private.pos_booking_sync_trigger();
create constraint trigger pos_finance_sync after insert or update on public.booking_finance
deferrable initially deferred for each row execute function private.pos_finance_sync_trigger();

create or replace function public.pos_collect_balance(p_booking uuid,p_method text,p_reference text default '') returns void language plpgsql security definer set search_path='' as $$
declare b public.bookings%rowtype;sid uuid;ref text:=nullif(trim(p_reference),'');begin
 perform private.pos_require_staff();
 if p_method is null or p_method not in ('cash','gcash','bank_transfer','card','other') then raise exception 'POS: Choose a valid payment method.';end if;
 if p_method not in ('cash','gcash') then perform private.pos_require_staff(true);end if;
 if p_method='cash' then sid:=private.pos_open_shift_lock();else select id into sid from public.pos_shifts where cashier_id=auth.uid() and closed_at is null for update;end if;
 select * into b from public.bookings where id=p_booking for update;
 if b.id is null or b.status<>'confirmed' or b.paid_amount>=b.total_amount or b.balance_paid_at is not null then raise exception 'POS: This booking has no collectible balance.';end if;
 if p_method='gcash' or ref is not null then
  perform private.pos_check_reference(ref,b.id);
  if lower(regexp_replace(ref,'[^a-zA-Z0-9]','','g'))=lower(regexp_replace(b.payment_reference,'[^a-zA-Z0-9]','','g')) then
   raise exception 'POS: This GCash reference is already recorded or submitted.';
  end if;
 end if;
 update public.bookings set paid_amount=total_amount,balance_payment_method=p_method,balance_payment_reference=ref,balance_paid_at=now(),balance_received_by=auth.uid() where id=b.id;
 insert into public.pos_audit(actor_id,action,entity_id,detail) values(auth.uid(),'booking.balance',b.id,jsonb_build_object('method',p_method,'amount',b.total_amount-b.paid_amount));
end;$$;
-- Route the legacy balance UI through the same cash-drawer and reference guards.
create or replace function public.staff_record_balance(p_booking uuid,p_method text,p_reference text default '') returns void language plpgsql security definer set search_path='' as $$
begin
 perform private.pos_require_staff(true);
 perform public.pos_collect_balance(p_booking,p_method,p_reference);
end;$$;

notify pgrst, 'reload schema';
commit;

begin;

create table private.paddle_stack_sessions (
  id uuid primary key default gen_random_uuid(),
  play_date date not null,
  start_hour int not null check (start_hour between 0 and 23),
  end_hour int not null check (end_hour between 1 and 24 and end_hour > start_hour),
  capacity int check (capacity > 0),
  closed_at timestamptz,
  unique (play_date, start_hour, end_hour)
);

create table private.paddle_stack_courts (
  session_id uuid references private.paddle_stack_sessions(id) on delete cascade,
  court_id smallint not null,
  name text not null,
  score_key uuid unique,
  primary key (session_id, court_id)
);

create sequence private.paddle_stack_queue_number;
create table private.paddle_stack_players (
  id uuid primary key,
  session_id uuid not null references private.paddle_stack_sessions(id) on delete cascade,
  name text not null check (char_length(name) between 2 and 40),
  state text not null default 'waiting' check (state in ('waiting', 'playing', 'resting', 'left')),
  queue_number bigint not null default nextval('private.paddle_stack_queue_number')
);
create index paddle_stack_player_queue on private.paddle_stack_players(session_id, state, queue_number);

create table private.paddle_stack_games (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null,
  court_id smallint not null,
  players uuid[] not null check (cardinality(players) = 4),
  points smallint[] not null default '{}',
  revision int not null default 0,
  started_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  foreign key (session_id, court_id) references private.paddle_stack_courts(session_id, court_id) on delete cascade
);
create unique index paddle_stack_one_game_per_court
  on private.paddle_stack_games(session_id, court_id) where finished_at is null;
create index paddle_stack_live_court
  on private.paddle_stack_games(court_id) where finished_at is null;
create index paddle_stack_game_history
  on private.paddle_stack_games(session_id, court_id, started_at desc);

alter table private.paddle_stack_sessions enable row level security;
alter table private.paddle_stack_courts enable row level security;
alter table private.paddle_stack_players enable row level security;
alter table private.paddle_stack_games enable row level security;
revoke all on private.paddle_stack_sessions, private.paddle_stack_courts,
  private.paddle_stack_players, private.paddle_stack_games from public, anon, authenticated;
revoke all on sequence private.paddle_stack_queue_number from public, anon, authenticated;

create function private.paddle_stack_time(p_date date, p_hour int)
returns timestamptz language sql immutable set search_path = '' as $$
  select (p_date + make_interval(hours => p_hour)) at time zone 'Asia/Manila';
$$;

create function public.paddle_stack_sessions()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  today date := (now() at time zone 'Asia/Manila')::date;
  result jsonb;
begin
  perform private.pos_require_staff();
  select coalesce(jsonb_agg(to_jsonb(s) order by s.play_date, s.start_hour, s.end_hour), '[]'::jsonb)
  into result
  from (
    select today as play_date, b.start_hour, b.end_hour, p.id, p.closed_at
    from public.venue_settings v
    cross join lateral public.resolve_schedule_blocks(to_jsonb(v), today) b
    left join private.paddle_stack_sessions p
      on (p.play_date, p.start_hour, p.end_hour) = (today, b.start_hour, b.end_hour)
    where v.id and b.kind = 'open_play'
      and (p.id is not null or private.paddle_stack_time(today, b.end_hour) > now())
    union
    select p.play_date, p.start_hour, p.end_hour, p.id, p.closed_at
    from private.paddle_stack_sessions p
    where p.play_date = today
       or (p.play_date = today - 1 and p.closed_at is null
           and now() < private.paddle_stack_time(p.play_date, p.end_hour + 2))
  ) s;
  return result;
end;
$$;

create function public.paddle_stack_open(p_start int, p_end int)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  today date := (now() at time zone 'Asia/Manila')::date;
  venue jsonb;
  player_limit int;
  session_id uuid;
begin
  perform private.pos_require_staff();
  select to_jsonb(v) into venue from public.venue_settings v where v.id for share;
  perform pg_advisory_xact_lock(hashtextextended('rally-session:' || today::text, 0));
  select p.id into session_id from private.paddle_stack_sessions p
    where (p.play_date, p.start_hour, p.end_hour) = (today, p_start, p_end);
  if found then return session_id; end if;

  select b.capacity into player_limit from public.resolve_schedule_blocks(venue, today) b
    where b.kind = 'open_play' and b.start_hour = p_start and b.end_hour = p_end;
  if not found or now() >= private.paddle_stack_time(today, p_end) then
    raise exception 'Paddle Stack: Choose an upcoming or current open-play session.';
  end if;
  if not exists (select 1 from public.courts where active) then
    raise exception 'Paddle Stack: There are no active courts.';
  end if;

  insert into private.paddle_stack_sessions(play_date, start_hour, end_hour, capacity)
    values (today, p_start, p_end, player_limit) returning id into session_id;
  insert into private.paddle_stack_courts(session_id, court_id, name)
    select session_id, id, name from public.courts where active;
  return session_id;
end;
$$;

create function private.paddle_stack_game_view(p_game private.paddle_stack_games)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', p_game.id, 'revision', p_game.revision, 'finished_at', p_game.finished_at,
    'team_a', count(*) filter (where point = 1), 'team_b', count(*) filter (where point = 2),
    'can_undo', cardinality(p_game.points) > 0,
    'players', (select jsonb_agg(p.name order by member.position)
      from unnest(p_game.players) with ordinality as member(id, position)
      join private.paddle_stack_players p on p.id = member.id)
  )
  from unnest(p_game.points) as point;
$$;

create function public.get_paddle_stack(p_session uuid, p_key uuid default null, p_staff boolean default false)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  session private.paddle_stack_sessions%rowtype;
  show_staff boolean := p_staff is true and public.is_club_staff();
  today date := (now() at time zone 'Asia/Manila')::date;
  expired boolean;
begin
  select * into session from private.paddle_stack_sessions where id = p_session;
  if not found then return null; end if;
  expired := now() >= private.paddle_stack_time(session.play_date, session.end_hour + 2);
  if not show_staff and session.play_date < today and expired then return null; end if;
  return jsonb_build_object(
    'id', session.id, 'play_date', session.play_date, 'start_hour', session.start_hour,
    'end_hour', session.end_hour, 'capacity', session.capacity,
    'status', case
      when session.closed_at is not null or expired then 'closed'
      when now() >= private.paddle_stack_time(session.play_date, session.end_hour) then 'ending'
      when now() < private.paddle_stack_time(session.play_date, session.start_hour) then 'check_in'
      else 'playing' end,
    'score_court', (select c.court_id from private.paddle_stack_courts c
      where c.session_id = session.id and c.score_key = p_key and not expired and session.closed_at is null),
    'waiting', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name) order by p.queue_number)
      from private.paddle_stack_players p where p.session_id = session.id and p.state = 'waiting'
        and session.closed_at is null and not expired), '[]'::jsonb),
    'resting', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name) order by p.queue_number)
      from private.paddle_stack_players p where p.session_id = session.id and p.state = 'resting'
        and show_staff and session.closed_at is null and not expired), '[]'::jsonb),
    'checked_in', (select count(*) from private.paddle_stack_players p where p.session_id = session.id and p.state <> 'left'),
    'courts', coalesce((select jsonb_agg(jsonb_build_object(
      'id', c.court_id, 'name', c.name, 'active', coalesce(venue_court.active, false),
      'has_scorekeeper', show_staff and c.score_key is not null,
      'game', (select private.paddle_stack_game_view(g) from private.paddle_stack_games g
        where g.session_id = session.id and g.court_id = c.court_id
          and (g.finished_at is not null or not expired)
        order by g.started_at desc, g.id desc limit 1)
      ) order by c.court_id)
      from private.paddle_stack_courts c left join public.courts venue_court on venue_court.id = c.court_id
      where c.session_id = session.id), '[]'::jsonb),
    'results', coalesce((select jsonb_agg(private.paddle_stack_game_view(g.game) ||
      jsonb_build_object('court_name', g.court_name) order by g.finished_at desc, g.id desc)
      from (select games as game, games.id, games.finished_at, c.name as court_name
        from private.paddle_stack_games games
        join private.paddle_stack_courts c using (session_id, court_id)
        where games.session_id = session.id and games.finished_at is not null and show_staff
        order by games.finished_at desc, games.id desc limit 12) g), '[]'::jsonb)
  );
end;
$$;

create function public.paddle_stack_manage(
  p_session uuid, p_action text, p_court int default null, p_player uuid default null,
  p_name text default null, p_expected uuid[] default null
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  session private.paddle_stack_sessions%rowtype;
  next_players uuid[];
  score_key uuid;
  player_name text := btrim(p_name);
  venue jsonb;
  current_time_pht timestamptz := now();
begin
  perform private.pos_require_staff();
  select * into session from private.paddle_stack_sessions where id = p_session for update;
  if not found or session.closed_at is not null or current_time_pht >= private.paddle_stack_time(session.play_date, session.end_hour + 2) then
    raise exception 'Paddle Stack: This session is closed.';
  end if;

  case p_action
    when 'check_in' then
      if current_time_pht >= private.paddle_stack_time(session.play_date, session.end_hour) then
        raise exception 'Paddle Stack: Check-in has ended.';
      end if;
      if p_player is null or player_name is null or char_length(player_name) not between 2 and 40
        or player_name ~ '[[:cntrl:]]' then
        raise exception 'Paddle Stack: Enter a display name of 2 to 40 characters.';
      end if;
      if exists (select 1 from private.paddle_stack_players p where p.id = p_player
        and p.session_id = p_session and p.name = player_name) then return null; end if;
      if session.capacity is not null and session.capacity <= (
        select count(*) from private.paddle_stack_players p where p.session_id = p_session and p.state <> 'left'
      ) then
        raise exception 'Paddle Stack: This session has reached its player limit.';
      end if;
      insert into private.paddle_stack_players(id, session_id, name) values (p_player, p_session, player_name);
    when 'pause' then
      update private.paddle_stack_players set state = 'resting'
        where id = p_player and session_id = p_session and state = 'waiting';
    when 'rejoin' then
      if current_time_pht >= private.paddle_stack_time(session.play_date, session.end_hour) then
        raise exception 'Paddle Stack: This session has ended.';
      end if;
      update private.paddle_stack_players
        set state = 'waiting', queue_number = nextval('private.paddle_stack_queue_number')
        where id = p_player and session_id = p_session and state = 'resting';
    when 'leave' then
      update private.paddle_stack_players set state = 'left'
        where id = p_player and session_id = p_session and state in ('waiting', 'resting');
    when 'call' then
      if current_time_pht < private.paddle_stack_time(session.play_date, session.start_hour)
         or current_time_pht >= private.paddle_stack_time(session.play_date, session.end_hour) then
        raise exception 'Paddle Stack: Call games during the scheduled open-play hours.';
      end if;
      select to_jsonb(v) into venue from public.venue_settings v where v.id for share;
      perform pg_advisory_xact_lock(hashtextextended('rally-session:' || session.play_date::text, 0));
      if not exists (select 1 from public.resolve_schedule_blocks(venue, session.play_date) b
        where b.kind = 'open_play' and (b.start_hour, b.end_hour) = (session.start_hour, session.end_hour)) then
        raise exception 'Paddle Stack: The open-play schedule has changed.';
      end if;
      if not exists (select 1 from private.paddle_stack_courts c join public.courts v on v.id = c.court_id
        where c.session_id = p_session and c.court_id = p_court and v.active) then
        raise exception 'Paddle Stack: Choose an active court for this session.';
      end if;
      if exists (select 1 from private.paddle_stack_games g join private.paddle_stack_sessions s on s.id = g.session_id
        where g.court_id = p_court and g.finished_at is null and s.closed_at is null
          and now() < private.paddle_stack_time(s.play_date, s.end_hour + 2)) then
        raise exception 'Paddle Stack: Finish the current game on this court first.';
      end if;
      if exists (select 1 from public.bookings b where b.booking_date = session.play_date and b.court_id = p_court
        and b.status in ('awaiting_payment', 'awaiting_verification', 'confirmed', 'blocked')
        and (b.status <> 'awaiting_payment' or b.hold_expires_at > now())
        and b.start_hour < session.end_hour and b.start_hour + b.duration > session.start_hour) then
        raise exception 'Paddle Stack: This court has a conflicting booking or block.';
      end if;
      select array_agg(p.id order by p.queue_number) into next_players
        from (select id, queue_number from private.paddle_stack_players
          where session_id = p_session and state = 'waiting' order by queue_number limit 4) p;
      if coalesce(cardinality(next_players), 0) <> 4 then
        raise exception 'Paddle Stack: Four players must be waiting to call a game.';
      end if;
      if next_players is distinct from p_expected then
        raise exception 'Paddle Stack: The queue changed. Check who is up next before calling.';
      end if;
      insert into private.paddle_stack_games(session_id, court_id, players) values (p_session, p_court, next_players);
      update private.paddle_stack_players set state = 'playing' where id = any(next_players);
    when 'assign', 'revoke' then
      update private.paddle_stack_courts
        set score_key = case when p_action = 'assign' then gen_random_uuid() else null end
        where session_id = p_session and court_id = p_court
        returning paddle_stack_courts.score_key into score_key;
      if not found then raise exception 'Paddle Stack: Choose a court for this session.'; end if;
      return score_key;
    when 'close' then
      if exists (select 1 from private.paddle_stack_games where session_id = p_session and finished_at is null) then
        raise exception 'Paddle Stack: Finish the games on court before closing the session.';
      end if;
      update private.paddle_stack_sessions set closed_at = now() where id = p_session;
    else
      raise exception 'Paddle Stack: Choose a valid queue action.';
  end case;
  return null;
end;
$$;

create function public.paddle_stack_score(
  p_session uuid, p_game uuid, p_revision int, p_action text, p_key uuid default null
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  session private.paddle_stack_sessions%rowtype;
  game private.paddle_stack_games%rowtype;
  team smallint;
begin
  -- Check the capability before locking, then recheck after locking in case
  -- staff revoked or rotated the link while this request was waiting.
  select * into game from private.paddle_stack_games where id = p_game and session_id = p_session;
  if not found or not (public.is_club_staff() or exists (select 1 from private.paddle_stack_courts c
    where c.session_id = p_session and c.court_id = game.court_id and c.score_key = p_key)) then
    raise exception 'Paddle Stack: A valid scorekeeper link is required.';
  end if;
  select * into session from private.paddle_stack_sessions where id = p_session for update;
  if session.closed_at is not null or now() >= private.paddle_stack_time(session.play_date, session.end_hour + 2) then
    raise exception 'Paddle Stack: This session is closed.';
  end if;
  if not public.is_club_staff() and not exists (select 1 from private.paddle_stack_courts c
    where c.session_id = p_session and c.court_id = game.court_id and c.score_key = p_key) then
    raise exception 'Paddle Stack: This scorekeeper link has expired.';
  end if;
  select * into game from private.paddle_stack_games where id = p_game and session_id = p_session;
  if game.finished_at is not null or game.revision is distinct from p_revision then
    raise exception 'Paddle Stack: The game changed. Check the latest score before trying again.';
  end if;
  case p_action
    when 'point_a', 'point_b' then
      team := case when p_action = 'point_a' then 1 else 2 end;
      if cardinality(array_positions(game.points, team)) >= 99 then
        raise exception 'Paddle Stack: The maximum score is 99.';
      end if;
      update private.paddle_stack_games set points = array_append(points, team), revision = revision + 1 where id = p_game;
    when 'undo' then
      if cardinality(game.points) = 0 then raise exception 'Paddle Stack: There is no point to undo.'; end if;
      update private.paddle_stack_games set points = points[1:cardinality(points)-1], revision = revision + 1 where id = p_game;
    when 'finish' then
      update private.paddle_stack_games set finished_at = now(), revision = revision + 1 where id = p_game;
      update private.paddle_stack_players set state = 'resting' where id = any(game.players);
    else
      raise exception 'Paddle Stack: Choose a valid scoring action.';
  end case;
end;
$$;

revoke all on function private.paddle_stack_time(date,int),
  private.paddle_stack_game_view(private.paddle_stack_games) from public, anon, authenticated;
revoke all on function public.paddle_stack_sessions(), public.paddle_stack_open(int,int),
  public.paddle_stack_manage(uuid,text,int,uuid,text,uuid[]), public.get_paddle_stack(uuid,uuid,boolean),
  public.paddle_stack_score(uuid,uuid,int,text,uuid) from public, anon, authenticated;
grant execute on function public.paddle_stack_sessions(), public.paddle_stack_open(int,int),
  public.paddle_stack_manage(uuid,text,int,uuid,text,uuid[]) to authenticated;
grant execute on function public.get_paddle_stack(uuid,uuid,boolean),
  public.paddle_stack_score(uuid,uuid,int,text,uuid) to anon, authenticated;

notify pgrst, 'reload schema';
commit;

begin;

create function public.paddle_stack_shuffle(p_session uuid, p_expected uuid[])
returns void language plpgsql security definer set search_path = '' as $$
declare
  session private.paddle_stack_sessions%rowtype;
  waiting_players uuid[];
  queue_numbers bigint[];
  shuffled_players uuid[];
begin
  perform private.pos_require_staff();
  select * into session from private.paddle_stack_sessions where id = p_session for update;
  if not found or session.closed_at is not null
     or clock_timestamp() >= private.paddle_stack_time(session.play_date, session.end_hour) then
    raise exception 'Paddle Stack: The waiting queue is closed.';
  end if;

  select coalesce(array_agg(p.id order by p.queue_number), '{}'::uuid[]), array_agg(p.queue_number order by p.queue_number)
    into waiting_players, queue_numbers
    from private.paddle_stack_players p where p.session_id = p_session and p.state = 'waiting';
  if waiting_players is distinct from p_expected then
    raise exception 'Paddle Stack: The queue changed. Review the current queue and try again.';
  end if;
  if cardinality(waiting_players) < 2 then
    raise exception 'Paddle Stack: At least two players must be waiting to shuffle the queue.';
  end if;

  -- Always change the order so replaying the same request cannot reshuffle the queue.
  loop
    select array_agg(player_id order by random()) into shuffled_players
      from unnest(waiting_players) as player_id;
    exit when shuffled_players <> waiting_players;
  end loop;

  update private.paddle_stack_players p set queue_number = shuffled.queue_number
    from unnest(shuffled_players, queue_numbers) as shuffled(id, queue_number)
    where p.id = shuffled.id and p.session_id = p_session and p.state = 'waiting';
end;
$$;

create function private.paddle_stack_pair_game()
returns trigger language plpgsql set search_path = '' as $$
declare
  teams uuid[];
begin
  -- The court call already locked the session and selected the next four.
  with player_history as (
    select player.id, player.position,
      case when player.id = any(game.players[1:2]) then game.players[1:2]
           else coalesce(game.players[3:4], '{}'::uuid[]) end as previous_team,
      case when player.id = any(game.players[1:2]) then score.result
           else -score.result end as last_result
    from unnest(new.players) with ordinality as player(id, position)
    left join lateral (
      select g.players, g.points
      from private.paddle_stack_games g
      where g.session_id = new.session_id and g.finished_at is not null and player.id = any(g.players)
      order by g.finished_at desc, g.started_at desc, g.id desc
      limit 1
    ) game on true
    cross join lateral (
      select sign(count(*) filter (where point = 1) - count(*) filter (where point = 2)) as result
      from unnest(game.points) as point
    ) score
  )
  select array[a.id, b.id, c.id, d.id] into teams
  from (values (2, 3, 4), (3, 2, 4), (4, 2, 3)) as pairing(partner, opponent, other_opponent)
  join player_history a on a.position = 1
  join player_history b on b.position = pairing.partner
  join player_history c on c.position = pairing.opponent
  join player_history d on d.position = pairing.other_opponent
  order by
    (a.id = any(b.previous_team) or b.id = any(a.previous_team))::int
      + (c.id = any(d.previous_team) or d.id = any(c.previous_team))::int,
    abs(a.last_result + b.last_result - c.last_result - d.last_result),
    random()
  limit 1;

  new.players := teams;
  return new;
end;
$$;

create trigger paddle_stack_pair_game before insert on private.paddle_stack_games
  for each row execute function private.paddle_stack_pair_game();

revoke all on function private.paddle_stack_pair_game(), public.paddle_stack_shuffle(uuid,uuid[])
  from public, anon, authenticated;
grant execute on function public.paddle_stack_shuffle(uuid,uuid[]) to authenticated;

notify pgrst, 'reload schema';
commit;

begin;

alter table public.bookings
  add column payment_submitted_at timestamptz,
  add column payment_rejected_at timestamptz;

create function private.stamp_gcash_submission() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status = 'awaiting_verification' and new.payment_reference is not null then
    if tg_op = 'INSERT' or old.status <> 'awaiting_verification'
      or old.payment_reference is distinct from new.payment_reference then
      new.payment_submitted_at := now();
    end if;
  end if;
  return new;
end;
$$;
revoke all on function private.stamp_gcash_submission() from public, anon, authenticated;

create trigger stamp_gcash_submission
before insert or update of status, payment_reference on public.bookings
for each row execute function private.stamp_gcash_submission();

create index pending_gcash_review_age on public.bookings
  ((coalesce(payment_submitted_at, hold_expires_at, created_at)), id)
  where status = 'awaiting_verification' and payment_reference is not null;

create function public.pos_payment_reviews()
returns table (
  id uuid, reference text, customer_name text, booking_date date,
  start_hour smallint, duration smallint, court_id smallint, booking_type text,
  status text, total_amount numeric, paid_amount numeric, initial_payment_amount numeric,
  payment_reference text, payment_option text, payment_submitted_at timestamptz,
  overdue boolean
)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.pos_require_staff();
  -- For legacy submissions, the original hold deadline is the latest time a
  -- reference could have been accepted. Keep the exact submission time unknown.
  return query select
    b.id, b.reference, b.customer_name, b.booking_date, b.start_hour, b.duration,
    b.court_id, b.booking_type, b.status, b.total_amount, b.paid_amount,
    b.initial_payment_amount, b.payment_reference, b.payment_option, b.payment_submitted_at,
    coalesce(b.payment_submitted_at, b.hold_expires_at, b.created_at) <= now() - interval '30 minutes'
  from public.bookings b
  where b.status = 'awaiting_verification' and b.payment_reference is not null
  order by coalesce(b.payment_submitted_at, b.hold_expires_at, b.created_at), b.id;
end;
$$;

create function public.pos_reject_booking_payment(p_booking uuid, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  b public.bookings%rowtype;
  reason text := btrim(p_reason);
begin
  perform private.pos_require_staff();
  if reason is null or char_length(reason) not between 3 and 200 then
    raise exception 'POS: Enter a rejection reason between 3 and 200 characters.';
  end if;

  -- Verification locks the same booking before marking it paid. A stale
  -- rejection cannot release a slot once payment is verified.
  select * into b from public.bookings where id = p_booking for update;
  if not found or b.status <> 'awaiting_verification'
    or b.payment_reference is null or b.paid_amount <> 0 then
    raise exception 'POS: Only an unpaid booking with a GCash reference under review can be rejected.';
  end if;

  update public.bookings
    set status = 'cancelled', payment_reference = null, payment_rejected_at = now()
    where id = b.id;
  insert into public.pos_audit(actor_id, action, entity_id, detail)
    values (auth.uid(), 'booking.payment.reject', b.id, jsonb_build_object(
      'reference', b.payment_reference,
      'amount', b.initial_payment_amount,
      'reason', reason
    ));
end;
$$;

revoke all on function public.pos_payment_reviews(), public.pos_reject_booking_payment(uuid, text)
  from public, anon, authenticated;
grant execute on function public.pos_payment_reviews(), public.pos_reject_booking_payment(uuid, text)
  to authenticated;

notify pgrst, 'reload schema';
commit;

begin;

create function public.current_paddle_stack_matches()
returns table (session_id uuid, court_name text, game jsonb)
language sql stable security definer set search_path = '' as $$
  select s.id, c.name,
    private.paddle_stack_game_view(g) - array['revision', 'finished_at', 'can_undo']
  from private.paddle_stack_games g
  join private.paddle_stack_sessions s on s.id = g.session_id
  join private.paddle_stack_courts c on (c.session_id, c.court_id) = (g.session_id, g.court_id)
  where auth.uid() is not null
    and g.finished_at is null
    and s.closed_at is null
    and s.play_date between (now() at time zone 'Asia/Manila')::date - 1
      and (now() at time zone 'Asia/Manila')::date
    and now() >= private.paddle_stack_time(s.play_date, s.start_hour)
    and now() < private.paddle_stack_time(s.play_date, s.end_hour + 2)
  order by c.court_id, g.started_at, g.id;
$$;

revoke all on function public.current_paddle_stack_matches() from public, anon, authenticated;
grant execute on function public.current_paddle_stack_matches() to authenticated;

notify pgrst, 'reload schema';
commit;

begin;

create table public.pos_expenses (
  id uuid primary key,
  expense_date date not null check (expense_date between date '2000-01-01' and date '2100-12-31'),
  category text not null check (category in ('supplies', 'utilities', 'maintenance', 'payroll', 'inventory', 'other')),
  description text not null check (char_length(btrim(description)) between 2 and 200),
  amount_cents integer not null check (amount_cents between 1 and 100000000),
  payment_method text not null check (payment_method in ('cash', 'gcash', 'bank_transfer', 'card', 'other')),
  shift_id uuid references public.pos_shifts(id),
  actor_id uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  voided_at timestamptz,
  voided_by uuid references auth.users(id),
  void_reason text,
  check (shift_id is null or payment_method = 'cash'),
  check ((voided_at is null and voided_by is null and void_reason is null)
    or (voided_at is not null and voided_by is not null and void_reason is not null
      and char_length(btrim(void_reason)) between 3 and 200))
);
create index pos_expenses_date on public.pos_expenses(expense_date desc, created_at desc, id);
create index pos_expenses_shift on public.pos_expenses(shift_id) where voided_at is null and shift_id is not null;

alter table public.pos_expenses enable row level security;
revoke all on public.pos_expenses from public, anon, authenticated;
grant select on public.pos_expenses to authenticated;
create policy "Staff read authorized expenses" on public.pos_expenses for select to authenticated
  using ((select public.is_staff()) or (
    (select public.is_club_staff()) and actor_id = (select auth.uid()) and shift_id is not null
  ));

create function public.pos_record_expense(
  p_id uuid, p_date date, p_category text, p_description text,
  p_amount integer, p_method text, p_shift uuid
) returns date language plpgsql security definer set search_path = '' as $$
declare
  existing public.pos_expenses%rowtype;
  expense_description text := btrim(p_description);
  today date;
begin
  perform private.pos_require_staff(p_shift is null);
  if p_id is null or p_amount is null or p_amount not between 1 and 100000000
    or expense_description is null or char_length(expense_description) not between 2 and 200
    or p_category is null or p_category not in ('supplies', 'utilities', 'maintenance', 'payroll', 'inventory', 'other')
    or p_method is null or p_method not in ('cash', 'gcash', 'bank_transfer', 'card', 'other')
    or (p_shift is not null and (p_method <> 'cash' or p_date is not null))
    or (p_shift is null and (p_date is null or p_date not between date '2000-01-01' and date '2100-12-31')) then
    raise exception 'POS: Enter a valid expense date, description, category, amount, and payment method.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('rally-expense:' || p_id::text, 0));
  select * into existing from public.pos_expenses where id = p_id;
  if found then
    if existing.actor_id = auth.uid()
      and (existing.category, existing.description, existing.amount_cents, existing.payment_method)
        = (p_category, expense_description, p_amount, p_method)
      and existing.shift_id is not distinct from p_shift
      and (p_shift is not null or existing.expense_date = p_date) then
      return existing.expense_date;
    end if;
    raise exception 'POS: This request already recorded a different expense. Check the expense log before retrying.';
  end if;

  if p_shift is not null then
    perform 1 from public.pos_shifts where id = p_shift and cashier_id = auth.uid() and closed_at is null for update;
    if not found then raise exception 'POS: Open your cashier shift and refresh before recording a drawer expense.'; end if;
  end if;
  today := (clock_timestamp() at time zone 'Asia/Manila')::date;
  if p_date > today then
    raise exception 'POS: Choose today or an earlier date for a paid expense.';
  end if;

  insert into public.pos_expenses(id, expense_date, category, description, amount_cents, payment_method, shift_id, actor_id)
    values (p_id, coalesce(p_date, today), p_category, expense_description, p_amount, p_method, p_shift, auth.uid());
  insert into public.pos_audit(actor_id, action, entity_id, detail)
    values (auth.uid(), 'expense.record', p_id, jsonb_build_object('amount_cents', p_amount, 'shift_id', p_shift));
  return coalesce(p_date, today);
end;
$$;

create function public.pos_void_expense(p_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  expense public.pos_expenses%rowtype;
  reason text := btrim(p_reason);
begin
  perform private.pos_require_staff(true);
  if reason is null or char_length(reason) not between 3 and 200 then
    raise exception 'POS: Enter a reason for voiding this expense.';
  end if;
  select * into expense from public.pos_expenses where id = p_id for update;
  if not found then raise exception 'POS: This expense could not be found.'; end if;
  if expense.voided_at is not null then return; end if;
  -- Serialize with close so the saved reconciliation always reflects the drawer at closing.
  if expense.shift_id is not null then
    perform 1 from public.pos_shifts where id = expense.shift_id for update;
  end if;

  update public.pos_expenses set voided_at = now(), voided_by = auth.uid(), void_reason = reason where id = p_id;
  insert into public.pos_audit(actor_id, action, entity_id, detail)
    values (auth.uid(), 'expense.void', p_id, jsonb_build_object('reason', reason));
end;
$$;

create function public.pos_expense_report(p_month date, p_page integer)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
  result jsonb;
begin
  if not public.is_club_staff() then
    raise exception 'POS: Authorized staff access is required.';
  end if;
  if p_month is null or p_month not between date '2000-01-01' and date '2100-12-01'
    or extract(day from p_month) <> 1 or p_page is null or p_page < 1 then
    raise exception 'POS: Choose a valid expense report month and page.';
  end if;
  with expenses as (
    select e.*, coalesce(s.closed_at is not null, false) as shift_closed
    from public.pos_expenses e
    left join public.pos_shifts s on s.id = e.shift_id
    where e.expense_date >= p_month and e.expense_date < p_month + interval '1 month'
  ),
  page as (
    select id, expense_date, category, description, amount_cents, payment_method, shift_id, shift_closed,
      created_at, voided_at, void_reason
    from expenses
    order by expense_date desc, created_at desc, id
    limit 25 offset (greatest(p_page, 1)::bigint - 1) * 25
  )
  select jsonb_build_object(
    'total_cents', coalesce(sum(amount_cents) filter (where voided_at is null), 0),
    'drawer_cents', coalesce(sum(amount_cents) filter (where voided_at is null and shift_id is not null), 0),
    'row_count', count(*),
    'rows', coalesce((select jsonb_agg(to_jsonb(page) order by expense_date desc, created_at desc, id) from page), '[]'::jsonb),
    'active_shift', (select id from public.pos_shifts where cashier_id = auth.uid() and closed_at is null)
  ) into result from expenses;
  return result;
end;
$$;

create function private.pos_expected_cash(p_shift uuid, p_opening integer)
returns bigint language sql stable set search_path = '' as $$
  select p_opening
    + coalesce((select sum(amount_cents) from public.pos_payments where shift_id = p_shift and method = 'cash'), 0)
    - coalesce((select sum(amount_cents) from public.pos_refunds where shift_id = p_shift and method = 'cash'), 0)
    - coalesce((select sum(amount_cents) from public.pos_expenses where shift_id = p_shift and voided_at is null), 0);
$$;

create or replace function public.pos_close_shift(p_shift uuid, p_counted integer)
returns void language plpgsql security definer set search_path = '' as $$
declare
  shift public.pos_shifts%rowtype;
  expected bigint;
begin
  perform private.pos_require_staff();
  select * into shift from public.pos_shifts where id = p_shift for update;
  if shift.id is null or shift.cashier_id <> auth.uid() or shift.closed_at is not null then
    raise exception 'POS: Only your active shift can be closed.';
  end if;
  if p_counted is null or p_counted not between 0 and 100000000 then
    raise exception 'POS: Enter the cash counted in the drawer.';
  end if;
  expected := private.pos_expected_cash(shift.id, shift.opening_cents);
  update public.pos_shifts set expected_cents = expected, counted_cents = p_counted, closed_at = now() where id = shift.id;
  insert into public.pos_audit(actor_id, action, entity_id, detail)
    values (auth.uid(), 'shift.close', shift.id, jsonb_build_object('expected', expected, 'counted', p_counted, 'variance', p_counted - expected));
end;
$$;

create or replace function public.pos_shift_summary()
returns setof public.pos_shifts language sql stable security definer set search_path = '' as $$
  select s.id, s.register_id, s.cashier_id, s.opening_cents, s.opened_at, s.closed_at, s.counted_cents,
    case when s.closed_at is null then private.pos_expected_cash(s.id, s.opening_cents) else s.expected_cents end
  from public.pos_shifts s where s.cashier_id = auth.uid() and public.is_club_staff()
  order by s.opened_at desc limit 30;
$$;

revoke all on function private.pos_expected_cash(uuid, integer),
  public.pos_record_expense(uuid, date, text, text, integer, text, uuid),
  public.pos_void_expense(uuid, text), public.pos_expense_report(date, integer)
  from public, anon, authenticated;
grant execute on function public.pos_record_expense(uuid, date, text, text, integer, text, uuid),
  public.pos_void_expense(uuid, text), public.pos_expense_report(date, integer) to authenticated;

notify pgrst, 'reload schema';
commit;

begin;

alter table private.paddle_stack_players
  add column skill_level text check (skill_level in ('beginner', 'intermediate', 'advanced'));

create function private.paddle_stack_next_players(p_session uuid)
returns uuid[] language sql stable set search_path = '' as $$
  with waiting as (
    select id, queue_number, skill_level, count(*) over (partition by skill_level) as at_level
    from private.paddle_stack_players
    where session_id = p_session and state = 'waiting'
  ), first_player as (
    select skill_level, at_level from waiting order by queue_number, id limit 1
  )
  select coalesce(array_agg(next.id order by next.queue_number, next.id), '{}'::uuid[])
  from (
    select w.id, w.queue_number
    from waiting w cross join first_player first
    where first.skill_level is null or first.at_level < 4 or w.skill_level = first.skill_level
    order by w.queue_number, w.id
    limit 4
  ) next;
$$;

create or replace function public.get_paddle_stack(p_session uuid, p_key uuid default null, p_staff boolean default false)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  session private.paddle_stack_sessions%rowtype;
  show_staff boolean := p_staff is true and public.is_club_staff();
  today date := (now() at time zone 'Asia/Manila')::date;
  expired boolean;
begin
  select * into session from private.paddle_stack_sessions where id = p_session;
  if not found then return null; end if;
  expired := now() >= private.paddle_stack_time(session.play_date, session.end_hour + 2);
  if not show_staff and session.play_date < today and expired then return null; end if;
  return jsonb_build_object(
    'id', session.id, 'play_date', session.play_date, 'start_hour', session.start_hour,
    'end_hour', session.end_hour, 'capacity', session.capacity,
    'status', case
      when session.closed_at is not null or expired then 'closed'
      when now() >= private.paddle_stack_time(session.play_date, session.end_hour) then 'ending'
      when now() < private.paddle_stack_time(session.play_date, session.start_hour) then 'check_in'
      else 'playing' end,
    'score_court', (select c.court_id from private.paddle_stack_courts c
      where c.session_id = session.id and c.score_key = p_key and not expired and session.closed_at is null),
    'next_players', case when session.closed_at is null and not expired
      then to_jsonb(private.paddle_stack_next_players(p_session)) else '[]'::jsonb end,
    'waiting', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name)
      || case when show_staff and p.skill_level is not null
        then jsonb_build_object('skill_level', p.skill_level) else '{}'::jsonb end
      order by p.queue_number, p.id)
      from private.paddle_stack_players p where p.session_id = session.id and p.state = 'waiting'
        and session.closed_at is null and not expired), '[]'::jsonb),
    'resting', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name)
      || case when show_staff and p.skill_level is not null
        then jsonb_build_object('skill_level', p.skill_level) else '{}'::jsonb end
      order by p.queue_number, p.id)
      from private.paddle_stack_players p where p.session_id = session.id and p.state = 'resting'
        and show_staff and session.closed_at is null and not expired), '[]'::jsonb),
    'checked_in', (select count(*) from private.paddle_stack_players p where p.session_id = session.id and p.state <> 'left'),
    'courts', coalesce((select jsonb_agg(jsonb_build_object(
      'id', c.court_id, 'name', c.name, 'active', coalesce(venue_court.active, false),
      'has_scorekeeper', show_staff and c.score_key is not null,
      'game', (select private.paddle_stack_game_view(g) from private.paddle_stack_games g
        where g.session_id = session.id and g.court_id = c.court_id
          and (g.finished_at is not null or not expired)
        order by g.started_at desc, g.id desc limit 1)
      ) order by c.court_id)
      from private.paddle_stack_courts c left join public.courts venue_court on venue_court.id = c.court_id
      where c.session_id = session.id), '[]'::jsonb),
    'results', coalesce((select jsonb_agg(private.paddle_stack_game_view(g.game) ||
      jsonb_build_object('court_name', g.court_name) order by g.finished_at desc, g.id desc)
      from (select games as game, games.id, games.finished_at, c.name as court_name
        from private.paddle_stack_games games
        join private.paddle_stack_courts c using (session_id, court_id)
        where games.session_id = session.id and games.finished_at is not null and show_staff
        order by games.finished_at desc, games.id desc limit 12) g), '[]'::jsonb)
  );
end;
$$;

-- The new named argument is optional for existing callers.
drop function public.paddle_stack_manage(uuid, text, int, uuid, text, uuid[]);
create function public.paddle_stack_manage(
  p_session uuid, p_action text, p_court int default null, p_player uuid default null,
  p_name text default null, p_expected uuid[] default null, p_skill text default null
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  session private.paddle_stack_sessions%rowtype;
  next_players uuid[];
  score_key uuid;
  player_name text := btrim(p_name);
  venue jsonb;
  current_time_pht timestamptz := now();
begin
  perform private.pos_require_staff();
  select * into session from private.paddle_stack_sessions where id = p_session for update;
  if not found or session.closed_at is not null or current_time_pht >= private.paddle_stack_time(session.play_date, session.end_hour + 2) then
    raise exception 'Paddle Stack: This session is closed.';
  end if;
  if p_skill is not null and p_skill not in ('beginner', 'intermediate', 'advanced') then
    raise exception 'Paddle Stack: Choose a valid skill level.';
  end if;

  case p_action
    when 'check_in' then
      if current_time_pht >= private.paddle_stack_time(session.play_date, session.end_hour) then
        raise exception 'Paddle Stack: Check-in has ended.';
      end if;
      if p_player is null or player_name is null or char_length(player_name) not between 2 and 40
        or player_name ~ '[[:cntrl:]]' then
        raise exception 'Paddle Stack: Enter a display name of 2 to 40 characters.';
      end if;
      if exists (select 1 from private.paddle_stack_players p where p.id = p_player
        and p.session_id = p_session and p.name = player_name) then return null; end if;
      if session.capacity is not null and session.capacity <= (
        select count(*) from private.paddle_stack_players p where p.session_id = p_session and p.state <> 'left'
      ) then
        raise exception 'Paddle Stack: This session has reached its player limit.';
      end if;
      insert into private.paddle_stack_players(id, session_id, name, skill_level)
        values (p_player, p_session, player_name, p_skill);
    when 'set_skill' then
      update private.paddle_stack_players set skill_level = p_skill
      where id = p_player and session_id = p_session and state in ('waiting', 'resting')
        and current_time_pht < private.paddle_stack_time(session.play_date, session.end_hour);
      if not found then
        raise exception 'Paddle Stack: Only waiting or resting players can change skill level during check-in or open play.';
      end if;
    when 'pause' then
      update private.paddle_stack_players set state = 'resting'
        where id = p_player and session_id = p_session and state = 'waiting';
    when 'rejoin' then
      if current_time_pht >= private.paddle_stack_time(session.play_date, session.end_hour) then
        raise exception 'Paddle Stack: This session has ended.';
      end if;
      update private.paddle_stack_players
        set state = 'waiting', queue_number = nextval('private.paddle_stack_queue_number')
        where id = p_player and session_id = p_session and state = 'resting';
    when 'leave' then
      update private.paddle_stack_players set state = 'left'
        where id = p_player and session_id = p_session and state in ('waiting', 'resting');
    when 'call' then
      if current_time_pht < private.paddle_stack_time(session.play_date, session.start_hour)
         or current_time_pht >= private.paddle_stack_time(session.play_date, session.end_hour) then
        raise exception 'Paddle Stack: Call games during the scheduled open-play hours.';
      end if;
      select to_jsonb(v) into venue from public.venue_settings v where v.id for share;
      perform pg_advisory_xact_lock(hashtextextended('rally-session:' || session.play_date::text, 0));
      if not exists (select 1 from public.resolve_schedule_blocks(venue, session.play_date) b
        where b.kind = 'open_play' and (b.start_hour, b.end_hour) = (session.start_hour, session.end_hour)) then
        raise exception 'Paddle Stack: The open-play schedule has changed.';
      end if;
      if not exists (select 1 from private.paddle_stack_courts c join public.courts v on v.id = c.court_id
        where c.session_id = p_session and c.court_id = p_court and v.active) then
        raise exception 'Paddle Stack: Choose an active court for this session.';
      end if;
      if exists (select 1 from private.paddle_stack_games g join private.paddle_stack_sessions s on s.id = g.session_id
        where g.court_id = p_court and g.finished_at is null and s.closed_at is null
          and now() < private.paddle_stack_time(s.play_date, s.end_hour + 2)) then
        raise exception 'Paddle Stack: Finish the current game on this court first.';
      end if;
      if exists (select 1 from public.bookings b where b.booking_date = session.play_date and b.court_id = p_court
        and b.status in ('awaiting_payment', 'awaiting_verification', 'confirmed', 'blocked')
        and (b.status <> 'awaiting_payment' or b.hold_expires_at > now())
        and b.start_hour < session.end_hour and b.start_hour + b.duration > session.start_hour) then
        raise exception 'Paddle Stack: This court has a conflicting booking or block.';
      end if;
      next_players := private.paddle_stack_next_players(p_session);
      if coalesce(cardinality(next_players), 0) <> 4 then
        raise exception 'Paddle Stack: Four players must be waiting to call a game.';
      end if;
      if next_players is distinct from p_expected then
        raise exception 'Paddle Stack: The queue changed. Check who is up next before calling.';
      end if;
      insert into private.paddle_stack_games(session_id, court_id, players) values (p_session, p_court, next_players);
      update private.paddle_stack_players set state = 'playing' where id = any(next_players);
    when 'assign', 'revoke' then
      update private.paddle_stack_courts
        set score_key = case when p_action = 'assign' then gen_random_uuid() else null end
        where session_id = p_session and court_id = p_court
        returning paddle_stack_courts.score_key into score_key;
      if not found then raise exception 'Paddle Stack: Choose a court for this session.'; end if;
      return score_key;
    when 'close' then
      if exists (select 1 from private.paddle_stack_games where session_id = p_session and finished_at is null) then
        raise exception 'Paddle Stack: Finish the games on court before closing the session.';
      end if;
      update private.paddle_stack_sessions set closed_at = now() where id = p_session;
    else
      raise exception 'Paddle Stack: Choose a valid queue action.';
  end case;
  return null;
end;
$$;

create or replace function private.paddle_stack_pair_game()
returns trigger language plpgsql set search_path = '' as $$
declare
  teams uuid[];
begin
  -- Balance skill first, then prefer splitting recent teammates and results.
  -- Unrated players are neutral for pairing and don't form a same-level group.
  with player_history as (
    select player.id, player.position,
      case p.skill_level when 'beginner' then 1 when 'advanced' then 3 else 2 end as skill,
      case when player.id = any(game.players[1:2]) then game.players[1:2]
           else coalesce(game.players[3:4], '{}'::uuid[]) end as previous_team,
      case when player.id = any(game.players[1:2]) then score.result
           else -score.result end as last_result
    from unnest(new.players) with ordinality as player(id, position)
    join private.paddle_stack_players p on p.id = player.id
    left join lateral (
      select g.players, g.points
      from private.paddle_stack_games g
      where g.session_id = new.session_id and g.finished_at is not null and player.id = any(g.players)
      order by g.finished_at desc, g.started_at desc, g.id desc
      limit 1
    ) game on true
    cross join lateral (
      select sign(count(*) filter (where point = 1) - count(*) filter (where point = 2)) as result
      from unnest(game.points) as point
    ) score
  )
  select array[a.id, b.id, c.id, d.id] into teams
  from (values (2, 3, 4), (3, 2, 4), (4, 2, 3)) as pairing(partner, opponent, other_opponent)
  join player_history a on a.position = 1
  join player_history b on b.position = pairing.partner
  join player_history c on c.position = pairing.opponent
  join player_history d on d.position = pairing.other_opponent
  order by
    abs(a.skill + b.skill - c.skill - d.skill),
    (a.id = any(b.previous_team) or b.id = any(a.previous_team))::int
      + (c.id = any(d.previous_team) or d.id = any(c.previous_team))::int,
    abs(a.last_result + b.last_result - c.last_result - d.last_result),
    random()
  limit 1;

  new.players := teams;
  return new;
end;
$$;

revoke all on function private.paddle_stack_next_players(uuid),
  public.paddle_stack_manage(uuid, text, int, uuid, text, uuid[], text) from public, anon, authenticated;
grant execute on function public.paddle_stack_manage(uuid, text, int, uuid, text, uuid[], text) to authenticated;

notify pgrst, 'reload schema';
commit;

begin;

create or replace function public.paddle_stack_score(
  p_session uuid, p_game uuid, p_revision int, p_action text, p_key uuid default null
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  session private.paddle_stack_sessions%rowtype;
  game private.paddle_stack_games%rowtype;
  team smallint;
  player_id uuid;
begin
  -- Check the capability before locking, then recheck after locking in case
  -- staff revoked or rotated the link while this request was waiting.
  select * into game from private.paddle_stack_games where id = p_game and session_id = p_session;
  if not found or not (public.is_club_staff() or exists (select 1 from private.paddle_stack_courts c
    where c.session_id = p_session and c.court_id = game.court_id and c.score_key = p_key)) then
    raise exception 'Paddle Stack: A valid scorekeeper link is required.';
  end if;
  select * into session from private.paddle_stack_sessions where id = p_session for update;
  if session.closed_at is not null or now() >= private.paddle_stack_time(session.play_date, session.end_hour + 2) then
    raise exception 'Paddle Stack: This session is closed.';
  end if;
  if not public.is_club_staff() and not exists (select 1 from private.paddle_stack_courts c
    where c.session_id = p_session and c.court_id = game.court_id and c.score_key = p_key) then
    raise exception 'Paddle Stack: This scorekeeper link has expired.';
  end if;
  select * into game from private.paddle_stack_games where id = p_game and session_id = p_session;
  if game.finished_at is not null or game.revision is distinct from p_revision then
    raise exception 'Paddle Stack: The game changed. Check the latest score before trying again.';
  end if;
  case p_action
    when 'point_a', 'point_b' then
      team := case when p_action = 'point_a' then 1 else 2 end;
      if cardinality(array_positions(game.points, team)) >= 99 then
        raise exception 'Paddle Stack: The maximum score is 99.';
      end if;
      update private.paddle_stack_games set points = array_append(points, team), revision = revision + 1 where id = p_game;
    when 'undo' then
      if cardinality(game.points) = 0 then raise exception 'Paddle Stack: There is no point to undo.'; end if;
      update private.paddle_stack_games set points = points[1:cardinality(points)-1], revision = revision + 1 where id = p_game;
    when 'finish' then
      update private.paddle_stack_games set finished_at = now(), revision = revision + 1 where id = p_game;
      -- The session lock keeps this group behind anyone already waiting.
      -- Retain the players' original queue order even if teams were rearranged.
      for player_id in
        select id from private.paddle_stack_players
        where session_id = p_session and state = 'playing' and id = any(game.players)
        order by queue_number, id
      loop
        update private.paddle_stack_players
          set state = 'waiting', queue_number = nextval('private.paddle_stack_queue_number')
          where id = player_id;
      end loop;
    else
      raise exception 'Paddle Stack: Choose a valid scoring action.';
  end case;
end;
$$;

notify pgrst, 'reload schema';
commit;

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

begin;

create policy "Managers read role changes" on public.pos_audit as restrictive
  for select to authenticated using (action <> 'access.role_change' or (select public.is_staff()));

create function public.admin_list_accounts(p_query text, p_page int)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  actor_role text := public.club_role();
  query text := lower(btrim(coalesce(p_query, '')));
  page_size constant int := 25;
begin
  if actor_role is null or actor_role not in ('owner', 'manager') then
    raise exception 'Access: Manager or owner authorization is required.';
  end if;
  if length(query) > 254 or p_page is null or p_page < 1 then
    raise exception 'Access: Choose a valid account search and page.';
  end if;

  return (
    with matching as (
      select u.id, u.email, coalesce(s.role, 'player') as role,
        u.email_confirmed_at is not null as email_confirmed
      from auth.users u left join public.staff_members s on s.user_id = u.id
      where u.email <> '' and (query = '' or strpos(lower(u.email), query) > 0)
    ), page as (
      select * from matching order by lower(email), id
      limit page_size offset (p_page::bigint - 1) * page_size
    )
    select jsonb_build_object('row_count', (select count(*) from matching), 'rows',
      coalesce((select jsonb_agg(to_jsonb(page) order by lower(email), id) from page), '[]'::jsonb))
  );
end;
$$;

create function public.admin_set_account_role(p_user_id uuid, p_expected_role text, p_role text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  actor_role text := public.club_role();
  existing_role text;
  confirmed boolean;
begin
  if actor_role is null or actor_role not in ('owner', 'manager') then
    raise exception 'Access: Manager or owner authorization is required.';
  end if;
  if p_user_id is null or p_expected_role is null or p_expected_role not in ('player', 'cashier', 'manager', 'owner')
    or p_role is null or p_role not in ('player', 'cashier', 'manager', 'owner') then
    raise exception 'Access: Choose a valid account and role.';
  end if;
  if p_user_id = actor then
    raise exception 'Access: You can’t change your own role.';
  end if;
  select u.email_confirmed_at is not null into confirmed
  from auth.users u where u.id = p_user_id and u.email <> '' for key share;
  if not found then raise exception 'Access: That account is no longer available.'; end if;
  -- Serialize role edits and recheck the actor after any wait for another edit.
  lock table public.staff_members in share row exclusive mode;
  actor_role := public.club_role();
  if actor_role is null or actor_role not in ('owner', 'manager') then
    raise exception 'Access: Manager or owner authorization is required.';
  end if;
  select s.role into existing_role from public.staff_members s where s.user_id = p_user_id for update;
  existing_role := coalesce(existing_role, 'player');
  if actor_role = 'manager' and (existing_role in ('manager', 'owner') or p_role in ('manager', 'owner')) then
    raise exception 'Access: Only an owner can assign or change Manager and Owner roles.';
  end if;
  if existing_role = p_role then return; end if;
  if existing_role <> p_expected_role then
    raise exception 'Access: This account’s role changed. Refresh the list and review it before trying again.';
  end if;
  if p_role = 'player' then
    if exists (select 1 from public.pos_shifts s where s.cashier_id = p_user_id and s.closed_at is null) then
      raise exception 'Access: Ask this staff member to close their register shift before removing access.';
    end if;
    delete from public.staff_members where user_id = p_user_id;
  else
    if not confirmed then
      raise exception 'Access: This user must confirm their email before receiving staff access.';
    end if;
    insert into public.staff_members(user_id, role) values (p_user_id, p_role)
      on conflict (user_id) do update set role = excluded.role;
  end if;

  insert into public.pos_audit(actor_id, action, entity_id, detail)
  values (actor, 'access.role_change', p_user_id, jsonb_build_object('from', existing_role, 'to', p_role));
end;
$$;

-- A shift must either open before a role removal checks it or wait and check access again.
create or replace function public.pos_open_shift(p_opening integer)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  shift_id uuid;
begin
  perform 1 from public.staff_members where user_id = auth.uid() for share;
  if not found then raise exception 'POS: Authorized staff access is required.'; end if;
  if p_opening is null or p_opening not between 0 and 100000000 then
    raise exception 'POS: Enter a valid opening cash amount.';
  end if;
  insert into public.pos_shifts(register_id, cashier_id, opening_cents)
  values ('00000000-0000-4000-a000-000000000001', auth.uid(), p_opening) returning id into shift_id;
  insert into public.pos_audit(actor_id, action, entity_id, detail)
  values (auth.uid(), 'shift.open', shift_id, jsonb_build_object('opening_cents', p_opening));
  return shift_id;
exception when unique_violation then
  raise exception 'POS: This register or cashier already has an open shift.';
end;
$$;

revoke all on function public.admin_list_accounts(text,int), public.admin_set_account_role(uuid,text,text)
  from public, anon, authenticated;
grant execute on function public.admin_list_accounts(text,int), public.admin_set_account_role(uuid,text,text)
  to authenticated;

notify pgrst, 'reload schema';
commit;

begin;

create or replace function public.admin_list_accounts(p_query text, p_page int)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  actor_role text := public.club_role();
  query text := lower(btrim(coalesce(p_query, '')));
  page_size constant int := 10;
begin
  if actor_role is null or actor_role not in ('owner', 'manager') then
    raise exception 'Access: Manager or owner authorization is required.';
  end if;
  if length(query) > 254 or p_page is null or p_page < 1 then
    raise exception 'Access: Choose a valid account search and page.';
  end if;

  return (
    with matching as (
      select u.id, u.email, coalesce(s.role, 'player') as role,
        u.email_confirmed_at is not null as email_confirmed
      from auth.users u left join public.staff_members s on s.user_id = u.id
      where u.email <> '' and (query = '' or strpos(lower(u.email), query) > 0)
    ), page as (
      select * from matching order by lower(email), id
      limit page_size offset (p_page::bigint - 1) * page_size
    )
    select jsonb_build_object('row_count', (select count(*) from matching), 'page_size', page_size,
      'rows', coalesce((select jsonb_agg(to_jsonb(page) order by lower(email), id) from page), '[]'::jsonb))
  );
end;
$$;

notify pgrst, 'reload schema';
commit;

begin;

create table private.cashier_assignments (
  duty_date date primary key,
  cashier_id uuid not null references auth.users(id) on delete cascade,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);
alter table private.cashier_assignments enable row level security;
revoke all on private.cashier_assignments from public, anon, authenticated;

create policy "Managers read cashier assignment changes" on public.pos_audit as restrictive
  for select to authenticated using (action <> 'shift.assignment' or (select public.is_staff()));

create function public.pos_register_day(p_date date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  manager boolean := public.is_staff();
begin
  perform private.pos_require_staff();
  if p_date is null or p_date not between date '2000-01-01' and date '2100-12-31' then
    raise exception 'POS: Choose a valid duty date.';
  end if;

  return jsonb_build_object(
    'assignment', (select jsonb_build_object('id', u.id,
       'label', case when manager then u.email else split_part(u.email, '@', 1) end,
       'eligible', coalesce(s.role = 'cashier' and u.email <> '' and u.email_confirmed_at is not null, false))
      from private.cashier_assignments a join auth.users u on u.id = a.cashier_id
      left join public.staff_members s on s.user_id = u.id where a.duty_date = p_date),
    'cashiers', case when manager then (select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'label', u.email)
      order by lower(u.email), u.id), '[]'::jsonb)
      from public.staff_members s join auth.users u on u.id = s.user_id
      where s.role = 'cashier' and u.email <> '' and u.email_confirmed_at is not null) else '[]'::jsonb end,
    'operators', (select coalesce(jsonb_agg(operator order by first_opened), '[]'::jsonb)
      from (select case when manager then u.email else split_part(u.email, '@', 1) end as operator,
          min(s.opened_at) as first_opened
        from public.pos_shifts s join auth.users u on u.id = s.cashier_id
        where s.opened_at >= (p_date::timestamp at time zone 'Asia/Manila')
          and s.opened_at < ((p_date + 1)::timestamp at time zone 'Asia/Manila')
        group by u.id) as operators),
    'active', (select jsonb_build_object('label', case when manager then u.email else split_part(u.email, '@', 1) end,
       'opened_at', s.opened_at, 'own_shift', case when s.cashier_id = auth.uid() then
         to_jsonb(s) || jsonb_build_object('expected_cents', private.pos_expected_cash(s.id, s.opening_cents)) end)
      from public.pos_shifts s join auth.users u on u.id = s.cashier_id where s.closed_at is null limit 1)
  );
end;
$$;

create function public.pos_assign_cashier(p_date date, p_expected uuid, p_cashier uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  previous uuid;
begin
  perform private.pos_require_staff(true);
  if p_date is null or p_date not between date '2000-01-01' and date '2100-12-31' then
    raise exception 'POS: Choose a valid duty date.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('rally-cashier-date:' || p_date::text, 0));
  perform 1 from public.staff_members where user_id = auth.uid() and role in ('manager', 'owner') for share;
  if not found then raise exception 'POS: Manager authorization is required.'; end if;
  select cashier_id into previous from private.cashier_assignments where duty_date = p_date;
  if previous is not distinct from p_cashier then return; end if;
  if previous is distinct from p_expected then
    raise exception 'POS: This day’s assignment changed. Refresh to see the latest assignment.';
  end if;
  if p_cashier is null then
    delete from private.cashier_assignments where duty_date = p_date;
  else
    perform 1 from public.staff_members s join auth.users u on u.id = s.user_id
    where s.user_id = p_cashier and s.role = 'cashier' and u.email <> '' and u.email_confirmed_at is not null
    for share of s;
    if not found then raise exception 'POS: Choose a confirmed account with the Cashier role.'; end if;
    insert into private.cashier_assignments(duty_date, cashier_id, updated_by) values (p_date, p_cashier, auth.uid())
    on conflict (duty_date) do update set cashier_id = excluded.cashier_id, updated_by = excluded.updated_by, updated_at = now();
  end if;
  insert into public.pos_audit(actor_id, action, entity_id, detail)
  values (auth.uid(), 'shift.assignment', p_cashier, jsonb_build_object('date', p_date, 'from', previous, 'to', p_cashier));
end;
$$;

revoke all on function public.pos_register_day(date), public.pos_assign_cashier(date, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.pos_register_day(date), public.pos_assign_cashier(date, uuid, uuid) to authenticated;
notify pgrst, 'reload schema';
commit;

begin;

create function public.pos_overview_trends(p_date date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  history_start timestamptz := (p_date - 6)::timestamp at time zone 'Asia/Manila';
  history_end timestamptz := (p_date + 1)::timestamp at time zone 'Asia/Manila';
begin
  perform private.pos_require_staff();
  if p_date is null or p_date not between date '2000-01-01' and date '2100-12-31' then
    raise exception 'POS: Choose a valid report date.';
  end if;

  return (
    with receipts as (
      select (created_at at time zone 'Asia/Manila')::date as day, amount_cents as amount
      from public.pos_payments where created_at >= history_start and created_at < history_end
      union all
      select (created_at at time zone 'Asia/Manila')::date, -amount_cents
      from public.pos_refunds where created_at >= history_start and created_at < history_end
    ), collected as (
      select day, sum(amount) as total from receipts group by day
    ), retail as (
      select (created_at at time zone 'Asia/Manila')::date as day, sum(total_cents) as total
      from public.pos_sales where kind = 'retail' and created_at >= history_start and created_at < history_end
      group by 1
    ), reservations as (
      select booking_date as day, count(*) as total, sum(round((total_amount - paid_amount) * 100)) as due
      from public.bookings where status = 'confirmed' and booking_date between p_date - 6 and p_date + 30
      group by booking_date
    ), history as (
      select p_date + offset_day as day from generate_series(-6, 0) as offset_day
    ), upcoming as (
      select p_date + offset_day as day from generate_series(0, 30) as offset_day
    )
    select jsonb_build_object(
      'net', jsonb_agg(coalesce(collected.total, 0) order by history.day),
      'reservations', jsonb_agg(coalesce(reservations.total, 0) order by history.day),
      'retail', jsonb_agg(coalesce(retail.total, 0) order by history.day),
      'balances', (select jsonb_agg(coalesce(reservations.due, 0) order by upcoming.day)
        from upcoming left join reservations using (day))
    )
    from history left join collected using (day) left join retail using (day) left join reservations using (day)
  );
end;
$$;

revoke all on function public.pos_overview_trends(date) from public, anon, authenticated;
grant execute on function public.pos_overview_trends(date) to authenticated;
notify pgrst, 'reload schema';
commit;

begin;

create or replace function public.admin_list_accounts(p_query text, p_page int)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  actor_role text := public.club_role();
  query text := lower(btrim(regexp_replace(coalesce(p_query, ''), '[[:space:]]+', ' ', 'g')));
  page_size constant int := 10;
begin
  if actor_role is null or actor_role not in ('owner', 'manager') then
    raise exception 'Access: Manager or owner authorization is required.';
  end if;
  if length(query) > 254 or p_page is null or p_page < 1 then
    raise exception 'Access: Choose a valid account search and page.';
  end if;

  return (
    with accounts as (
      select u.id, u.email, coalesce(s.role, 'player') as role,
        u.email_confirmed_at is not null as email_confirmed,
        case when jsonb_typeof(u.raw_user_meta_data -> 'full_name') = 'string' then
          nullif(left(btrim(regexp_replace(u.raw_user_meta_data ->> 'full_name', '[[:space:]]+', ' ', 'g')), 100), '')
        end as full_name
      from auth.users u left join public.staff_members s on s.user_id = u.id
      where u.email <> ''
    ), matching as (
      select * from accounts
      where query = '' or strpos(lower(email), query) > 0 or strpos(lower(full_name), query) > 0
    ), page as (
      select * from matching order by lower(email), id
      limit page_size offset (p_page::bigint - 1) * page_size
    )
    select jsonb_build_object('row_count', (select count(*) from matching), 'page_size', page_size,
      'rows', coalesce((select jsonb_agg(to_jsonb(page) order by lower(email), id) from page), '[]'::jsonb))
  );
end;
$$;

notify pgrst, 'reload schema';
commit;

begin;

create or replace function public.pos_register_day(p_date date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  manager boolean := public.is_staff();
begin
  perform private.pos_require_staff();
  if p_date is null or p_date not between date '2000-01-01' and date '2100-12-31' then
    raise exception 'POS: Choose a valid duty date.';
  end if;

  return (
    with cashier_accounts as (
      select u.id, u.email,
        case when jsonb_typeof(u.raw_user_meta_data -> 'full_name') = 'string' then
          nullif(left(btrim(regexp_replace(u.raw_user_meta_data ->> 'full_name', '[[:space:]]+', ' ', 'g')), 100), '')
        end as name,
        coalesce(s.role = 'cashier' and u.email <> '' and u.email_confirmed_at is not null, false) as eligible
      from auth.users u left join public.staff_members s on s.user_id = u.id
      where s.role = 'cashier' or u.id = (select cashier_id from private.cashier_assignments where duty_date = p_date)
    )
    select jsonb_build_object(
      'assignment', (select jsonb_build_object('id', u.id, 'name', u.name,
         'label', case when manager then u.email else split_part(u.email, '@', 1) end, 'eligible', u.eligible)
        from private.cashier_assignments a join cashier_accounts u on u.id = a.cashier_id where a.duty_date = p_date),
      'cashiers', case when manager then (select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'label', u.email, 'name', u.name)
        order by lower(coalesce(u.name, u.email)), u.id), '[]'::jsonb)
        from cashier_accounts u where u.eligible) else '[]'::jsonb end,
      'operators', (select coalesce(jsonb_agg(operator order by first_opened), '[]'::jsonb)
        from (select case when manager then u.email else split_part(u.email, '@', 1) end as operator,
            min(s.opened_at) as first_opened
          from public.pos_shifts s join auth.users u on u.id = s.cashier_id
          where s.opened_at >= (p_date::timestamp at time zone 'Asia/Manila')
            and s.opened_at < ((p_date + 1)::timestamp at time zone 'Asia/Manila')
          group by u.id) as operators),
      'active', (select jsonb_build_object('label', case when manager then u.email else split_part(u.email, '@', 1) end,
         'opened_at', s.opened_at, 'own_shift', case when s.cashier_id = auth.uid() then
           to_jsonb(s) || jsonb_build_object('expected_cents', private.pos_expected_cash(s.id, s.opening_cents)) end)
        from public.pos_shifts s join auth.users u on u.id = s.cashier_id where s.closed_at is null limit 1)
    )
  );
end;
$$;

notify pgrst, 'reload schema';
commit;

begin;

-- Operational access always uses the current Philippine day.
create or replace function public.is_club_staff()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.staff_members s
    where s.user_id = auth.uid() and (
      s.role in ('manager', 'owner') or (
        s.role = 'cashier' and not exists (
          select 1 from private.cashier_assignments a
          where a.duty_date = (now() at time zone 'Asia/Manila')::date
            and a.cashier_id <> s.user_id
        )
      )
    )
  );
$$;

create or replace function public.pos_open_shift(p_opening integer)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  shift_id uuid;
  duty_date date := (now() at time zone 'Asia/Manila')::date;
begin
  -- Serialize opening a shift with the assignment change for the same date.
  perform pg_advisory_xact_lock_shared(hashtextextended('rally-cashier-date:' || duty_date::text, 0));
  perform 1 from public.staff_members where user_id = auth.uid() for share;
  if not found then raise exception 'POS: Authorized staff access is required.'; end if;
  if not public.is_club_staff() then
    raise exception 'POS: Another cashier is assigned to the register today.';
  end if;
  if p_opening is null or p_opening not between 0 and 100000000 then
    raise exception 'POS: Enter a valid opening cash amount.';
  end if;
  insert into public.pos_shifts(register_id, cashier_id, opening_cents)
  values ('00000000-0000-4000-a000-000000000001', auth.uid(), p_opening) returning id into shift_id;
  insert into public.pos_audit(actor_id, action, entity_id, detail)
  values (auth.uid(), 'shift.open', shift_id, jsonb_build_object('opening_cents', p_opening));
  return shift_id;
exception when unique_violation then
  raise exception 'POS: This register or cashier already has an open shift.';
end;
$$;

-- During a handover, an off-duty cashier can reconcile their own open drawer.
create function public.pos_own_open_shift()
returns setof public.pos_shifts language sql stable security definer set search_path = '' as $$
  select s.id, s.register_id, s.cashier_id, s.opening_cents, s.opened_at, s.closed_at, s.counted_cents,
    private.pos_expected_cash(s.id, s.opening_cents)
  from public.pos_shifts s
  where s.cashier_id = auth.uid() and s.closed_at is null and public.club_role() = 'cashier';
$$;

create or replace function public.pos_close_shift(p_shift uuid, p_counted integer)
returns void language plpgsql security definer set search_path = '' as $$
declare
  shift public.pos_shifts%rowtype;
  expected bigint;
begin
  perform 1 from public.staff_members where user_id = auth.uid() for share;
  if not found then raise exception 'POS: Authorized staff access is required.'; end if;
  select * into shift from public.pos_shifts where id = p_shift for update;
  if shift.id is null or shift.cashier_id <> auth.uid() or shift.closed_at is not null then
    raise exception 'POS: Only your active shift can be closed.';
  end if;
  if p_counted is null or p_counted not between 0 and 100000000 then
    raise exception 'POS: Enter the cash counted in the drawer.';
  end if;
  expected := private.pos_expected_cash(shift.id, shift.opening_cents);
  update public.pos_shifts set expected_cents = expected, counted_cents = p_counted, closed_at = now() where id = shift.id;
  insert into public.pos_audit(actor_id, action, entity_id, detail)
  values (auth.uid(), 'shift.close', shift.id, jsonb_build_object('expected', expected, 'counted', p_counted, 'variance', p_counted - expected));
end;
$$;

revoke all on function public.pos_own_open_shift() from public, anon, authenticated;
grant execute on function public.pos_own_open_shift() to authenticated;
notify pgrst, 'reload schema';
commit;

begin;

create table public.membership_settings (
  id boolean primary key default true check (id),
  details jsonb,
  revision integer not null default 0 check (revision >= 0)
);
alter table public.membership_settings enable row level security;
revoke all on public.membership_settings from public, anon, authenticated;
grant select on public.membership_settings to anon, authenticated;
create policy "Read published membership details" on public.membership_settings
  for select to anon, authenticated using (true);

-- A null document leaves the plan unpublished until the venue saves its terms.
insert into public.membership_settings default values;

create function public.save_membership_details(p_details jsonb, p_expected_revision integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  saved_revision integer;
begin
  if not public.is_staff() then
    raise exception 'Membership: Manager or owner access is required.';
  end if;

  if jsonb_typeof(p_details) is distinct from 'object'
    or octet_length(p_details::text) > 90000
    or p_expected_revision is null or p_expected_revision < 0
    or jsonb_typeof(p_details->'price_cents') is distinct from 'number'
    or (p_details->>'price_cents') !~ '^(0|[1-9][0-9]{0,6}|10000000)$'
    or jsonb_typeof(p_details->'benefits') is distinct from 'array'
    or exists (select 1 from (values ('plan_name', 80), ('price_period', 24), ('heading', 80),
      ('introduction', 500), ('validity', 500), ('redemption', 500), ('home_summary', 500)) as fields(key, max_length)
      where jsonb_typeof(p_details->fields.key) is distinct from 'string'
         or p_details->>fields.key !~ '[^[:space:]]'
         or length(p_details->>fields.key) > fields.max_length)
  then
    raise exception 'Membership: Enter valid membership details.';
  end if;

  if jsonb_array_length(p_details->'benefits') > 16
    or exists (select 1 from jsonb_array_elements(p_details->'benefits') as benefits(benefit)
      where not coalesce(benefit->>'icon' in ('trophy', 'wallet', 'users', 'calendar', 'check', 'heart', 'gift', 'coaching'), false)
         or jsonb_typeof(benefit->'title') is distinct from 'string'
         or benefit->>'title' !~ '[^[:space:]]' or length(benefit->>'title') > 80
         or jsonb_typeof(benefit->'description') is distinct from 'string'
         or benefit->>'description' !~ '[^[:space:]]' or length(benefit->>'description') > 500)
  then
    raise exception 'Membership: Enter valid membership benefits.';
  end if;

  update public.membership_settings set details = p_details, revision = revision + 1
  where id and revision = p_expected_revision and details is distinct from p_details
  returning revision into saved_revision;
  if found then return saved_revision; end if;

  select revision into saved_revision from public.membership_settings where id and details = p_details;
  if found then return saved_revision; end if;
  raise exception 'Membership: Someone updated the membership details. Reload this page to review the latest version before saving.';
end;
$$;

revoke all on function public.save_membership_details(jsonb, integer) from public, anon, authenticated;
grant execute on function public.save_membership_details(jsonb, integer) to authenticated;
notify pgrst, 'reload schema';

commit;

begin;

-- Keep both plans and their revisions when this migration is run again.
alter table public.membership_settings drop constraint if exists membership_settings_id_check;
insert into public.membership_settings (id) values (false) on conflict (id) do nothing;

create or replace function public.save_membership_plan(p_plan text, p_details jsonb, p_expected_revision integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  annual_plan boolean;
  saved_revision integer;
begin
  if not public.is_staff() then
    raise exception 'Membership: Manager or owner access is required.';
  end if;
  if p_plan is null or p_plan not in ('annual', 'six-month') then
    raise exception 'Membership: Choose a membership plan.';
  end if;
  annual_plan := p_plan = 'annual';

  if jsonb_typeof(p_details) is distinct from 'object'
    or octet_length(p_details::text) > 90000
    or p_expected_revision is null or p_expected_revision < 0
    or jsonb_typeof(p_details->'price_cents') is distinct from 'number'
    or (p_details->>'price_cents') !~ '^(0|[1-9][0-9]{0,6}|10000000)$'
    or jsonb_typeof(p_details->'benefits') is distinct from 'array'
    or exists (select 1 from (values ('plan_name', 80), ('price_period', 24), ('heading', 80),
      ('introduction', 500), ('validity', 500), ('redemption', 500), ('home_summary', 500)) as fields(key, max_length)
      where jsonb_typeof(p_details->fields.key) is distinct from 'string'
         or p_details->>fields.key !~ '[^[:space:]]'
         or length(p_details->>fields.key) > fields.max_length)
  then
    raise exception 'Membership: Enter valid membership details.';
  end if;

  if jsonb_array_length(p_details->'benefits') > 16
    or exists (select 1 from jsonb_array_elements(p_details->'benefits') as benefits(benefit)
      where not coalesce(benefit->>'icon' in ('trophy', 'wallet', 'users', 'calendar', 'check', 'heart', 'gift', 'coaching'), false)
         or jsonb_typeof(benefit->'title') is distinct from 'string'
         or benefit->>'title' !~ '[^[:space:]]' or length(benefit->>'title') > 80
         or jsonb_typeof(benefit->'description') is distinct from 'string'
         or benefit->>'description' !~ '[^[:space:]]' or length(benefit->>'description') > 500)
  then
    raise exception 'Membership: Enter valid membership benefits.';
  end if;

  update public.membership_settings set details = p_details, revision = revision + 1
  where id = annual_plan and revision = p_expected_revision and details is distinct from p_details
  returning revision into saved_revision;
  if found then return saved_revision; end if;

  select revision into saved_revision from public.membership_settings where id = annual_plan and details = p_details;
  if found then return saved_revision; end if;
  raise exception 'Membership: Someone updated this membership plan. Reload this page to review the latest version before saving.';
end;
$$;

-- Keep the original annual-plan entry point for earlier deployments.
create or replace function public.save_membership_details(p_details jsonb, p_expected_revision integer)
returns integer language sql security invoker set search_path = '' as $$
  select public.save_membership_plan('annual', p_details, p_expected_revision);
$$;

revoke all on function public.save_membership_plan(text, jsonb, integer) from public, anon, authenticated;
grant execute on function public.save_membership_plan(text, jsonb, integer) to authenticated;
notify pgrst, 'reload schema';

commit;

begin;

create table public.membership_applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  plan_id text not null check (plan_id in ('annual', 'six-month')),
  plan_name text not null,
  price_cents integer not null check (price_cents between 1 and 10000000),
  status text not null default 'awaiting_payment' check (status in ('awaiting_payment', 'pending', 'approved', 'rejected')),
  gcash_name text not null,
  gcash_number text not null,
  gcash_qr_url text not null,
  payment_reference text,
  created_at timestamptz not null default now(),
  submitted_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id) on delete set null,
  review_note text,
  starts_on date,
  expires_on date,
  check ((status = 'awaiting_payment') = (payment_reference is null)),
  check ((status = 'awaiting_payment') = (submitted_at is null)),
  check ((status in ('approved', 'rejected')) = (reviewed_at is not null)),
  check ((status = 'approved') = (starts_on is not null and expires_on is not null)),
  check (expires_on is null or expires_on > starts_on)
);
create unique index membership_open_application_per_user on public.membership_applications (user_id)
  where status in ('awaiting_payment', 'pending');
create unique index membership_approved_reference on public.membership_applications
  (lower(regexp_replace(payment_reference,'[^a-zA-Z0-9]','','g'))) where status = 'approved';
create index membership_application_history on public.membership_applications (user_id, created_at desc, id);
create index membership_application_queue on public.membership_applications (status, submitted_at, id);
alter table public.membership_applications enable row level security;
revoke all on public.membership_applications from public, anon, authenticated;
grant select on public.membership_applications to authenticated;
create policy "Customers read their membership applications" on public.membership_applications
  for select to authenticated using (user_id = (select auth.uid()));

-- Only verified membership payments participate in the shared reference guard.
create or replace function private.pos_check_reference(p_reference text,p_booking uuid default null) returns void language plpgsql security definer set search_path='' as $$
declare normalized text;begin
 if p_reference is null or p_reference !~ '^[a-zA-Z0-9 -]{6,40}$' then raise exception 'POS: Enter a valid GCash reference (6–40 characters).';end if;
 normalized:=lower(regexp_replace(p_reference,'[^a-zA-Z0-9]','','g'));
 if length(normalized)<6 then raise exception 'POS: Enter a valid GCash reference.';end if;
 perform pg_advisory_xact_lock(hashtextextended('rally-payment:'||normalized,0));
 if exists(select 1 from public.pos_payments where method='gcash' and lower(regexp_replace(reference,'[^a-zA-Z0-9]','','g'))=normalized)
 or exists(select 1 from public.bookings where (p_booking is null or id<>p_booking) and
 (lower(regexp_replace(payment_reference,'[^a-zA-Z0-9]','','g'))=normalized or lower(regexp_replace(balance_payment_reference,'[^a-zA-Z0-9]','','g'))=normalized))
 or exists(select 1 from public.membership_applications where status = 'approved' and
    lower(regexp_replace(payment_reference,'[^a-zA-Z0-9]','','g')) = normalized)
 then raise exception 'POS: This GCash reference is already recorded or submitted.';end if;
end;$$;

create function public.start_membership_application(p_plan text, p_expected_revision integer)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  current_application public.membership_applications%rowtype;
  plan public.membership_settings%rowtype;
  venue public.venue_settings%rowtype;
  application_id uuid;
  fee integer;
  label text;
  today date := (now() at time zone 'Asia/Manila')::date;
begin
  if actor is null then raise exception 'Membership: Sign in to apply.'; end if;
  if p_plan is null or p_plan not in ('annual', 'six-month') then
    raise exception 'Membership: Choose a membership plan.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('rally-membership:' || actor::text, 0));
  select * into current_application from public.membership_applications
    where user_id = actor and status in ('awaiting_payment', 'pending') for update;
  if found then return current_application.id; end if;
  if exists (select 1 from public.membership_applications where user_id = actor and status = 'approved' and expires_on > today) then
    raise exception 'Membership: You already have an active membership.';
  end if;

  select * into plan from public.membership_settings where id = (p_plan = 'annual') for share;
  if not found or plan.details is null then
    raise exception 'Membership: This plan is not available for online applications yet.';
  end if;
  if plan.revision is distinct from p_expected_revision then
    raise exception 'Membership: The plan has changed. Reload this page to check the latest price before paying.';
  end if;
  fee := (plan.details->>'price_cents')::integer;
  label := plan.details->>'plan_name';
  if coalesce(fee, 0) <= 0 then raise exception 'Membership: Contact the venue to apply for this plan.'; end if;

  select * into venue from public.venue_settings where id for share;
  if nullif(btrim(venue.gcash_name), '') is null
    or (nullif(btrim(venue.gcash_number), '') is null and nullif(btrim(venue.gcash_qr_url), '') is null) then
    raise exception 'Membership: GCash payment details are unavailable. Contact the venue before paying.';
  end if;
  insert into public.membership_applications (user_id, plan_id, plan_name, price_cents, gcash_name, gcash_number, gcash_qr_url)
    values (actor, p_plan, label, fee, venue.gcash_name, venue.gcash_number, venue.gcash_qr_url)
    returning id into application_id;
  return application_id;
end;
$$;

create function public.submit_membership_payment(p_application uuid, p_reference text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  application public.membership_applications%rowtype;
  reference text := btrim(p_reference);
  normalized text := lower(regexp_replace(reference,'[^a-zA-Z0-9]','','g'));
begin
  if auth.uid() is null then raise exception 'Membership: Sign in to submit a payment.'; end if;
  if reference is null or reference !~ '^[a-zA-Z0-9 -]{6,40}$' or length(normalized) < 6 then
    raise exception 'Membership: Enter a valid GCash reference number.';
  end if;
  select * into application from public.membership_applications
    where id = p_application and user_id = auth.uid() for update;
  if not found then raise exception 'Membership: Application could not be found.'; end if;
  if application.status in ('pending', 'approved') and
    lower(regexp_replace(application.payment_reference,'[^a-zA-Z0-9]','','g')) = normalized then return; end if;
  if application.status <> 'awaiting_payment' then
    raise exception 'Membership: This application has already been submitted.';
  end if;
  update public.membership_applications set status = 'pending', payment_reference = reference, submitted_at = now()
    where id = application.id;
end;
$$;

create function public.cancel_membership_application(p_application uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Membership: Sign in to manage your application.'; end if;
  delete from public.membership_applications where id = p_application and user_id = auth.uid() and status = 'awaiting_payment';
  if not found and exists (select 1 from public.membership_applications where id = p_application and user_id = auth.uid()) then
    raise exception 'Membership: This application already has a payment under review.';
  end if;
end;
$$;

create function public.review_membership_payment(p_application uuid, p_approve boolean, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  application public.membership_applications%rowtype;
  reason text := btrim(p_reason);
  today date := (now() at time zone 'Asia/Manila')::date;
begin
  perform private.pos_require_staff();
  if p_approve is null or (not p_approve and (reason is null or char_length(reason) not between 3 and 200)) then
    raise exception 'Membership: Enter a rejection reason between 3 and 200 characters.';
  end if;
  select * into application from public.membership_applications where id = p_application for update;
  if not found then raise exception 'Membership: Application could not be found.'; end if;
  if (p_approve and application.status = 'approved') or (not p_approve and application.status = 'rejected') then return; end if;
  if application.status <> 'pending' then raise exception 'Membership: This application is no longer pending.'; end if;

  if p_approve then
    if application.user_id is null then raise exception 'Membership: This customer account has been removed.'; end if;
    perform private.pos_check_reference(application.payment_reference);
    update public.membership_applications set status = 'approved', starts_on = today,
      expires_on = (today + make_interval(months => case when application.plan_id = 'annual' then 12 else 6 end))::date,
      reviewed_at = now(), reviewed_by = auth.uid()
      where id = application.id;
  else
    update public.membership_applications set status = 'rejected', review_note = reason, reviewed_at = now(), reviewed_by = auth.uid()
      where id = application.id;
  end if;
end;
$$;

create function public.list_membership_applications(p_reviewed boolean, p_page integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.pos_require_staff();
  if p_reviewed is null or p_page is null or p_page < 1 then raise exception 'Membership: Choose a valid review page.'; end if;
  return (
    with filtered as (
      select a.id, a.plan_name, a.price_cents, a.payment_reference, a.status, a.submitted_at, a.reviewed_at,
        a.review_note, a.starts_on, a.expires_on, a.gcash_name, a.gcash_number,
        u.email, nullif(left(btrim(u.raw_user_meta_data->>'full_name'), 100), '') as full_name
      from public.membership_applications a left join auth.users u on u.id = a.user_id
      where (not p_reviewed and a.status = 'pending') or (p_reviewed and a.status in ('approved', 'rejected'))
    ), page as (
      select * from filtered
      order by coalesce(reviewed_at, submitted_at) desc, id desc
      limit 10 offset (p_page::bigint - 1) * 10
    )
    select jsonb_build_object('row_count', (select count(*) from filtered),
      'rows', coalesce((select jsonb_agg(to_jsonb(page) order by coalesce(reviewed_at, submitted_at) desc, id desc) from page), '[]'::jsonb))
  );
end;
$$;

revoke all on function public.start_membership_application(text, integer),
  public.submit_membership_payment(uuid, text), public.cancel_membership_application(uuid),
  public.review_membership_payment(uuid, boolean, text), public.list_membership_applications(boolean, integer)
  from public, anon, authenticated;
grant execute on function public.start_membership_application(text, integer),
  public.submit_membership_payment(uuid, text), public.cancel_membership_application(uuid),
  public.review_membership_payment(uuid, boolean, text), public.list_membership_applications(boolean, integer)
  to authenticated;
notify pgrst, 'reload schema';
commit;

begin;

create table private.membership_request_limits (
  user_id uuid not null references auth.users(id) on delete cascade,
  action text not null check (action in ('start', 'submit', 'cancel')),
  attempts timestamptz[] not null default '{}',
  primary key (user_id, action),
  check (cardinality(attempts) <= 5)
);
alter table private.membership_request_limits enable row level security;
revoke all on private.membership_request_limits from public, anon, authenticated;

create function public.request_customer_membership(p_action text, p_input jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  attempted_at timestamptz;
  recent timestamptz[];
  retry_seconds integer;
  failure text;
begin
  if actor is null then
    return jsonb_build_object('error', 'Sign in to continue.', 'code', 'AUTH_REQUIRED');
  end if;
  if p_action is null or p_action not in ('start', 'submit', 'cancel') then
    return jsonb_build_object('error', 'Choose a valid membership action.', 'code', 'INVALID_INPUT');
  end if;

  insert into private.membership_request_limits (user_id, action) values (actor, p_action)
    on conflict do nothing;
  -- A row lock shares each action allowance across browser tabs and app servers.
  select attempts into recent from private.membership_request_limits
    where user_id = actor and action = p_action for update;
  attempted_at := clock_timestamp();
  select coalesce(array_agg(attempt order by attempt), '{}'::timestamptz[]) into recent
    from unnest(recent) attempt where attempt > attempted_at - interval '10 minutes';
  if cardinality(recent) >= 5 then
    retry_seconds := greatest(1, ceil(extract(epoch from recent[1] + interval '10 minutes' - attempted_at))::integer);
    return jsonb_build_object(
      'error', 'Too many membership requests. Please try again in ' || ceil(retry_seconds / 60.0)::integer ||
        case when retry_seconds <= 60 then ' minute.' else ' minutes.' end,
      'code', 'RATE_LIMITED', 'retry_after_seconds', retry_seconds
    );
  end if;
  update private.membership_request_limits set attempts = array_append(recent, attempted_at)
    where user_id = actor and action = p_action;

  -- Returning failures from this block preserves the attempt above.
  begin
    if jsonb_typeof(p_input) is distinct from 'object' then
      return jsonb_build_object('error', 'Check the application details and try again.', 'code', 'INVALID_INPUT');
    end if;
    case p_action
      when 'start' then
        perform public.start_membership_application(p_input->>'plan', (p_input->>'revision')::integer);
      when 'submit' then
        perform public.submit_membership_payment((p_input->>'id')::uuid, p_input->>'reference');
      when 'cancel' then
        perform public.cancel_membership_application((p_input->>'id')::uuid);
    end case;
    return jsonb_build_object('success', true);
  exception when others then
    get stacked diagnostics failure = message_text;
    if left(failure, 12) = 'Membership: ' then
      return jsonb_build_object('error', substr(failure, 13), 'code', 'REQUEST_REJECTED');
    end if;
    if sqlstate like '22%' then
      return jsonb_build_object('error', 'Check the application details and try again.', 'code', 'INVALID_INPUT');
    end if;
    return jsonb_build_object('error', 'The membership application couldn’t be updated. Please try again.', 'code', 'REQUEST_REJECTED');
  end;
end;
$$;

-- Keep the original operations callable by the definer function only.
revoke all on function public.start_membership_application(text, integer),
  public.submit_membership_payment(uuid, text), public.cancel_membership_application(uuid),
  public.request_customer_membership(text, jsonb) from public, anon, authenticated;
grant execute on function public.request_customer_membership(text, jsonb) to authenticated;

notify pgrst, 'reload schema';
commit;

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

begin;

alter table public.pos_sales
  drop constraint pos_sales_kind_check,
  drop constraint pos_sales_check1,
  add constraint pos_sales_kind_check check (kind in ('booking', 'retail', 'membership')),
  add constraint pos_sales_booking_link check ((kind = 'booking') = (booking_id is not null));

alter table public.membership_applications
  add column pos_sale_id uuid unique references public.pos_sales(id),
  add column payment_method text not null default 'gcash' check (payment_method in ('cash', 'gcash')),
  drop constraint membership_applications_status_check,
  drop constraint membership_applications_check,
  drop constraint membership_applications_check2,
  drop constraint membership_applications_check3,
  add constraint membership_applications_status_check
    check (status in ('awaiting_payment', 'pending', 'approved', 'rejected', 'refunded')),
  add constraint membership_payment_reference_check
    check ((status = 'awaiting_payment' or payment_method = 'cash') = (payment_reference is null)),
  add constraint membership_review_check
    check ((status in ('approved', 'rejected', 'refunded')) = (reviewed_at is not null)),
  add constraint membership_term_check
    check ((status in ('approved', 'refunded')) = (starts_on is not null and expires_on is not null)),
  add constraint membership_sale_link check (
    (payment_method <> 'cash' or pos_sale_id is not null)
    and (pos_sale_id is null or status in ('approved', 'refunded'))
    and (status <> 'refunded' or pos_sale_id is not null)
  );

create function public.pos_find_membership_customers(p_query text)
returns table (id uuid, full_name text, email text, availability text)
language plpgsql stable security definer set search_path = '' as $$
declare
  search text := lower(btrim(p_query));
begin
  perform private.pos_require_staff();
  if search is null or length(search) not between 2 and 254 then
    raise exception 'Membership: Enter at least two characters of a name or the full email address.';
  end if;
  return query
    select u.id, nullif(left(btrim(u.raw_user_meta_data->>'full_name'), 100), ''),
      case when lower(u.email) = search then u.email::text
        else left(u.email, 1) || '•••@' || left(split_part(u.email, '@', 2), 1) || '•••'
      end,
      case
        when exists (select 1 from public.membership_applications a where a.user_id = u.id and a.status = 'pending') then 'pending'
        when exists (select 1 from public.membership_applications a where a.user_id = u.id and a.status = 'approved'
          and a.expires_on > (now() at time zone 'Asia/Manila')::date) then 'active'
        else 'available'
      end
    from auth.users u
    where u.email_confirmed_at is not null and nullif(btrim(u.email), '') is not null
      and (lower(u.email) = search
        or strpos(lower(left(btrim(u.raw_user_meta_data->>'full_name'), 100)), search) > 0)
    order by (lower(u.email) = search) desc, u.email, u.id
    limit 10;
end;
$$;

create function public.pos_sell_membership(
  p_key uuid, p_customer uuid, p_plan text, p_revision integer, p_method text,
  p_received integer, p_reference text, p_verified boolean
) returns table (
  receipt_number text, plan_name text, price_cents integer, starts_on date, expires_on date, status text
) language plpgsql security definer set search_path = '' as $$
declare
  today date := (now() at time zone 'Asia/Manila')::date;
  reference text := nullif(btrim(p_reference), '');
  sale_request jsonb;
  sale public.pos_sales%rowtype;
  application public.membership_applications%rowtype;
  plan public.membership_settings%rowtype;
  venue public.venue_settings%rowtype;
  customer_name text;
  label text;
  fee integer;
  expiry date;
  shift_id uuid;
begin
  perform pg_advisory_xact_lock_shared(hashtextextended('rally-cashier-date:' || today::text, 0));
  perform 1 from public.staff_members where user_id = auth.uid() for share;
  if not found then raise exception 'POS: Authorized staff access is required.'; end if;
  perform private.pos_require_staff();
  if p_key is null or p_customer is null or p_plan is null or p_plan not in ('annual', 'six-month')
    or p_revision is null or p_revision < 0 then
    raise exception 'Membership: Choose a customer and membership plan.';
  end if;
  if p_method is null or p_method not in ('cash', 'gcash') or p_received is null
    or p_received not between 1 and 100000000 then
    raise exception 'Membership: Enter a valid payment amount.';
  end if;
  if (p_method = 'gcash' and (p_verified is distinct from true or reference is null or length(reference) > 40))
    or (p_method = 'cash' and reference is not null) then
    raise exception 'Membership: Verify the GCash payment and enter its reference.';
  end if;

  sale_request := jsonb_build_object('customer', p_customer, 'plan', p_plan, 'revision', p_revision,
    'method', p_method, 'received', p_received, 'reference', reference);
  perform pg_advisory_xact_lock(hashtextextended('rally-checkout:' || p_key::text, 0));
  select * into sale from public.pos_sales where id = p_key;
  if found then
    if sale.kind <> 'membership' or sale.cashier_id is distinct from auth.uid()
      or sale.request is distinct from sale_request then
      raise exception 'POS: This checkout key was already used. Check Transactions before starting another sale.';
    end if;
  else
    -- Serialize with customer applications and lock any draft or payment under review.
    perform pg_advisory_xact_lock(hashtextextended('rally-membership:' || p_customer::text, 0));
    select coalesce(nullif(left(btrim(u.raw_user_meta_data->>'full_name'), 100), ''), 'Membership customer')
      into customer_name from auth.users u
      where u.id = p_customer and u.email_confirmed_at is not null and nullif(btrim(u.email), '') is not null for share;
    if not found then raise exception 'Membership: Select a customer with a confirmed email address.'; end if;

    select * into application from public.membership_applications a
      where a.user_id = p_customer and a.status in ('awaiting_payment', 'pending') for update;
    if application.status = 'pending' then
      raise exception 'Membership: Review this customer’s online GCash payment before taking another payment.';
    end if;
    if exists (select 1 from public.membership_applications a
      where a.user_id = p_customer and a.status = 'approved' and a.expires_on > today) then
      raise exception 'Membership: This customer already has an active membership.';
    end if;

    select * into plan from public.membership_settings where id = (p_plan = 'annual') for share;
    if not found or plan.details is null then
      raise exception 'Membership: This plan is not available for sale yet.';
    end if;
    if plan.revision <> p_revision then
      raise exception 'Membership: The plan changed. Refresh the page and check the current price before taking payment.';
    end if;
    fee := (plan.details->>'price_cents')::integer;
    label := plan.details->>'plan_name';
    expiry := (today + make_interval(months => case when p_plan = 'annual' then 12 else 6 end))::date;
    if coalesce(fee, 0) <= 0 then raise exception 'Membership: The selected plan has no sale price.'; end if;
    if p_method = 'cash' then
      if p_received < fee then raise exception 'Membership: Cash received must cover the full membership fee.'; end if;
      shift_id := private.pos_open_shift_lock();
    else
      if p_received <> fee then raise exception 'Membership: Verify a GCash payment for the full membership fee.'; end if;
      select * into venue from public.venue_settings where id for share;
      if nullif(btrim(venue.gcash_name), '') is null
        or (nullif(btrim(venue.gcash_number), '') is null and nullif(btrim(venue.gcash_qr_url), '') is null) then
        raise exception 'Membership: The venue’s GCash payment details are unavailable.';
      end if;
    end if;

    insert into public.pos_sales (id, kind, customer_name, total_cents, cashier_id, request)
      values (p_key, 'membership', customer_name, fee, auth.uid(), sale_request);
    insert into public.pos_sale_items (sale_id, name, quantity, price_cents, cost_cents)
      values (p_key, label, 1, fee, 0);
    -- Record the payment first so the shared reference guard does not see its own approval.
    perform private.pos_add_payment(p_key, fee, p_method, reference, shift_id);

    insert into public.membership_applications (id, user_id, plan_id, plan_name, price_cents, status,
        gcash_name, gcash_number, gcash_qr_url, payment_reference, payment_method, pos_sale_id,
        submitted_at, reviewed_at, reviewed_by, starts_on, expires_on)
      values (coalesce(application.id, gen_random_uuid()), p_customer, p_plan, label, fee, 'approved',
        coalesce(venue.gcash_name, ''), coalesce(venue.gcash_number, ''), coalesce(venue.gcash_qr_url, ''),
        reference, p_method, p_key, now(), now(), auth.uid(), today, expiry)
      on conflict on constraint membership_applications_pkey do update set
        plan_id = excluded.plan_id, plan_name = excluded.plan_name, price_cents = excluded.price_cents,
        status = excluded.status, gcash_name = excluded.gcash_name, gcash_number = excluded.gcash_number,
        gcash_qr_url = excluded.gcash_qr_url, payment_reference = excluded.payment_reference,
        payment_method = excluded.payment_method, pos_sale_id = excluded.pos_sale_id, submitted_at = excluded.submitted_at,
        reviewed_at = excluded.reviewed_at, reviewed_by = excluded.reviewed_by,
        starts_on = excluded.starts_on, expires_on = excluded.expires_on;

    insert into public.pos_audit (actor_id, action, entity_id, detail)
      values (auth.uid(), 'membership.sale', p_key, jsonb_build_object('plan', p_plan, 'total_cents', fee, 'method', p_method));
  end if;

  return query select s.number, a.plan_name, a.price_cents, a.starts_on, a.expires_on, a.status
    from public.membership_applications a join public.pos_sales s on s.id = a.pos_sale_id
    where s.id = p_key;
end;
$$;

create function private.pos_refund_membership() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.membership_applications set status = 'refunded' where pos_sale_id = new.id and status = 'approved';
  return new;
end;
$$;

create trigger refund_membership after update of status on public.pos_sales for each row
when (old.status = 'completed' and new.status = 'refunded' and new.kind = 'membership')
execute function private.pos_refund_membership();

create or replace function public.list_membership_applications(p_reviewed boolean, p_page integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.pos_require_staff();
  if p_reviewed is null or p_page is null or p_page < 1 then raise exception 'Membership: Choose a valid review page.'; end if;
  return (
    with filtered as (
      select a.id, a.plan_name, a.price_cents, a.payment_reference, a.status, a.submitted_at, a.reviewed_at,
        a.review_note, a.starts_on, a.expires_on, a.gcash_name, a.gcash_number, a.payment_method, s.number as receipt_number,
        case when a.pos_sale_id is not null and public.club_role() = 'cashier'
          then left(u.email, 1) || '•••@' || left(split_part(u.email, '@', 2), 1) || '•••'
          else u.email
        end as email,
        nullif(left(btrim(u.raw_user_meta_data->>'full_name'), 100), '') as full_name
      from public.membership_applications a left join auth.users u on u.id = a.user_id
      left join public.pos_sales s on s.id = a.pos_sale_id
      where (not p_reviewed and a.status = 'pending') or (p_reviewed and a.status in ('approved', 'rejected', 'refunded'))
    ), page as (
      select * from filtered
      order by coalesce(reviewed_at, submitted_at) desc, id desc
      limit 10 offset (p_page::bigint - 1) * 10
    )
    select jsonb_build_object('row_count', (select count(*) from filtered),
      'rows', coalesce((select jsonb_agg(to_jsonb(page) order by coalesce(reviewed_at, submitted_at) desc, id desc) from page), '[]'::jsonb))
  );
end;
$$;

revoke all on function private.pos_refund_membership(), public.pos_find_membership_customers(text),
  public.pos_sell_membership(uuid, uuid, text, integer, text, integer, text, boolean) from public, anon, authenticated;
grant execute on function public.pos_find_membership_customers(text),
  public.pos_sell_membership(uuid, uuid, text, integer, text, integer, text, boolean) to authenticated;

notify pgrst, 'reload schema';
commit;

begin;

create function public.list_active_memberships(p_page integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  today date := (now() at time zone 'Asia/Manila')::date;
begin
  perform private.pos_require_staff();
  if p_page is null or p_page < 1 then raise exception 'Membership: Choose a valid page.'; end if;

  return (
    with active as (
      select distinct on (a.user_id) a.id, a.user_id, a.plan_name, a.starts_on, a.expires_on, a.pos_sale_id
      from public.membership_applications a
      where a.user_id is not null and a.status = 'approved'
        and a.starts_on <= today and today < a.expires_on
      order by a.user_id, a.starts_on desc, a.reviewed_at desc, a.id desc
    ), page as (
      select a.id, a.plan_name, a.starts_on, a.expires_on,
        nullif(left(btrim(u.raw_user_meta_data->>'full_name'), 100), '') as full_name,
        case when a.pos_sale_id is not null and public.club_role() = 'cashier'
          then left(u.email, 1) || '•••@' || left(split_part(u.email, '@', 2), 1) || '•••'
          else u.email
        end as email
      from active a join auth.users u on u.id = a.user_id
      order by a.expires_on, a.id
      limit 10 offset (p_page::bigint - 1) * 10
    )
    select jsonb_build_object('row_count', (select count(*) from active),
      'rows', coalesce((select jsonb_agg(to_jsonb(page) order by expires_on, id) from page), '[]'::jsonb))
  );
end;
$$;

revoke all on function public.list_active_memberships(integer) from public, anon, authenticated;
grant execute on function public.list_active_memberships(integer) to authenticated;
notify pgrst, 'reload schema';

commit;

begin;

alter table public.pos_products add column photo_version uuid unique;

create table private.pos_product_photos (
  product_id uuid primary key references public.pos_products(id) on delete cascade,
  content bytea not null check (octet_length(content) between 5 and 524288)
);
alter table private.pos_product_photos enable row level security;
revoke all on private.pos_product_photos from public, anon, authenticated;

create function public.pos_save_product_with_photo(p_product jsonb, p_photo text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  saved_id uuid;
  photo_bytes bytea;
begin
  perform private.pos_require_staff(true);
  if p_product->>'id' is not null and p_product->>'revision' is null then
    raise exception 'POS: Reload this product before saving.';
  end if;

  if p_photo is not null then
    if length(p_photo) not between 8 and 699052 or length(p_photo) % 4 <> 0
      or p_photo !~ '^[a-zA-Z0-9+/]+={0,2}$' then
      raise exception 'POS: Choose a valid product photo.';
    end if;
    photo_bytes := decode(p_photo, 'base64');
    if octet_length(photo_bytes) not between 5 and 524288
      or substring(photo_bytes from 1 for 3) <> decode('ffd8ff', 'hex')
      or substring(photo_bytes from octet_length(photo_bytes) - 1) <> decode('ffd9', 'hex') then
      raise exception 'POS: Choose a valid product photo.';
    end if;
  end if;

  -- Save the product, audit event and photo in one transaction using the existing revision check.
  saved_id := public.pos_save_product(p_product);
  if photo_bytes is null then
    delete from private.pos_product_photos where product_id = saved_id;
    update public.pos_products set photo_version = null where id = saved_id;
  else
    insert into private.pos_product_photos (product_id, content) values (saved_id, photo_bytes)
      on conflict on constraint pos_product_photos_pkey do update set content = excluded.content;
    update public.pos_products set photo_version = gen_random_uuid() where id = saved_id;
  end if;
  return saved_id;
end;
$$;

create function public.pos_product_photo(p_version uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.pos_require_staff();
  return (select encode(photo.content, 'base64')
    from public.pos_products p join private.pos_product_photos photo on photo.product_id = p.id
    where p.photo_version = p_version);
end;
$$;

revoke all on function public.pos_save_product_with_photo(jsonb, text), public.pos_product_photo(uuid) from public, anon, authenticated;
grant execute on function public.pos_save_product_with_photo(jsonb, text), public.pos_product_photo(uuid) to authenticated;
notify pgrst, 'reload schema';

commit;

begin;

alter table public.membership_settings
  add column court_discount_enabled boolean not null default false,
  add column court_discount_cents integer not null default 1 check (court_discount_cents between 1 and 10000000),
  add column court_discount_min_hours integer not null default 1
    check (court_discount_min_hours between 1 and 4 and (id or court_discount_min_hours = 1)),
  add column court_discount_revision integer not null default 0 check (court_discount_revision >= 0);

create function public.save_membership_court_discount(
  p_plan text, p_enabled boolean, p_amount_cents integer, p_min_hours integer, p_expected_revision integer
) returns integer language plpgsql security definer set search_path = '' as $$
declare
  annual_plan boolean;
  saved_revision integer;
begin
  if not public.is_staff() then raise exception 'Membership: Manager or owner access is required.'; end if;
  if p_plan is null or p_plan not in ('annual', 'six-month') then raise exception 'Membership: Choose a membership plan.'; end if;
  annual_plan := p_plan = 'annual';
  if p_enabled is null or p_amount_cents is null or p_amount_cents not between 1 and 10000000
    or p_min_hours is null or p_min_hours not between 1 and 4 or (not annual_plan and p_min_hours <> 1)
    or p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'Membership: Enter a valid court discount and minimum duration.';
  end if;

  update public.membership_settings
    set court_discount_enabled = p_enabled, court_discount_cents = p_amount_cents,
      court_discount_min_hours = p_min_hours, court_discount_revision = court_discount_revision + 1
    where id = annual_plan and court_discount_revision = p_expected_revision
      and (court_discount_enabled, court_discount_cents, court_discount_min_hours)
        is distinct from (p_enabled, p_amount_cents, p_min_hours)
    returning court_discount_revision into saved_revision;
  if found then return saved_revision; end if;

  select court_discount_revision into saved_revision from public.membership_settings
    where id = annual_plan and (court_discount_enabled, court_discount_cents, court_discount_min_hours)
      = (p_enabled, p_amount_cents, p_min_hours);
  if found then return saved_revision; end if;
  raise exception 'Membership: Someone updated this discount. Reload before saving.';
end;
$$;

create or replace function private.private_booking_member_discount(
  p_actor uuid, p_venue public.venue_settings, p_date date, p_start integer, p_duration integer, p_subtotal numeric
) returns numeric language plpgsql stable set search_path = '' as $$
declare
  plan text;
  enabled boolean;
  amount numeric;
  min_hours integer;
  discount numeric;
begin
  if p_actor is null or p_subtotal is null or p_subtotal <= 0 then return 0; end if;
  select plan_id into plan from public.membership_applications
    where user_id = p_actor and status = 'approved'
      and starts_on <= (now() at time zone 'Asia/Manila')::date
      and starts_on <= p_date and p_date < expires_on
    order by starts_on desc, reviewed_at desc, id desc limit 1;
  if not found then return 0; end if;

  select court_discount_enabled, court_discount_cents / 100.0, court_discount_min_hours
    into enabled, amount, min_hours from public.membership_settings where id = (plan = 'annual');
  if not coalesce(enabled, false) then return 0; end if;

  if plan = 'annual' then
    if p_duration >= min_hours then
      return least(amount, greatest(p_subtotal - 0.01, 0));
    end if;
    return 0;
  end if;

  select coalesce(sum(greatest(block.rate - amount, 0) *
    greatest(least(block.end_hour, p_start + p_duration) -
      greatest(block.start_hour, p_start, p_venue.evening_start_hour), 0)), 0)
    into discount
    from public.resolve_schedule_blocks(to_jsonb(p_venue), p_date) block
    where block.kind = 'court' and block.start_hour < p_start + p_duration and block.end_hour > p_start;
  return discount;
end;
$$;

revoke all on function public.save_membership_court_discount(text, boolean, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.save_membership_court_discount(text, boolean, integer, integer, integer) to authenticated;
notify pgrst, 'reload schema';

commit;

begin;

alter table public.membership_settings rename column court_discount_cents to court_booking_discount_cents;
alter table public.membership_settings
  drop constraint membership_settings_check,
  add constraint membership_settings_court_discount_min_hours_check check (court_discount_min_hours between 1 and 4);

-- Start the six-month plan with the annual amount and minimum, while retaining
-- whether it offered a court discount. A manually applied 040 may have a daytime cap.
update public.membership_settings as six
set court_discount_enabled = six.court_discount_enabled or (to_jsonb(six)->>'court_daytime_cap_cents') is not null,
  court_booking_discount_cents = annual.court_booking_discount_cents,
  court_discount_min_hours = annual.court_discount_min_hours,
  court_discount_revision = six.court_discount_revision + 1
from public.membership_settings as annual
where not six.id and annual.id
  and (six.court_discount_enabled or (to_jsonb(six)->>'court_daytime_cap_cents') is not null);

drop function if exists public.save_six_month_court_rates(boolean, integer, integer, integer);
alter table public.membership_settings drop column if exists court_daytime_cap_cents;

create function public.save_membership_booking_discount(
  p_plan text, p_enabled boolean, p_amount_cents integer, p_min_hours integer, p_expected_revision integer
) returns integer language plpgsql security definer set search_path = '' as $$
declare
  annual_plan boolean;
  saved_revision integer;
begin
  if not public.is_staff() then raise exception 'Membership: Manager or owner access is required.'; end if;
  if p_plan is null or p_plan not in ('annual', 'six-month') then raise exception 'Membership: Choose a membership plan.'; end if;
  annual_plan := p_plan = 'annual';
  if p_enabled is null or p_amount_cents is null or p_amount_cents not between 1 and 10000000
    or p_min_hours is null or p_min_hours not between 1 and 4 or p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'Membership: Enter a valid court discount and minimum duration.';
  end if;

  update public.membership_settings
    set court_discount_enabled = p_enabled, court_booking_discount_cents = p_amount_cents,
      court_discount_min_hours = p_min_hours, court_discount_revision = court_discount_revision + 1
    where id = annual_plan and court_discount_revision = p_expected_revision
      and (court_discount_enabled, court_booking_discount_cents, court_discount_min_hours)
        is distinct from (p_enabled, p_amount_cents, p_min_hours)
    returning court_discount_revision into saved_revision;
  if found then return saved_revision; end if;

  select court_discount_revision into saved_revision from public.membership_settings
    where id = annual_plan and (court_discount_enabled, court_booking_discount_cents, court_discount_min_hours)
      = (p_enabled, p_amount_cents, p_min_hours);
  if found then return saved_revision; end if;
  raise exception 'Membership: Someone updated this discount. Reload before saving.';
end;
$$;

-- Keep the annual API available. Older tabs cannot save an hourly rate as a booking discount.
create or replace function public.save_membership_court_discount(
  p_plan text, p_enabled boolean, p_amount_cents integer, p_min_hours integer, p_expected_revision integer
) returns integer language plpgsql security invoker set search_path = '' as $$
begin
  if p_plan = 'six-month' then raise exception 'Membership: Reload to edit the six-month booking discount.'; end if;
  return public.save_membership_booking_discount(p_plan, p_enabled, p_amount_cents, p_min_hours, p_expected_revision);
end;
$$;

create or replace function private.private_booking_member_discount(
  p_actor uuid, p_venue public.venue_settings, p_date date, p_start integer, p_duration integer, p_subtotal numeric
) returns numeric language plpgsql stable set search_path = '' as $$
declare
  amount numeric;
begin
  if p_actor is null or p_subtotal is null or p_subtotal <= 0 then return 0; end if;

  select settings.court_booking_discount_cents / 100.0 into amount
    from public.membership_settings settings
    join lateral (
      select application.plan_id from public.membership_applications application
        where application.user_id = p_actor and application.status = 'approved'
          and application.starts_on <= (now() at time zone 'Asia/Manila')::date
          and application.starts_on <= p_date and p_date < application.expires_on
        order by application.starts_on desc, application.reviewed_at desc, application.id desc limit 1
    ) as active on settings.id = (active.plan_id = 'annual')
    where settings.court_discount_enabled and p_duration >= settings.court_discount_min_hours;

  -- Leave at least one centavo of court rental payable.
  return least(coalesce(amount, 0), greatest(p_subtotal - 0.01, 0));
end;
$$;

revoke all on function public.save_membership_booking_discount(text, boolean, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.save_membership_booking_discount(text, boolean, integer, integer, integer) to authenticated;
notify pgrst, 'reload schema';

commit;

-- Migration: 202611170042_staff_notifications.sql
begin;

create table private.staff_notifications (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('booking_payment', 'booking_confirmed', 'booking_cancelled',
    'membership_payment', 'membership_activated', 'account_verified')),
  subject_id uuid not null,
  created_at timestamptz not null default clock_timestamp()
);
create unique index staff_notification_verified_account on private.staff_notifications (subject_id)
  where kind = 'account_verified';

create table private.staff_notification_reads (
  user_id uuid not null references auth.users(id) on delete cascade,
  notification_id bigint not null references private.staff_notifications(id) on delete cascade,
  primary key (user_id, notification_id)
);
alter table private.staff_notifications enable row level security;
alter table private.staff_notification_reads enable row level security;
revoke all on private.staff_notifications, private.staff_notification_reads from public, anon, authenticated;

create function private.notify_staff_booking() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  previous_status text;
  previous_reference text;
  event_kind text;
begin
  if tg_op = 'UPDATE' then
    previous_status := old.status;
    previous_reference := old.payment_reference;
  end if;
  if new.status = 'awaiting_verification' and new.payment_reference is not null then
    if previous_status is distinct from new.status or previous_reference is distinct from new.payment_reference then
      event_kind := 'booking_payment';
    end if;
  elsif new.status = 'confirmed' and previous_status is distinct from new.status then
    event_kind := 'booking_confirmed';
  elsif new.status = 'cancelled' and previous_status in ('confirmed', 'awaiting_verification') then
    event_kind := 'booking_cancelled';
  end if;
  if event_kind is not null then
    insert into private.staff_notifications(kind, subject_id) values (event_kind, new.id);
  end if;
  return new;
end;
$$;

create trigger notify_staff_booking after insert or update of status, payment_reference on public.bookings
  for each row execute function private.notify_staff_booking();

create function private.notify_staff_membership() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status in ('pending', 'approved') then
    if tg_op = 'INSERT' or new.status is distinct from old.status then
      insert into private.staff_notifications(kind, subject_id)
        values (case when new.status = 'pending' then 'membership_payment' else 'membership_activated' end, new.id);
    end if;
  end if;
  return new;
end;
$$;

create trigger notify_staff_membership after insert or update of status on public.membership_applications
  for each row execute function private.notify_staff_membership();

create function private.notify_staff_account() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.email_confirmed_at is not null and nullif(btrim(new.email), '') is not null then
    if tg_op = 'INSERT' or old.email_confirmed_at is null then
      insert into private.staff_notifications(kind, subject_id) values ('account_verified', new.id)
        on conflict (subject_id) where kind = 'account_verified' do nothing;
    end if;
  end if;
  return new;
end;
$$;

create trigger notify_staff_account after insert or update of email_confirmed_at on auth.users
  for each row execute function private.notify_staff_account();

create function public.staff_notification_feed(p_page integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  manager boolean := public.is_staff();
  today date := (now() at time zone 'Asia/Manila')::date;
begin
  perform private.pos_require_staff();
  if p_page is null or p_page < 1 then raise exception 'Notifications: Choose a valid page.'; end if;

  return (
    with visible as (
      select n.*, r.notification_id is not null as is_read
        from private.staff_notifications n left join private.staff_notification_reads r
          on r.notification_id = n.id and r.user_id = auth.uid()
        where manager or n.kind not in ('account_verified', 'membership_activated')
    ), recent as (
      select * from visible order by id desc limit 15 offset (p_page::bigint - 1) * 15
    ), page as (
      select n.id, n.kind, n.subject_id, n.created_at, n.is_read,
        b.reference as booking_reference, b.booking_date, b.start_hour, b.duration,
        case when b.booking_type = 'open_play' then 'Open play' else coalesce(c.name, 'Court ' || b.court_id) end as court_label,
        m.plan_name, m.status as membership_status, acc.email as account_email,
        coalesce(case n.kind
          when 'booking_payment' then b.status = 'awaiting_verification' and n.created_at >= coalesce(b.payment_submitted_at, n.created_at)
          when 'membership_payment' then m.status = 'pending'
          when 'booking_cancelled' then b.booking_date = today
          else false end, false) as priority
      from recent n
      left join public.bookings b on n.kind in ('booking_payment', 'booking_confirmed', 'booking_cancelled') and b.id = n.subject_id
      left join public.courts c on c.id = b.court_id
      left join public.membership_applications m on n.kind in ('membership_payment', 'membership_activated') and m.id = n.subject_id
      left join auth.users acc on manager and n.kind = 'account_verified' and acc.id = n.subject_id
    )
    select jsonb_build_object('unread_count', (select count(*) from visible where not is_read),
      'total_count', (select count(*) from visible),
      'rows', coalesce((select jsonb_agg(to_jsonb(page) order by priority desc, id desc) from page), '[]'::jsonb))
  );
end;
$$;

create function public.mark_staff_notifications_read(p_notification_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare
  manager boolean := public.is_staff();
begin
  perform private.pos_require_staff();
  insert into private.staff_notification_reads(user_id, notification_id)
    select auth.uid(), n.id from private.staff_notifications n
    where (p_notification_id is null or n.id = p_notification_id)
      and (manager or n.kind not in ('account_verified', 'membership_activated'))
  on conflict do nothing;
end;
$$;

-- A notification can open the relevant application even when it is outside the first review page.
create function public.list_membership_applications(p_reviewed boolean, p_page integer, p_application uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.pos_require_staff();
  if p_reviewed is null or p_page is null or p_page < 1 then raise exception 'Membership: Choose a valid review page.'; end if;
  return (
    with filtered as (
      select a.id, a.plan_name, a.price_cents, a.payment_reference, a.status, a.submitted_at, a.reviewed_at,
        a.review_note, a.starts_on, a.expires_on, a.gcash_name, a.gcash_number, a.payment_method, s.number as receipt_number,
        case when a.pos_sale_id is not null and public.club_role() = 'cashier'
          then left(u.email, 1) || '•••@' || left(split_part(u.email, '@', 2), 1) || '•••'
          else u.email end as email,
        nullif(left(btrim(u.raw_user_meta_data->>'full_name'), 100), '') as full_name
      from public.membership_applications a left join auth.users u on u.id = a.user_id
      left join public.pos_sales s on s.id = a.pos_sale_id
      where (p_application is null or a.id = p_application)
        and ((not p_reviewed and a.status = 'pending') or (p_reviewed and a.status in ('approved', 'rejected', 'refunded')))
    ), page as (
      select * from filtered order by coalesce(reviewed_at, submitted_at) desc, id desc
      limit 10 offset (p_page::bigint - 1) * 10
    )
    select jsonb_build_object('row_count', (select count(*) from filtered),
      'rows', coalesce((select jsonb_agg(to_jsonb(page) order by coalesce(reviewed_at, submitted_at) desc, id desc) from page), '[]'::jsonb))
  );
end;
$$;

create or replace function public.list_membership_applications(p_reviewed boolean, p_page integer)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select public.list_membership_applications(p_reviewed, p_page, null);
$$;

revoke all on function private.notify_staff_booking(), private.notify_staff_membership(), private.notify_staff_account(),
  public.staff_notification_feed(integer), public.mark_staff_notifications_read(bigint),
  public.list_membership_applications(boolean, integer, uuid) from public, anon, authenticated;
grant execute on function public.staff_notification_feed(integer), public.mark_staff_notifications_read(bigint),
  public.list_membership_applications(boolean, integer, uuid) to authenticated;
notify pgrst, 'reload schema';

commit;

-- Migration: 202611170043_public_counter_products.sql
begin;

create function public.list_counter_products()
returns table (name text, category text, price_cents integer, photo_version uuid)
language sql stable security definer set search_path = '' as $$
  select p.name, p.category, p.price_cents, p.photo_version
    from public.pos_products p
    where p.active and p.stock > 0
    order by (p.photo_version is not null) desc, p.created_at desc, p.id desc
    limit 12;
$$;

create function public.counter_product_photo(p_version uuid)
returns text language sql stable security definer set search_path = '' as $$
  select encode(photo.content, 'base64')
    from public.pos_products p
    join private.pos_product_photos photo on photo.product_id = p.id
    where p.photo_version = p_version and p.active and p.stock > 0;
$$;

revoke all on function public.list_counter_products(), public.counter_product_photo(uuid) from public, anon, authenticated;
grant execute on function public.list_counter_products(), public.counter_product_photo(uuid) to anon, authenticated;
notify pgrst, 'reload schema';

commit;

-- Migration: 202611180044_counter_pickup_orders.sql
begin;

create table private.counter_orders (
  id uuid primary key,
  customer_id uuid not null references auth.users(id) on delete cascade,
  product_id uuid not null references public.pos_products(id),
  customer_name text not null check (length(customer_name) between 2 and 100),
  product_name text not null,
  quantity integer not null check (quantity between 1 and 5),
  price_cents integer not null check (price_cents > 0),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  cancelled_at timestamptz,
  sale_id uuid unique references public.pos_sales(id),
  check (cancelled_at is null or sale_id is null)
);
alter table private.counter_orders enable row level security;
revoke all on private.counter_orders from public, anon, authenticated;
create index counter_order_product_holds on private.counter_orders (product_id, expires_at)
  where cancelled_at is null and sale_id is null;
create index counter_order_customer_recent on private.counter_orders (customer_id, created_at desc);

create function private.counter_held_units(p_product uuid) returns integer
language sql stable set search_path = '' as $$
  select coalesce(sum(quantity), 0)::integer from private.counter_orders
    where product_id = p_product and cancelled_at is null and sale_id is null and expires_at > statement_timestamp();
$$;

create function public.list_pickup_products(p_product uuid default null)
returns table (id uuid, name text, category text, price_cents integer, photo_version uuid, max_quantity integer)
language sql stable security definer set search_path = '' as $$
  select p.id, p.name, p.category, p.price_cents, p.photo_version,
    greatest(0, least(5, 100000000 / p.price_cents, p.stock - private.counter_held_units(p.id)))
  from public.pos_products p
  where p.active and ((p_product is not null and p.id = p_product) or
    (p_product is null and p.stock > 0 and p.stock > private.counter_held_units(p.id)))
  order by (p.photo_version is not null) desc, p.created_at desc, p.id desc
  limit 12;
$$;

create function public.place_counter_order(p_id uuid, p_product uuid, p_quantity integer, p_price integer, p_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  product public.pos_products%rowtype;
  existing private.counter_orders%rowtype;
  buyer text := btrim(p_name);
  submitted_at timestamptz;
begin
  if not exists (select 1 from auth.users where id = actor and email_confirmed_at is not null) then
    raise exception 'Pickup: Sign in with a verified account to place an order.';
  end if;
  if p_id is null or p_product is null or p_quantity is null or p_quantity not between 1 and 5
     or buyer is null or length(buyer) not between 2 and 100 then
    raise exception 'Pickup: Enter a pickup name and a valid quantity.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('counter-order-customer:' || actor::text, 0));
  select * into existing from private.counter_orders where id = p_id;
  if found then
    if existing.customer_id = actor and existing.product_id = p_product and existing.quantity = p_quantity
       and existing.price_cents = p_price and existing.customer_name = buyer then return existing.id; end if;
    raise exception 'Pickup: Reload the order page and try again.';
  end if;

  if (select count(*) from private.counter_orders where customer_id = actor and created_at > clock_timestamp() - interval '1 hour') >= 5 then
    raise exception 'Pickup: Too many pickup orders. Try again in an hour.';
  end if;
  if (select count(*) from private.counter_orders where customer_id = actor and expires_at > clock_timestamp()
        and cancelled_at is null and sale_id is null) >= 3 then
    raise exception 'Pickup: Pick up or cancel an existing order before placing another.';
  end if;

  select * into product from public.pos_products where id = p_product for update;
  if not found or not product.active or p_quantity > product.stock - private.counter_held_units(product.id) then
    raise exception 'Pickup: That quantity is no longer available. Reload for current stock.';
  end if;
  if p_price is distinct from product.price_cents then
    raise exception 'Pickup: The price changed. Reload for the current price.';
  end if;
  if product.price_cents::bigint * p_quantity > 100000000 then
    raise exception 'Pickup: Choose a smaller quantity.';
  end if;
  submitted_at := clock_timestamp();
  insert into private.counter_orders (id, customer_id, product_id, customer_name, product_name, quantity, price_cents, created_at, expires_at)
  values (p_id, actor, product.id, buyer, product.name, p_quantity, product.price_cents, submitted_at, submitted_at + interval '24 hours');
  return p_id;
end;
$$;

create function private.counter_order_summary(p_order private.counter_orders) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', p_order.id, 'product_id', p_order.product_id, 'product_name', p_order.product_name,
    'customer_name', p_order.customer_name, 'quantity', p_order.quantity, 'price_cents', p_order.price_cents,
    'expires_at', p_order.expires_at, 'status', case when p_order.sale_id is not null then 'collected'
      when p_order.cancelled_at is not null then 'cancelled' when p_order.expires_at <= statement_timestamp() then 'expired' else 'pending' end);
$$;

create function public.get_counter_order(p_order uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select private.counter_order_summary(o) from private.counter_orders o where o.id = p_order and o.customer_id = auth.uid();
$$;

create function public.list_my_counter_orders() returns setof jsonb
language sql stable security definer set search_path = '' as $$
  select private.counter_order_summary(o) from private.counter_orders o where o.customer_id = auth.uid()
  order by (o.sale_id is null and o.cancelled_at is null and o.expires_at > statement_timestamp()) desc, o.created_at desc, o.id desc limit 10;
$$;

create function public.list_counter_orders(p_page integer, p_history boolean) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.pos_require_staff();
  if p_page is null or p_page < 1 or p_history is null then raise exception 'Pickup: Choose a valid page.'; end if;
  return (with matches as (
    select o from private.counter_orders o
    where p_history = (o.cancelled_at is not null or o.sale_id is not null or o.expires_at <= statement_timestamp())
  ), page as (
    select o from matches order by (o).created_at desc, (o).id desc limit 10 offset (p_page::bigint - 1) * 10
  ) select jsonb_build_object('count', (select count(*) from matches),
    'rows', coalesce(jsonb_agg(private.counter_order_summary(o) order by (o).created_at desc, (o).id desc), '[]'::jsonb)) from page);
end;
$$;

create function public.cancel_counter_order(p_order uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare o private.counter_orders%rowtype;
begin
  if auth.uid() is null then raise exception 'Pickup: Sign in to continue.'; end if;
  select * into o from private.counter_orders where id = p_order for update;
  if not found or (o.customer_id <> auth.uid() and public.is_club_staff() is not true) then raise exception 'Pickup: Order not found.'; end if;
  if o.cancelled_at is not null then return; end if;
  if o.sale_id is not null or o.expires_at <= clock_timestamp() then raise exception 'Pickup: This order is no longer awaiting pickup.'; end if;
  update private.counter_orders set cancelled_at = clock_timestamp() where id = p_order;
end;
$$;

create function private.guard_counter_stock() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.stock < old.stock and new.stock < private.counter_held_units(old.id) then
    raise exception 'POS: Some units are reserved for pickup orders. Check Pickup orders before selling or removing this stock.';
  end if;
  return new;
end;
$$;
create trigger guard_counter_stock before update of stock on public.pos_products
  for each row execute function private.guard_counter_stock();

create function public.complete_counter_order(p_order uuid, p_method text, p_reference text, p_tendered integer, p_verified boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  o private.counter_orders%rowtype;
  receipt jsonb;
begin
  perform private.pos_require_staff();
  select * into o from private.counter_orders where id = p_order for update;
  if not found then raise exception 'Pickup: Order not found.'; end if;
  if o.sale_id is not null then return private.pos_receipt(o.sale_id); end if;
  if o.cancelled_at is not null or o.expires_at <= clock_timestamp() then
    raise exception 'Pickup: This order is no longer awaiting pickup.';
  end if;

  -- Temporarily exclude this order from its own stock guard. Roll back the hold if checkout fails.
  update private.counter_orders set cancelled_at = clock_timestamp() where id = o.id;
  receipt := public.pos_checkout(jsonb_build_object('key', o.id, 'customer_name', o.customer_name,
    'method', p_method, 'reference', coalesce(p_reference, ''), 'tendered_cents', p_tendered, 'verified', p_verified,
    'items', jsonb_build_array(jsonb_build_object('product_id', o.product_id, 'quantity', o.quantity, 'price_cents', o.price_cents))));
  update private.counter_orders set sale_id = o.id, cancelled_at = null where id = o.id;
  return receipt;
end;
$$;

revoke all on function private.counter_held_units(uuid), private.counter_order_summary(private.counter_orders), private.guard_counter_stock(),
  public.list_pickup_products(uuid), public.place_counter_order(uuid, uuid, integer, integer, text), public.get_counter_order(uuid), public.list_my_counter_orders(),
  public.list_counter_orders(integer, boolean), public.cancel_counter_order(uuid), public.complete_counter_order(uuid, text, text, integer, boolean)
from public, anon, authenticated;
grant execute on function public.list_pickup_products(uuid) to anon, authenticated;
grant execute on function public.place_counter_order(uuid, uuid, integer, integer, text), public.get_counter_order(uuid), public.list_my_counter_orders(),
  public.list_counter_orders(integer, boolean), public.cancel_counter_order(uuid), public.complete_counter_order(uuid, text, text, integer, boolean)
to authenticated;
notify pgrst, 'reload schema';

commit;

-- Migration: 202611180045_walk_in_membership_discounts.sql
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

-- Migration: 202611180046_open_play_membership_discounts.sql
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

-- Migration: 202611180047_account_first_walk_ins.sql
begin;

create function private.walk_in_account_name(p_metadata jsonb) returns text
language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(p_metadata->'full_name') = 'string' then
    nullif(left(btrim(regexp_replace(p_metadata->>'full_name', '[[:space:]]+', ' ', 'g')), 100), '')
  end;
$$;

create function public.pos_find_walk_in_customers(p_query text, p_date date, p_active_only boolean default true)
returns table (id uuid, full_name text, email text, active_membership boolean)
language plpgsql stable security definer set search_path = '' as $$
declare
  search text := lower(btrim(p_query));
  today date := (now() at time zone 'Asia/Manila')::date;
begin
  perform private.pos_require_staff();
  if search is null or length(search) not between 2 and 254 then
    raise exception 'Booking: Enter at least two characters of a name or the full email address.';
  end if;
  if p_date is null or p_date not between today and today + 30 or p_active_only is null then
    raise exception 'Booking: Choose a valid date and customer filter.';
  end if;

  return query
    select u.id, profile.full_name,
      case when lower(u.email) = search then u.email::text
        else left(u.email, 1) || '•••@' || left(split_part(u.email, '@', 2), 1) || '•••'
      end,
      coalesce(member.active, false)
    from auth.users u
    cross join lateral (
      select private.walk_in_account_name(u.raw_user_meta_data) as full_name
    ) profile
    left join lateral (
      select true as active from public.membership_applications a
      where a.user_id = u.id and a.status = 'approved'
        and a.starts_on <= today and a.starts_on <= p_date and p_date < a.expires_on
      limit 1
    ) member on true
    where u.email_confirmed_at is not null and nullif(btrim(u.email), '') is not null
      and (lower(u.email) = search or strpos(lower(profile.full_name), search) > 0)
      and (not p_active_only or member.active)
    order by (lower(u.email) = search) desc, member.active desc nulls last, u.email, u.id
    limit 10;
end;
$$;

-- Reuse the reservation checks while allowing the account checkout to leave
-- a missing phone blank. Existing reservation entry points still require it.
do $$
declare
  schedule_definition text := pg_get_functiondef(
    'public.reserve_scheduled_booking_internal(text,date,text,text,integer,integer,integer,integer,boolean,boolean,boolean,text,text,text)'::regprocedure);
  equipment_definition text := pg_get_functiondef(
    'public.reserve_equipment_booking(text,date,text,text,integer,integer,integer,integer,boolean,boolean,boolean,text,text,text,integer)'::regprocedure);
  phone_check text := $fragment$(p_phone is null or p_phone !~ '^(\+63|0)9[0-9]{9}$')$fragment$;
  schedule_call text := 'public.reserve_scheduled_booking_internal(';
  equipment_call text := 'public.reserve_equipment_booking(';
begin
  if strpos(schedule_definition, phone_check) = 0 or strpos(schedule_definition, schedule_call) = 0
    or strpos(equipment_definition, equipment_call) = 0 or strpos(equipment_definition, schedule_call) = 0 then
    raise exception 'Expected reservation contact checks were not found.';
  end if;

  schedule_definition := replace(schedule_definition, schedule_call,
    'private.reserve_scheduled_booking(p_allow_missing_phone boolean, ');
  schedule_definition := replace(schedule_definition, phone_check,
    $fragment$((p_phone is null and not (p_allow_missing_phone and p_walk_in)) or p_phone !~ '^(\+63|0)9[0-9]{9}$')$fragment$);
  execute schedule_definition;

  equipment_definition := replace(equipment_definition, equipment_call,
    'private.reserve_equipment_booking(p_allow_missing_phone boolean, ');
  equipment_definition := replace(equipment_definition, schedule_call,
    'private.reserve_scheduled_booking(p_allow_missing_phone, ');
  execute equipment_definition;
end;
$$;

create or replace function public.reserve_scheduled_booking_internal(
  p_kind text, p_date date, p_name text, p_phone text,
  p_court integer default null, p_start integer default null, p_duration integer default 1, p_people integer default 1,
  p_rental boolean default false, p_walk_in boolean default false, p_blocked boolean default false,
  p_method text default 'cash', p_notes text default '', p_payment_option text default 'full'
) returns uuid language sql security definer set search_path = '' as $$
  select private.reserve_scheduled_booking(false, p_kind, p_date, p_name, p_phone, p_court, p_start,
    p_duration, p_people, p_rental, p_walk_in, p_blocked, p_method, p_notes, p_payment_option);
$$;

create or replace function public.reserve_equipment_booking(
  p_kind text, p_date date, p_name text, p_phone text,
  p_court integer default null, p_start integer default null, p_duration integer default 1, p_people integer default 1,
  p_rental boolean default false, p_walk_in boolean default false, p_blocked boolean default false,
  p_method text default 'cash', p_notes text default '', p_payment_option text default 'full', p_quantity integer default null
) returns uuid language sql security definer set search_path = '' as $$
  select private.reserve_equipment_booking(false, p_kind, p_date, p_name, p_phone, p_court, p_start,
    p_duration, p_people, p_rental, p_walk_in, p_blocked, p_method, p_notes, p_payment_option, p_quantity);
$$;

-- Resolve profile details after the idempotency check so a profile edit
-- cannot prevent a retry from returning its previously recorded booking.
do $$
declare
  definition text := pg_get_functiondef(
    'private.book_member_walk_in(uuid,uuid,date,text,text,integer,integer,integer,text,integer,integer,text,text,text,boolean,bigint,bigint,text)'::regprocedure);
  reserve_call text := 'booking_id := public.reserve_equipment_booking(p_kind, p_date, p_name, p_phone, p_court, p_start,';
begin
  if strpos(definition, reserve_call) = 0 or strpos(definition, 'request_fields jsonb;') = 0 then
    raise exception 'Expected linked member reservation was not found.';
  end if;

  definition := replace(definition, 'request_fields jsonb;',
    'request_fields jsonb; use_account_contact boolean := p_name is null and p_phone is null;');
  definition := replace(definition, reserve_call, $fragment$
  if use_account_contact then
    select case when length(profile.full_name) >= 2 then profile.full_name else
      case when length(profile.email_name) >= 2 then profile.email_name else 'Account holder' end end,
      case when u.phone_confirmed_at is not null then
        case when u.phone ~ '^(\+63|0)9[0-9]{9}$' then u.phone
          when u.phone ~ '^639[0-9]{9}$' then '+' || u.phone end
      end
    into p_name, p_phone
    from auth.users u
    cross join lateral (
      select private.walk_in_account_name(u.raw_user_meta_data) as full_name,
        left(split_part(btrim(u.email), '@', 1), 100) as email_name
    ) profile
    where u.id = p_customer;
  end if;
  booking_id := private.reserve_equipment_booking(use_account_contact, p_kind, p_date, p_name, p_phone, p_court, p_start,$fragment$);
  execute definition;
end;
$$;

create function public.pos_book_account_walk_in(
  p_key uuid, p_customer uuid, p_kind text, p_date date, p_court integer, p_start integer, p_duration integer,
  p_people integer, p_quantity integer, p_payment_option text, p_method text, p_reference text,
  p_verified boolean, p_collected_cents bigint, p_expected_total_cents bigint, p_notes text
) returns uuid language sql security definer set search_path = '' as $$
  select private.book_member_walk_in(p_key, p_customer, p_date, null, null, p_court, p_start, p_duration, p_kind,
    p_people, p_quantity, p_payment_option, p_method, p_reference, p_verified, p_collected_cents, p_expected_total_cents, p_notes);
$$;

revoke all on function private.walk_in_account_name(jsonb),
  private.reserve_scheduled_booking(boolean,text,date,text,text,integer,integer,integer,integer,boolean,boolean,boolean,text,text,text),
  private.reserve_equipment_booking(boolean,text,date,text,text,integer,integer,integer,integer,boolean,boolean,boolean,text,text,text,integer),
  public.pos_find_walk_in_customers(text,date,boolean),
  public.pos_book_account_walk_in(uuid,uuid,text,date,integer,integer,integer,integer,integer,text,text,text,boolean,bigint,bigint,text)
from public, anon, authenticated;
grant execute on function public.pos_find_walk_in_customers(text,date,boolean),
  public.pos_book_account_walk_in(uuid,uuid,text,date,integer,integer,integer,integer,integer,text,text,text,boolean,bigint,bigint,text)
to authenticated;
notify pgrst, 'reload schema';

commit;

-- Migration: 202611190048_save_membership_discounts_together.sql
begin;

-- Save both rules in one transaction using the existing permissions and
-- revision checks. A rejected rule rolls back any change to the other.
create function public.save_membership_discounts(
  p_plan text,
  p_court_enabled boolean, p_court_amount_cents integer, p_court_min_hours integer, p_court_revision integer,
  p_open_play_enabled boolean, p_open_play_amount_cents integer, p_open_play_floor_cents integer, p_open_play_revision integer
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  court_revision integer;
  open_play_revision integer;
begin
  court_revision := public.save_membership_booking_discount(
    p_plan, p_court_enabled, p_court_amount_cents, p_court_min_hours, p_court_revision);
  open_play_revision := public.save_membership_open_play_discount(
    p_plan, p_open_play_enabled, p_open_play_amount_cents, p_open_play_floor_cents, p_open_play_revision);
  return jsonb_build_object('courtRevision', court_revision, 'openPlayRevision', open_play_revision);
end;
$$;

revoke all on function public.save_membership_discounts(text, boolean, integer, integer, integer, boolean, integer, integer, integer)
from public, anon, authenticated;
grant execute on function public.save_membership_discounts(text, boolean, integer, integer, integer, boolean, integer, integer, integer)
to authenticated;
notify pgrst, 'reload schema';

commit;
