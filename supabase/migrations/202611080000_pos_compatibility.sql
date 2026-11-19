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
