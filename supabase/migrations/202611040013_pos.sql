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
