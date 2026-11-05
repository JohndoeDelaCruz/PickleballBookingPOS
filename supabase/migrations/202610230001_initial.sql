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
