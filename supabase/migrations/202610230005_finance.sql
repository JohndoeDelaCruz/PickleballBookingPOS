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
