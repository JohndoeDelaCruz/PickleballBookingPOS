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
