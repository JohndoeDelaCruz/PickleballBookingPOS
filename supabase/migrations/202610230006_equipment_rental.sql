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
