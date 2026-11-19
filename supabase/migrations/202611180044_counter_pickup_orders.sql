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
